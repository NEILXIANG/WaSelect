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
 * @limitation 一：**汇率突变只记日志不拦截**。新 rate 与"当前生效的那条"相差 10 倍以上
 *              打一条 warn（`fx_rate_jump`）。不做拦截是因为"可接受的日波动区间"
 *              是一个没拍板的运营参数，而汇率真的会剧烈波动——自己拍一个阈值硬拦，
 *              会在真实波动那天**拒掉正确的维护**（AJ-148 ④）。
 * @limitation 二：`POST /admin/fx` **不是"改"而是"追加一行"**（契约只有 POST，没有 PUT /admin/fx）。
 *              所以"改今天的汇率"= 追加一条新的生效时间。`UNIQUE(quote, effective_from)`
 *              撞上就是 40910，提示换时间——这是契约的形状决定的，不是本实现的疏漏。
 * @limitation 三：运费的"数量级写错"（2000 打成 20000）**没有自动防护**，只进日志。
 *              与 fx 同一条理由（@limitation 一），登记为待办。
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
import { setAuditBefore } from './admin-audit.js';
import {
  createOpsConfigRepo,
  type FxRateRow,
  type OpsConfigRepo,
  type ShippingRateRow,
} from '../adapters/ops-config.js';
import { applyFxBuffer, parseFxInput } from '../domain/fx-input.js';
import { parseShippingRates } from '../domain/shipping-rates-input.js';

/** 突变告警倍数（@limitation 一：只记不拦）；10 倍足以抓住"多打/少打一个 0"。 */
const FX_JUMP_RATIO = 10;

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

/** 仓储行 → 契约 `FxRate`（NUMERIC 已是 number；时间统一 ISO 字符串）。 */
function toFxRate(r: FxRateRow, isCurrent: boolean): Record<string, unknown> {
  return {
    quote: r.quote,
    rate: r.rate,
    raw_rate: r.raw_rate,
    buffer: r.buffer,
    effective_from: r.effective_from.toISOString(),
    is_current: isCurrent,
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
        res.json(rows.map((r) => toFxRate(r, current.has(fxRowKey(r.quote, r.effective_from)))));
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

  app.put('/api/v1/admin/shipping-rates', guard, (req, res, next) => {
    void (async () => {
      try {
        const rows = parseShippingRates(req.body);
        // 改前整表进日志：整表替换不可逆，没有 before 就再也答不出"之前是多少"
        const before = await repo.listShippingRates();
        setAuditBefore(res, before.map(toShippingRate)); // 审计流 B 的改前值（AJ-183）：整表替换不可逆
        const after = await repo.replaceShippingRates(rows);
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
