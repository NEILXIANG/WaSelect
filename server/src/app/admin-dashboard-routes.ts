/**
 * 职责：管理端工作台接口（AJ-393；管理后台对标分析第一批③）。
 *   GET /api/v1/admin/dashboard/sales    今日 + 近 7 日的销售统计（円为主）与当日生效 USD 汇率（辅显用）
 *   GET /api/v1/admin/dashboard/funnel   转化漏斗：近 1 / 7 / 30 天六步人数（第 25 项，AJ-438；口径见 adapters/funnel.ts）
 *
 * @why 端点名是 **sales** 而不是 `overview` / `dashboard`：响应里只有销售统计与汇率，
 *      没有"待办计数"——后者由管理端复用现有列表接口的 `total` 拿到
 *      （`admin-web/src/orders/TodoBar.tsx` 已经在这么做）。
 *      **刻意不在这里重算一遍待办**：同一个数字有两条口径时，
 *      漂移的表现是"侧栏写着 3、点进去列表有 5 条"，而两边各自都自洽——
 *      这类不一致没有任何一处会报错。名字只承诺它真的给了什么。
 *
 * @why 只返回**汇率**而不直接返回"折算好的 USD 金额"：
 *      ① §8-2 定的是"円为主、USD 灰字辅显、标 ≈"——"≈"是展示层的语义，
 *         后端算好就变成"后端说这个单值这么多美元"，而它其实是一次有舍入的换算；
 *      ② 换算入口 `toMinor(toRateInt(rate), jpy)` 是 shared 的唯一一处（B43 那一类教训），
 *         前端用它而不是让服务端再造一份乘法；
 *      ③ 汇率换了、页面没刷新时，前端拿到的仍是"数字 + 汇率"这一对，可以自己决定要不要重算。
 *
 * @limitation 一：`fx` 在**没有已生效 USD 汇率时整键省略**（与契约 0.6.33 的 urls / seller 同口径：
 *              没配就不编占位值）。前端据此不显示 `≈ USD` 那一行——
 *              "汇率没配"与"汇率是 0"是两件完全不同的事，编一个 0 会把前者伪装成后者。
 * @limitation 二：这里是**只读**聚合，不写审计、不发事件。`/api/v1/admin` 前缀下的 GET
 *              不进审计（与 `admin-ops-log-routes.ts` 同口径：避免自我膨胀）。
 *
 * @see adapters/dashboard.ts（口径的唯一出处，含完整边界表）；
 *      adapters/ops-config.ts（`findLatestFxRate`：唯一"当前生效汇率"判定）；
 *      contracts/api-contract.yaml（AdminSalesOverview）
 */
import type { Express } from 'express';
import type { Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { Clock } from '../ports/clock.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import {
  loadSalesWindow,
  type MoneyByCurrency,
  type SalesWindowStats,
} from '../adapters/dashboard.js';
import { createOpsConfigRepo } from '../adapters/ops-config.js';
import { jstDayWindow, type JstDayWindow } from '@waselect/shared';
import { FUNNEL_STEPS, loadFunnel } from '../adapters/funnel.js';
import { AppError } from '../errors.js';

/** "近 7 天"含当日，共 7 个自然日（与工作台卡片上的文案必须一致）。 */
const LAST7_DAYS = 7;

export interface AdminDashboardRoutesDeps {
  db: Db;
  auth: AuthConfig;
  identity: IdentityCheck;
  /** 窗口右端与"当前生效汇率"都取注入时钟（F10）；不注入这条路由无法在假时间下测。 */
  clock: Clock;
}

/**
 * 客单价（円，四舍五入）。
 *
 * @returns `null` 当窗口内没有收款订单——**不是 0**。
 * @why "0 单、客单价 0 円"是一句看起来完全合理、实则无从判断的话：
 *      它既可以是"真的没单"，也可以是"除错了"。而运营看到的是后者时
 *      会以为今天一分钱没卖出去。空值让 UI 直接显示「—」。
 */
export function avgJpy(salesJpy: number, paidOrders: number): number | null {
  if (paidOrders <= 0) return null;
  return Math.round(salesJpy / paidOrders);
}

function moneyView(rows: readonly MoneyByCurrency[]): Record<string, unknown>[] {
  return rows.map((m) => ({ currency: m.currency, amount: m.amount }));
}

function windowView(w: JstDayWindow, s: SalesWindowStats): Record<string, unknown> {
  return {
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    orders: s.orders,
    paid_orders: s.paidOrders,
    sales_jpy: s.salesJpy,
    avg_jpy: avgJpy(s.salesJpy, s.paidOrders),
    received: moneyView(s.received),
    refunded: moneyView(s.refunded),
    disputed: moneyView(s.disputed),
  };
}

/**
 * 漏斗窗口天数（第 25 项）：只收 1 / 7 / 30（与工作台"今日 / 近 7 天"、订单页"近 30 天"同一组档位）。
 * @why 白名单而不是任意天数：任意天数会让一次请求扫全表（365 天、10000 天），且档位对不上别处的数字。
 */
const FUNNEL_DAYS = [1, 7, 30] as const;

function parseFunnelDays(raw: unknown): number | null {
  if (raw === undefined) return 7;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return (FUNNEL_DAYS as readonly number[]).includes(n) ? n : null;
}

export function mountAdminDashboardRoutes(app: Express, deps: AdminDashboardRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const opsConfig = createOpsConfigRepo(deps.db);

  app.get('/api/v1/admin/dashboard/sales', guard, (_req, res, next) => {
    void (async () => {
      try {
        // 一次取钟、两个窗口共用：分两次取的话，"今日"与"近 7 天"可能落在 JST 日界两侧
        // （23:59:59.999 取一次、次日 00:00:00.001 再取一次）——那样今日 ⊆ 近 7 天就不再恒成立。
        const now = deps.clock.now();
        const todayWin = jstDayWindow(now, 1);
        const last7Win = jstDayWindow(now, LAST7_DAYS);
        const [today, last7, usd] = await Promise.all([
          loadSalesWindow(deps.db, todayWin),
          loadSalesWindow(deps.db, last7Win),
          opsConfig.findLatestFxRate('USD', now),
        ]);
        res.json({
          generated_at: now.toISOString(),
          today: windowView(todayWin, today),
          last7: windowView(last7Win, last7),
          // @limitation 一：没有已生效汇率 → 整键省略（不编 0，不编 null）
          ...(usd === null
            ? {}
            : {
                fx: {
                  usd_rate: usd.rate,
                  usd_effective_from: usd.effective_from.toISOString(),
                },
              }),
        });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/admin/dashboard/funnel', guard, (req, res, next) => {
    void (async () => {
      try {
        const days = parseFunnelDays(req.query['days']);
        if (days === null) throw new AppError(40001, { field: 'days', reason: 'days_invalid' });
        const now = deps.clock.now();
        const win = jstDayWindow(now, days);
        const counts = await loadFunnel(deps.db, win);
        res.json({
          generated_at: now.toISOString(),
          days,
          from: win.from.toISOString(),
          to: win.to.toISOString(),
          steps: FUNNEL_STEPS.map((key) => ({ key, visitors: counts[key] })),
        });
      } catch (e) {
        next(e);
      }
    })();
  });
}
