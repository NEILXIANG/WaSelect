/**
 * 职责：管理端运营配置端点（I2 U-C3）——`GET/POST /admin/fx`、`GET/PUT /admin/shipping-rates`。
 *
 * @why 四条路由共用**一个** `requireRole` 守卫实例（与商品/订单管理端同口径）：
 *      守卫抄四遍，"将来要不要加一条审计"就得改四处，漏一处就是
 *      "某条管理端接口没守卫"——而这种漏法不会报错，只会静默地裸露。
 *
 * @why 两条写路由的响应**不带 body**（契约只写了 201 / 200，没有 content）：
 *      ADR-28 的同一条纪律——没有消费方的字段是死数据。前端 `ops/api.ts` 明写
 *      "响应不读，保存后重新 GET 一次"，凭空返回 `{count}` 或整表，
 *      造出来的是一个没人兑现的承诺（契约里也没有）。
 *      ⚠️ 前端 client 对 `content-length: 0` 有专门分支（`api/client.ts` 的 `noContent`），
 *      所以空体不会被当成网络失败。
 *
 * @why 两张表的每次改动都把**改前的值**记进日志（流 A）：
 *      运费整表替换是**不可逆**的（`delete` 之后旧档就没有了），
 *      一次误操作后运营一定会问"之前是多少"——答不上来就是真实的数据丢失。
 *      `admin_audit` 由挂在 /api/v1/admin 前缀上的审计中间件统一写（F-02 / AJ-183，app/admin-audit.ts）；
 *      本文件只负责用 `setAuditBefore` 交出改前值——整表替换与汇率追加是两类"之前是多少"必须答得上的操作。
 *      （早先"刻意不写"的理由——不要在路由里造第一份实现——正是端口落地后四处一起接的由来。）
 *
 * @limitation 一：**汇率"突变"仍只记日志不拦截，"量纲"已由 domain 层硬拦**（AJ-297）。
 *              · 量纲（"这个数根本不可能是这个币种的汇率"）由 `domain/fx-input.ts` 拦，
 *                区间是 per-quote 的历史极值 + 宽裕系数 ⇒ 错一位（10 倍）必然越界，
 *                **且不需要确认出口**（错误值根本上不了库，也就不存在"改正被拦"）。
 *              · 突变（"区间之内、但相对上一条跳得离谱"）仍打 warn（`fx_rate_jump`，
 *                阈值 `FX_JUMP_RATIO`，2026-10-02 从 10 降到 3——10 在新区间下不可达）：
 *                它需要一个"可接受的日波动区间"的运营参数，没拍板；自己拍阈值硬拦，
 *                会在真实波动那天**拒掉正确的维护**（AJ-148 ④）。这两层是互补的：
 *                量纲拦"不可能是这个币种的数"，突变记"是这个币种的数但跳得太狠"。
 * @limitation 二：`POST /admin/fx` **不是"改"而是"追加一行"**（契约只有 POST，没有 PUT /admin/fx）。
 *              所以"改今天的汇率"= 追加一条新的生效时间。`UNIQUE(quote, effective_from)`
 *              撞上就是 40910，提示换时间——这是契约的形状决定的，不是本实现的疏漏。
 * @limitation 三：运费的"数量级写错"**只拦得住极端的一档**（AJ-297）。
 *              ✅ `domain/shipping-rates-input.ts` 有绝对量纲上界（30kg / 10万円），
 *                挡"多打两个 0"（2000 → 200000）。
 *              ❌ 挡不住"多打一个 0"（2000 → 20000）——20kg / 2万円的档位本身合法，
 *                而精确检测只能靠"与上一版逐档比较"，那在整表替换的正常重构下假阳性很高，
 *                且必须配确认出口才不会把"改正上次录错的值"自己拦住。完整取舍见 AJ-297。
 *              ✅ 本层已把替换前后**整表逐档**写进 `admin_shipping_rates_replaced`，
 *                "之前是多少"随时可答，剩余风险由页面二次确认 + 对账承担。
 * @limitation 四：`GET /admin/fx` 为每行下发 `is_current`（ADM3-05），由**服务端时钟**判定。
 *              @why 前端曾经拿 `Date.now()` 与 `effective_from` 比（"不晚于此刻的最新一行"），
 *              而"立即生效"的时刻是服务端 `clock.now()` 打的——管理员电脑慢 10 分钟，
 *              刚保存的那行在前端被当成"尚未生效"而排除，量级核对的基准回退到上一条
 *              （先录错、马上改正的场景里，第二次核对拿的是**错误值之前**的那条）；
 *              电脑快几小时则相反，几小时后才生效的预约行被当成当前值。
 *              "现在几点"只有一个权威，就是服务端；下发布尔而不是下发 `now`，
 *              是为了让前端**没有第二份"哪一行是当前"的判定**（第二份必然漂移）。
 *              判定复用 `repo.findLatestFxRate`（POST 侧算"上一条"用的就是它），不在本文件重写出一条。
 *
 * @see adapters/ops-config.ts（仓储）；domain/fx-input.ts、domain/shipping-rates-input.ts（校验）；
 *      contracts/api-contract.yaml（FxRate / ShippingRate）；admin-web/src/ops/（消费方）
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import { setAuditBefore, setAuditTarget } from './admin-audit.js';
import {
  createOpsConfigRepo,
  ShippingTableStaleError,
  ShippingTableTooLightError,
  type FxRateRow,
  type OpsConfigRepo,
  type ShippingRateRow,
} from '../adapters/ops-config.js';
import { applyFxBuffer, parseFxInput } from '../domain/fx-input.js';
import { parseShippingRates } from '../domain/shipping-rates-input.js';

/**
 * 突变告警倍数（@limitation 一：只记不拦）。
 *
 * @why **2026-10-02 从 10 降到 3**：`FX_RAW_RATE_BOUNDS`（AJ-297）落地之后，
 *      区间内**可能的最大倍数**就是 `max/min` = 0.02/0.002 = **10**（CNY 是 8.5），
 *      也就是说"10 倍"只在该区间的两个端点之间才成立——日常维护**永远碰不到**，
 *      这条 warn 变成了一个不可达分支（不报错、不告警，只是再也不会触发）。
 *      取 3：仍在"真实单次维护不可能发生"的范围里，但落在一个能被触发的档位上。
 * @why 取 3 而不是沿用前端的 1.5：前端 `fxPreview` 的 1.5 是**要人勾确认**的闸门，
 *      这里是**记账**用的 warn——两层阈值刻意不同，否则同一次维护会在两个地方
 *      同时报警，而"两处都报"等于两处都不用看。
 * @limitation 它**只能**是 warn 不能是拦截：上一次的值可能本身就是错的（在区间内），
 *      此时"改正"的倍数必然越阈值——把 warn 升级成拦截，等于把修正动作自己拦住。
 */
const FX_JUMP_RATIO = 3;

export interface AdminOpsRoutesDeps {
  db: Db;
  logger: Logger;
  config: AppConfig;
  auth: AuthConfig;
  identity: IdentityCheck;
  clock: Clock;
}

/**
 * 一行的身份键（`quote` + `effective_from` 毫秒）。
 * @why 键里**必须带 quote**：两个币种完全可能在同一毫秒被补录（"立即生效"取的就是服务端此刻，
 *      批量补录时两行同一毫秒并不罕见），只按毫秒记会把另一币种的**历史**行也标成当前生效
 *      （ADM3-05）。`UNIQUE(quote, effective_from)` 也说明"行"的身份本来就是这两项的复合。
 */
function fxRowKey(quote: string, at: Date): string {
  return `${quote}|${String(at.getTime())}`;
}

/**
 * 仓储行 → 契约 `FxRate`（NUMERIC 已是 number；时间统一 ISO 字符串）。
 * @why 当前行另带 `stale_at` / `stale`（规律排查 2026-10-12）：生效满 `FX_MAX_AGE_HOURS` 的汇率，
 *      报价与下单当它缺失（quote-assembly → findFreshFxRates，整店 50003），运营页原先照样标"当前生效"。
 *      判据与 findFreshFxRates 同口径：`effective_from <= now − maxAge` 即过期。
 */
function toFxRate(
  r: FxRateRow,
  isCurrent: boolean,
  now: Date,
  maxAgeHours: number,
): Record<string, unknown> {
  // eslint-disable-next-line no-restricted-syntax -- 生效时刻 + 配置时长换算成 ISO，不是读取当前时间（F10 的本意）
  const staleAt = new Date(r.effective_from.getTime() + maxAgeHours * 3_600_000);
  return {
    quote: r.quote,
    rate: r.rate,
    raw_rate: r.raw_rate,
    buffer: r.buffer,
    effective_from: r.effective_from.toISOString(),
    is_current: isCurrent,
    ...(isCurrent
      ? { stale_at: staleAt.toISOString(), stale: staleAt.getTime() <= now.getTime() }
      : {}),
  };
}

/**
 * 哪些行"当前已生效"（`quote|ms` 的集合）。
 * @why **复用** `findLatestFxRate`。在 SQL 里再写一遍 `effective_from <= now` 的最值
 *      （窗口函数 / `distinct on`）会造出第二份"当前生效"的判定，而 POST 侧算突变倍数、
 *      审计的改前值用的都是 `findLatestFxRate`——两份口径迟早漂移（ADR-29）。
 *      币种是契约枚举（CNY / USD），多一次查询换"口径唯一"划算。
 */
async function currentFxKeys(
  repo: OpsConfigRepo,
  quotes: readonly string[],
  now: Date,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const q of quotes) {
    const latest = await repo.findLatestFxRate(q, now);
    if (latest !== null) keys.add(fxRowKey(latest.quote, latest.effective_from));
  }
  return keys;
}

/** 仓储行 → 契约 `ShippingRate`。 */
function toShippingRate(r: ShippingRateRow): Record<string, unknown> {
  return {
    carrier: r.carrier,
    max_weight_g: r.max_weight_g,
    price_jpy: r.price_jpy,
    active: r.active,
  };
}

/** 23505 → 40910（同币种同生效时间重复维护）；其余原样抛出走 50000 兜底。 */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === '23505';
}

export function mountAdminOpsRoutes(app: Express, deps: AdminOpsRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const repo = createOpsConfigRepo(deps.db);

  app.get('/api/v1/admin/fx', guard, (_req, res, next) => {
    void (async () => {
      try {
        // 全部行（含历史与未来）：过滤掉未来行会让"刚提交的未来汇率"在列表里消失，
        // 运营会以为没保存成功。排序保证每个币种最新一行在最上面（AJ-150 ①）
        const rows = await repo.listFxRates();
        const now = deps.clock.now(); // @limitation 四：判"当前生效"用服务端时钟
        const current = await currentFxKeys(repo, [...new Set(rows.map((r) => r.quote))], now);
        res.json(
          rows.map((r) =>
            toFxRate(
              r,
              current.has(fxRowKey(r.quote, r.effective_from)),
              now,
              deps.config.FX_MAX_AGE_HOURS,
            ),
          ),
        );
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/fx', guard, (req, res, next) => {
    void (async () => {
      try {
        const input = parseFxInput(req.body);
        const rate = applyFxBuffer(input.rawRate, deps.config.FX_BUFFER_RATE);
        const actor = `admin:${req.auth?.sub ?? 'unknown'}`;

        // 改前值进日志（@why）：这一次维护之后，"上一次是多少"仍然可查
        const now = deps.clock.now();
        const prev = await repo.findLatestFxRate(input.quote, now);
        setAuditBefore(res, prev); // 审计流 B 的改前值（AJ-183）：汇率只追加不改，"上一条"就是改前值
        // 追加汇率也没有路径 `:id`：审计的 target 记**哪个货币对**被调过（SEC-12 / AJ-344）——
        // 建的是一行汇率，但"汇率被改"这件事的对象是货币对，按它检索才有意义。
        setAuditTarget(res, input.quote);
        const effectiveFromMs = input.effectiveFromMs ?? now.getTime();
        try {
          await repo.insertFxRate({
            quote: input.quote,
            rate,
            rawRate: input.rawRate,
            buffer: deps.config.FX_BUFFER_RATE,
            effectiveFromMs,
            createdBy: actor,
          });
        } catch (e) {
          if (isUniqueViolation(e)) {
            throw new AppError(40910, { quote: input.quote, effective_from_ms: effectiveFromMs });
          }
          throw e;
        }

        if (prev !== null) {
          const ratio = rate / prev.rate;
          if (ratio >= FX_JUMP_RATIO || ratio <= 1 / FX_JUMP_RATIO) {
            deps.logger.warn('fx_rate_jump', {
              result: 'ok',
              ctx: { quote: input.quote, prev_rate: prev.rate, new_rate: rate, ratio },
            });
          }
        }
        deps.logger.info('admin_fx_set', {
          result: 'ok',
          ctx: {
            quote: input.quote,
            raw_rate: input.rawRate,
            rate,
            buffer: deps.config.FX_BUFFER_RATE,
            effective_from_ms: effectiveFromMs,
            prev_rate: prev?.rate ?? null,
          },
        });
        res.status(201).end();
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/admin/shipping-rates', guard, (_req, res, next) => {
    void (async () => {
      try {
        res.json((await repo.listShippingRates()).map(toShippingRate));
      } catch (e) {
        next(e);
      }
    })();
  });

  /** 换表；会把在售商品挤出最高档 → 40918（P2-30），`data.product_id` 指出最重的那件。 */
  const replaceOrReject = async (
    rows: Parameters<typeof repo.replaceShippingRates>[0],
    expectedFingerprint: string | undefined,
  ): Promise<Awaited<ReturnType<typeof repo.replaceShippingRates>>> => {
    try {
      return await repo.replaceShippingRates(rows, {
        packagingWeightG: deps.config.PACKAGING_WEIGHT_G,
        expectedFingerprint,
      });
    } catch (e) {
      // ADM-4（AJ-458）：表已被别人改过 → 40914（与商品 / Banner 的乐观锁同码），表一行没动
      if (e instanceof ShippingTableStaleError) {
        deps.logger.warn('admin_shipping_rates_stale', {
          result: 'rejected',
          ctx: { expected: e.expected, current: e.current },
        });
        throw new AppError(40914, { expected: e.expected, current: e.current });
      }
      if (!(e instanceof ShippingTableTooLightError)) throw e;
      deps.logger.warn('admin_shipping_rates_rejected', {
        result: 'rejected',
        ctx: { product_id: e.productId, weight_g: e.weightG, max_tier_weight_g: e.maxTierWeightG },
      });
      throw new AppError(
        40918,
        { product_id: e.productId, weight_g: e.weightG, max_tier_weight_g: e.maxTierWeightG },
        { product_id: e.productId },
      );
    }
  };

  app.put('/api/v1/admin/shipping-rates', guard, (req, res, next) => {
    void (async () => {
      try {
        const rows = parseShippingRates(req.body);
        // `expected`（契约 0.6.67）：管理端读表时算的指纹；形状不对按"没带"（老调用方不受影响）
        const rawExpected = req.query['expected'];
        const expected =
          typeof rawExpected === 'string' && /^[0-9a-f]{8}$/.test(rawExpected)
            ? rawExpected
            : undefined;
        // 改前整表进日志：整表替换不可逆，没有 before 就再也答不出"之前是多少"。
        // 🔴 用**仓储在锁内读出的**那一份（AJ-354），不要在这里先读一次：
        //    锁外读的 before 在并发保存时是"最初那张表"，而本次真正覆盖掉的是
        //    "刚才别人提交的那张表"——审计会答错，且错得毫无症状。
        const { before, after } = await replaceOrReject(rows, expected);
        setAuditBefore(res, before.map(toShippingRate)); // 审计流 B 的改前值（AJ-183）：整表替换不可逆
        deps.logger.info('admin_shipping_rates_replaced', {
          result: 'ok',
          ctx: {
            before_count: before.length,
            after_count: after.length,
            before: before.map(toShippingRate),
            after: after.map(toShippingRate),
          },
        });
        res.status(200).end();
      } catch (e) {
        next(e);
      }
    })();
  });
}
