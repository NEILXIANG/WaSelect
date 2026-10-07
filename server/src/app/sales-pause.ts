/**
 * 职责：**全局停售开关**（AJ-384；工程缺口第二轮 §6.3 G10）——读写 `app_config['sales.paused']`、
 * 拦截"新的钱"三个入口（报价 / 建单 / 发起支付）的中间件、管理端开关路由。
 *
 * @why 事故止血只能一步到位：价格录错时，原先只能逐个下架或改 env 重启（重启期间还有窗口）。
 *      存在库里、每次请求读一次：开关**立即生效、不用重启**，多实例下也一致（单行读，代价可忽略）。
 * @why 只拦三个入口，不拦回调 / 退款 / 发货 / 查询：停售是"不再收新的钱"，已经在路上的钱必须照常落账、照常能退；
 *      拦了回调就是"钱收了、单没落账"。发起支付也拦：停售的典型原因是价格录错，照错价建好的单不能在停售期间被付款。
 * @why 中间件挂在**鉴权之前**：停售对所有人都是同一个答案，不需要先验身份；也让"暂停中"在登录态失效时同样说得清。
 * @why 这是 `app_config` 的**第一个**消费方（010 迁移 @why：第一个 key 必须连同消费方一起落地）。
 * @limitation 读库失败时**放行**（fail-open）并记 error：开关是止血工具，库都读不了时后面的报价 / 建单本来也会失败；
 *             反过来 fail-closed 会让一次读超时变成全站停售。
 * @limitation 小程序首页不预先提示"暂停中"，买家在点报价 / 下单时才看到 40916 的文案。
 *
 * @see migrations/010_config_tables.sql（app_config）；packages/shared/src/errors.ts（40916）
 */
import type { Express, RequestHandler } from 'express';
import type { Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { releaseReasonGuard } from '../domain/admin-order-actions.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { setAuditBefore } from './admin-audit.js';
import { requireRole, type AuthConfig } from './auth.js';

const KEY = 'sales.paused';

export interface SalesPauseState {
  paused: boolean;
  reason?: string;
  actor?: string;
  updated_at?: string;
}

export async function readSalesPause(db: Db): Promise<SalesPauseState> {
  const [row] = await db`select value, updated_at from app_config where key = ${KEY}`;
  if (row === undefined) return { paused: false };
  const v = (row['value'] ?? {}) as Record<string, unknown>;
  return {
    paused: v['paused'] === true,
    ...(typeof v['reason'] === 'string' ? { reason: v['reason'] } : {}),
    ...(typeof v['actor'] === 'string' ? { actor: v['actor'] } : {}),
    updated_at: (row['updated_at'] as Date).toISOString(),
  };
}

/**
 * 三个入口前的守卫：停售中 → 40916；读库失败 → 放行并记 error（@limitation 一）。
 * @why single-flight（P2-24，AJ-386）：同一时刻在途的请求共用**一次**读库；洪峰下 DB 读数与并发数脱钩。
 *      不做 TTL 缓存：缓存会让"停售"晚生效几秒，而停售是止血开关，要的就是立即。
 */
export function salesOpenGuard(db: Db, logger: Logger): RequestHandler {
  let inflight: Promise<SalesPauseState> | undefined;
  const read = (): Promise<SalesPauseState> => {
    inflight ??= readSalesPause(db).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
  return (_req, _res, next) => {
    void read().then(
      (s) => next(s.paused ? new AppError(40916, { reason: 'sales_paused' }) : undefined),
      (e: unknown) => {
        logger.error('sales_pause_read_failed', { result: 'failed', err: e });
        next();
      },
    );
  };
}

export interface SalesPauseRoutesDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  identity: IdentityCheck;
}

export function mountSalesPauseRoutes(app: Express, deps: SalesPauseRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });

  app.get('/api/v1/admin/ops/sales-pause', guard, (_req, res, next) => {
    void (async () => {
      const s = await readSalesPause(deps.db);
      // 带上操作人邮箱（三端联动模拟 2026-10-08）：状态行原先只显示 `admin:adm-d2b4…`，看不出是谁停的。
      // 只在管理端 GET 查，不进守卫热路径；查不到（账号已删）就只给原始 actor。
      const id = s.actor?.startsWith('admin:') === true ? s.actor.slice('admin:'.length) : '';
      const [u] = id === '' ? [] : await deps.db`select email from users where id = ${id}`;
      const email = u?.['email'];
      res.json({ ...s, ...(typeof email === 'string' ? { actor_email: email } : {}) });
    })().catch(next);
  });

  app.put('/api/v1/admin/ops/sales-pause', guard, (req, res, next) => {
    void (async () => {
      try {
        const body = (req.body ?? {}) as { paused?: unknown; reason?: unknown };
        if (typeof body.paused !== 'boolean')
          throw new AppError(40001, { reason: 'paused_must_be_boolean' });
        const reason = releaseReasonGuard(body.reason);
        if (!reason.ok) throw new AppError(reason.code, { reason: reason.reason });
        const before = await readSalesPause(deps.db);
        setAuditBefore(res, before);
        const actor = `admin:${req.auth?.sub ?? 'unknown'}`;
        const value = { paused: body.paused, reason: reason.reason, actor };
        await deps.db`
          insert into app_config (key, value, updated_at) values (${KEY}, ${deps.db.json(value)}, now())
          on conflict (key) do update set value = excluded.value, updated_at = now()
        `;
        // warn 而不是 info：开 / 关停售是会被人回头查的运营动作，要能从日志里一眼找到
        deps.logger.warn(body.paused ? 'sales_paused' : 'sales_resumed', {
          result: 'ok',
          ctx: { reason: reason.reason },
        });
        res.json(await readSalesPause(deps.db));
      } catch (e) {
        next(e);
      }
    })();
  });
}
