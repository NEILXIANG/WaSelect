/**
 * 职责：管理端「设置」页的只读视图（AJ-404；对标分析 §4.8）——把**当前生效**的非密钥配置
 *       按 店铺 / 支付 / 运费 / 税费 / 通知 / 汇率 分组，并标出每一项"改它要不要重启、改哪里"。
 *
 * @why **白名单制**：每一项都在下面逐条写出"取哪个字段、怎么呈现"，**不遍历** `AppConfig`。
 *      黑名单（遍历全部配置、剔除 `SECRET_KEYS`）的失效方式是静默的：新增一个密钥类变量时
 *      忘了登记进 `SECRET_KEYS`（config.ts 那份名单自己就写着"新增必须同步"），它就原样出现在后台页面上。
 *      白名单的失效方式是"页面上少一项"——看得见、无害。
 * @why 通知类（邮件 / Sentry / 告警邮箱）**只给布尔**、不带 env 名：
 *      DSN 与 API key 本身是密钥，连"变量叫什么"也不在页面上出现（`settings-view.unit` 按名字规则逐个断言）。
 *      告警邮箱是运营自己的地址，同样只回"配了没有"。
 * @why `source` / `apply` 两个维度分开：`env` 一定要重启；`db` 里有的立即生效（运费、汇率、关税率按请求读库），
 *      有的要重启（支付通道的展示属性只在装配期读一次，`payment-channel-config.ts` @limitation 二）——
 *      所以通道那一项标的是 `env` + `restart`：开关在 env，展示属性虽在库里但同样要重启才生效。
 * @limitation 一：是"本进程启动时 / 此刻读到的"值，不是"库里 / 环境里现在写着的"值——
 *              改了 env 还没重启时，页面显示的是旧值（这正是它要告诉运营的：还没生效）。
 * @limitation 二：特商法的商家信息（地址 / 电话 / 邮箱）在这里原样展示：它们本就经 `/legal` 对外公开，不是秘密。
 * @tradeoff 文案（每一项叫什么）不在服务端：服务端只给稳定的 `key`，标签在前端
 *           `admin-web/src/settings/view.ts`（约束五：文案不写死在业务代码里）。代价是新增一项要改两处。
 * @see app/admin-settings-routes.ts（唯一调用方）；adapters/payment/channels.ts（`ChannelSummary`）；
 *      docs/自主决策记录.md AJ-404
 */
import type { AppConfig } from '../config.js';
import type { ChannelSummary } from '../adapters/payment/channels.js';

export type { ChannelSummary } from '../adapters/payment/channels.js';

export interface DutyRateRow {
  origin: string;
  dest: string;
  /** NUMERIC 原样字符串（不转浮点：`0.15` 的二进制近似不是 0.15）。 */
  rate: string;
}

export type SettingValue =
  string | number | boolean | null | readonly string[] | ReadonlyArray<Record<string, unknown>>;

export interface SettingItem {
  key: string;
  value: SettingValue;
  /** 值从哪来：环境变量 / 数据库配置表。 */
  source: 'env' | 'db';
  /** 改了之后：要重启进程 / 下一个请求就生效。 */
  apply: 'restart' | 'immediate';
  /** 对应的环境变量名（只给**非密钥**项；运营据此知道改哪个变量）。 */
  env?: string;
  /** 后台哪一页能改（目前只有运营配置页）。 */
  edit_page?: 'ops';
  /** 给人看的说明（目前只有审核商品：名称 · 状态 · 库存；两端逐页走查 2026-10-12）。 */
  value_label?: string;
}

export interface SettingGroup {
  key: 'shop' | 'payment' | 'shipping' | 'tax' | 'notify' | 'fx';
  items: SettingItem[];
}

export interface SettingsInput {
  config: AppConfig;
  channels: readonly ChannelSummary[];
  dutyRates: readonly DutyRateRow[];
  /**
   * `REVIEW_SKU_ID` 指向的商品（路由查库后传入）；null = 查了但没有这件；undefined = 没查（没配 / 单测不关心）。
   */
  reviewSku?: { title: string; status: string; stock: number } | null | undefined;
}

const PRODUCT_STATUS_TEXT: Readonly<Record<string, string>> = {
  active: '在售',
  offline: '已下架',
  draft: '草稿',
};

/**
 * 审核商品的说明（两端逐页走查 2026-10-12：设置页原先只有编号，看不出是哪件、能不能下单——与 AJ-505 同一类风险）。
 */
function reviewSkuLabel(p: { title: string; status: string; stock: number } | null): string {
  if (p === null) return '找不到这件商品（编号填错了？审核期将没有能下单的商品）';
  return `「${p.title}」· ${PRODUCT_STATUS_TEXT[p.status] ?? p.status} · 库存 ${String(p.stock)}`;
}

/** 一条 env 项（值缺省 → null：未配就说未配，不编占位值）。 */
function env(key: string, name: keyof AppConfig, value: SettingValue | undefined): SettingItem {
  return { key, value: value ?? null, source: 'env', apply: 'restart', env: name };
}

/** 只回"配了没有"的布尔项（不带 env 名，@see 文件头）。 */
function flag(key: string, on: boolean): SettingItem {
  return { key, value: on, source: 'env', apply: 'restart' };
}

export function buildSettingsView(input: SettingsInput): { groups: SettingGroup[] } {
  const c = input.config;
  return {
    groups: [
      {
        key: 'shop',
        items: [
          env('seller_name', 'SELLER_NAME', c.SELLER_NAME),
          env('seller_representative', 'SELLER_REPRESENTATIVE', c.SELLER_REPRESENTATIVE),
          env('seller_address', 'SELLER_ADDRESS', c.SELLER_ADDRESS),
          env('seller_phone', 'SELLER_PHONE', c.SELLER_PHONE),
          env('seller_email', 'SELLER_EMAIL', c.SELLER_EMAIL),
          env('support_email', 'SUPPORT_EMAIL', c.SUPPORT_EMAIL),
          env('support_wechat', 'SUPPORT_WECHAT', c.SUPPORT_WECHAT),
          env('support_hours', 'SUPPORT_HOURS', c.SUPPORT_HOURS),
          env('terms_version', 'TERMS_VERSION', c.TERMS_VERSION),
          env('legal_base_url', 'LEGAL_BASE_URL', c.LEGAL_BASE_URL),
        ],
      },
      {
        key: 'payment',
        items: [
          env(
            'payment_channels',
            'PAYMENT_CHANNELS',
            input.channels.map((ch) => ({
              channel: ch.channel,
              enabled: ch.enabled,
              priority: ch.priority,
              label: ch.label,
              countries: [...ch.countries],
              currencies: [...ch.currencies],
              attrs_source: ch.attrsSource,
            })),
          ),
          env('checkout_base_url', 'CHECKOUT_BASE_URL', c.CHECKOUT_BASE_URL),
          env('review_mode', 'REVIEW_MODE', c.REVIEW_MODE),
          env('review_mode_until', 'REVIEW_MODE_UNTIL', c.REVIEW_MODE_UNTIL),
          {
            ...env('review_sku_id', 'REVIEW_SKU_ID', c.REVIEW_SKU_ID),
            ...(c.REVIEW_SKU_ID !== undefined && input.reviewSku !== undefined
              ? { value_label: reviewSkuLabel(input.reviewSku) }
              : {}),
          },
          env('max_order_jpy', 'MAX_ORDER_JPY', c.MAX_ORDER_JPY),
          env('order_payment_ttl_min', 'ORDER_PAYMENT_TTL_MIN', c.ORDER_PAYMENT_TTL_MIN),
        ],
      },
      {
        key: 'shipping',
        items: [
          {
            key: 'shipping_rates',
            value: null,
            source: 'db',
            apply: 'immediate',
            edit_page: 'ops',
          },
          env('packaging_weight_g', 'PACKAGING_WEIGHT_G', c.PACKAGING_WEIGHT_G),
          env('free_shipping_jpy', 'FREE_SHIPPING_JPY', c.FREE_SHIPPING_JPY),
          env(
            'ship_within_business_days',
            'SHIP_WITHIN_BUSINESS_DAYS',
            c.SHIP_WITHIN_BUSINESS_DAYS,
          ),
          env('auto_deliver_days', 'AUTO_DELIVER_DAYS', c.AUTO_DELIVER_DAYS),
          env('auto_complete_days', 'AUTO_COMPLETE_DAYS', c.AUTO_COMPLETE_DAYS),
        ],
      },
      {
        key: 'tax',
        items: [
          {
            key: 'duty_rates',
            value: input.dutyRates.map((d) => ({ origin: d.origin, dest: d.dest, rate: d.rate })),
            source: 'db',
            apply: 'immediate',
          },
        ],
      },
      {
        key: 'notify',
        items: [
          flag(
            'mail_configured',
            c.MAIL_PROVIDER_API_KEY !== undefined && c.MAIL_FROM !== undefined,
          ),
          flag('alert_email_configured', c.ALERT_EMAIL !== undefined),
          // 只判"配没配"：写坏的 DSN 在 config 规则 7 就拒启了（@measured settings-view.unit：
          // `SENTRY_DSN=not-a-dsn` → loadConfig 抛 ConfigError），能走到这里的 DSN 必然可解析
          flag('sentry_configured', c.SENTRY_DSN !== undefined),
        ],
      },
      {
        key: 'fx',
        items: [
          { key: 'fx_rates', value: null, source: 'db', apply: 'immediate', edit_page: 'ops' },
          env('fx_buffer_rate', 'FX_BUFFER_RATE', c.FX_BUFFER_RATE),
          env('fx_max_age_hours', 'FX_MAX_AGE_HOURS', c.FX_MAX_AGE_HOURS),
          env('display_currencies', 'DISPLAY_CURRENCIES', [...c.DISPLAY_CURRENCIES]),
        ],
      },
    ],
  };
}
