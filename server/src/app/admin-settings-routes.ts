/**
 * 职责：`GET /api/v1/admin/settings`——当前生效的**非密钥**配置，只读（AJ-404；对标分析 §4.8）。
 *
 * @why 视图组装在 `settings-view.ts`（白名单 + 密钥门禁单测）；本文件只做"取数 + 守卫 + 日志"：
 *      支付通道的生效属性来自**装配产物**（mount.ts 传入，与 `/pay/channels` 用的是同一份），
 *      关税率按请求读 `duty_rates`（报价也是按请求读，所以这里显示的就是下一单会用的）。
 * @why 记一条 `admin_settings_viewed`（无参数）：设置页含特商法商家信息等，"谁看过"留个痕迹，成本是一行日志。
 * @limitation 只读。改 env 要去部署平台改并重启；运费 / 汇率去运营配置页；关税率目前没有后台入口（改库）。
 * @see app/settings-view.ts；adapters/payment/channels.ts（ChannelSummary）；contracts/api-contract.yaml 0.6.47
 */
import type { Express } from 'express';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { Clock } from '../ports/clock.js';
import type { AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { requireRole } from './auth.js';
import { buildSettingsView, type ChannelSummary, type DutyRateRow } from './settings-view.js';

export interface AdminSettingsRoutesDeps {
  db: Db;
  logger: Logger;
  config: AppConfig;
  clock: Clock;
  auth: AuthConfig;
  identity: IdentityCheck;
  /** 装配期产出的通道生效属性（mount.ts，buildPaymentRegistry 的 `channels`）。 */
  channels: readonly ChannelSummary[];
}

async function loadDutyRates(db: Db): Promise<DutyRateRow[]> {
  const rows = await db`
    select origin_country, dest_country, rate::text as rate
      from duty_rates order by origin_country, dest_country
  `;
  return rows.map((r) => ({
    origin: String(r['origin_country']).trim(),
    dest: String(r['dest_country']).trim(),
    rate: String(r['rate']),
  }));
}

export function mountAdminSettingsRoutes(app: Express, deps: AdminSettingsRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });

  app.get('/api/v1/admin/settings', guard, (_req, res, next) => {
    void (async () => {
      try {
        const dutyRates = await loadDutyRates(deps.db);
        // 审核商品查一下名称与状态（两端逐页走查 2026-10-12：设置页原先只有编号）
        const skuId = deps.config.REVIEW_SKU_ID;
        const reviewSku =
          skuId === undefined
            ? undefined
            : ((
                await deps.db<{ title: string; status: string; stock: number }[]>`
                  select title, status, stock from products where id = ${skuId}`
              )[0] ?? null);
        const view = buildSettingsView({
          config: deps.config,
          channels: deps.channels,
          dutyRates,
          reviewSku,
        });
        deps.logger.info('admin_settings_viewed', { result: 'ok' });
        res.json({ generated_at: deps.clock.now().toISOString(), ...view });
      } catch (e) {
        next(e);
      }
    })();
  });
}
