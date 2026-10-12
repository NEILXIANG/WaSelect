/**
 * 职责：管理端「设置」只读视图的**密钥不外泄**门禁 + 白名单内容核对（AJ-404）。
 *
 * @why 泄密用例按**名字规则**从 `CONFIG_KEYS` 现取键（再并上 `SECRET_KEYS`），不手写清单：
 *      手写清单会在新增一个密钥类变量那天静默过时——而那正是最可能被人顺手加进设置页的一天。
 *      每个密钥都灌一个**带唯一标记**的值（`cnryNN`），断言标记不出现在序列化结果的任何位置：
 *      整值、主机名、用户名、片段都算泄露（DATABASE_URL / SENTRY_DSN 的每一段都带标记）。
 * @why 键名也查（大小写不敏感地比对所有对象键 + 整串里出现原名）：把 `STRIPE_SECRET_KEY: '***'`
 *      或 `env: 'SENTRY_DSN'` 放进响应虽然没泄值，却在告诉看页面的人"密钥叫什么、该去哪偷"。
 *
 * @limitation 只能证明"灌进去的这些值没出来"。白名单里某一项**本身**就是秘密（例如有人把一个
 *             新密钥起名叫 `FOO_CREDS` 再加进白名单）这类，名字规则抓不住——白名单的每一项仍要人审。
 */
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, ConfigError, SECRET_KEYS, loadConfig } from '../config.js';
import { buildSettingsView, type ChannelSummary, type SettingItem } from './settings-view.js';

/** 需求里写定的密钥名规则（AJ-404）。 */
const SECRET_NAME = /SECRET|KEY|TOKEN|PASSWORD|DSN|DATABASE_URL/;

const secretKeys = [
  ...new Set([...CONFIG_KEYS.filter((k) => SECRET_NAME.test(k)), ...SECRET_KEYS]),
].filter((k) => CONFIG_KEYS.includes(k));

/** 每个密钥一个可识别标记（值的每一段都带它，部分泄露也能查到）。 */
function canaryEnv(): { env: NodeJS.ProcessEnv; markers: Map<string, string> } {
  const env: NodeJS.ProcessEnv = {};
  const markers = new Map<string, string>();
  secretKeys.forEach((key, i) => {
    const m = `cnry${String(i).padStart(2, '0')}`;
    markers.set(key, m);
    if (key === 'DATABASE_URL') env[key] = `postgresql://${m}user:${m}pass@${m}host:5432/${m}db`;
    else if (key === 'SENTRY_DSN') env[key] = `https://${m}pub@${m}.ingest.sentry.io/4242`;
    // config 对这两把有形状校验（sk_test_ / whsec_ 前缀），不合形状会拒启
    else if (key === 'STRIPE_SECRET_KEY') env[key] = `sk_test_${m}${'v'.repeat(40)}`;
    else if (key === 'STRIPE_WEBHOOK_SECRET') env[key] = `whsec_${m}${'v'.repeat(40)}`;
    else env[key] = `${m}-${key.toLowerCase()}-${'v'.repeat(40)}`;
  });
  return { env, markers };
}

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  PAYMENT_CHANNELS: 'mock,stripe',
  TERMS_VERSION: 'TOS-2026-10-01',
  CHECKOUT_BASE_URL: 'https://pay.waselect.example',
  SELLER_NAME: '株式会社ワセレクト',
  SUPPORT_EMAIL: 'support@waselect.example',
  SUPPORT_HOURS: '平日 10:00-18:00 JST',
  MAIL_FROM: 'noreply@waselect.example',
  // 跨字段规则：APP_SECRET 要配对 APP_ID、ADMIN_INITIAL_PASSWORD 要配对 ADMIN_EMAIL（只为让配置能加载）
  APP_ID: 'wx0123456789abcdef',
  ADMIN_EMAIL: 'owner@waselect.example',
  PACKAGING_WEIGHT_G: '300',
  FX_BUFFER_RATE: '0.035',
  FX_MAX_AGE_HOURS: '48',
};

const CHANNELS: readonly ChannelSummary[] = [
  {
    channel: 'stripe',
    enabled: true,
    priority: 20,
    label: '银行卡',
    countries: ['*'],
    currencies: ['USD'],
    attrsSource: 'table',
  },
  {
    channel: 'mock',
    enabled: true,
    priority: 90,
    label: '模拟支付',
    countries: ['*'],
    currencies: ['JPY'],
    attrsSource: 'builtin',
  },
];

function build(extra: NodeJS.ProcessEnv = {}) {
  const { env, markers } = canaryEnv();
  const config = loadConfig({ ...BASE_ENV, ...env, ...extra });
  const view = buildSettingsView({
    config,
    channels: CHANNELS,
    dutyRates: [{ origin: 'JP', dest: 'US', rate: '0.15000' }],
  });
  return { view, markers, config };
}

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

function item(view: ReturnType<typeof build>['view'], group: string, key: string): SettingItem {
  const g = view.groups.find((x) => x.key === group);
  const it = g?.items.find((x) => x.key === key);
  if (it === undefined) throw new Error(`缺 ${group}.${key}`);
  return it;
}

describe('密钥不外泄（白名单制，AJ-404）', () => {
  it('名字规则至少挑出了已知的那几把钥匙（防"规则写错 → 空集 → 假绿"）', () => {
    for (const k of [
      'DATABASE_URL',
      'JWT_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'MAIL_PROVIDER_API_KEY',
      'SENTRY_DSN',
      'ADMIN_INITIAL_PASSWORD',
      'INTERNAL_JOB_SECRET',
    ]) {
      expect(secretKeys).toContain(k);
    }
  });

  it('每个密钥的值（含任一片段）都不出现在响应里；密钥名既不是键也不出现在值里', () => {
    const { view, markers, config } = build();
    // 前提自证：标记真的灌进了配置（否则下面的"没出现"是空对空）
    expect(config.JWT_SECRET).toContain(markers.get('JWT_SECRET'));
    expect(config.SENTRY_DSN).toContain(markers.get('SENTRY_DSN'));
    const json = JSON.stringify(view);
    const keysLower = allKeys(view).map((k) => k.toLowerCase());
    for (const [key, marker] of markers) {
      expect(json, `${key} 的值泄露`).not.toContain(marker);
      expect(json, `${key} 的名字出现在响应里`).not.toContain(key);
      expect(keysLower, `${key} 被用作响应键`).not.toContain(key.toLowerCase());
    }
  });

  it('通知类只给布尔：配了 → true，且不带 env 名', () => {
    const { view } = build();
    expect(item(view, 'notify', 'mail_configured')).toMatchObject({ value: true });
    expect(item(view, 'notify', 'sentry_configured')).toMatchObject({ value: true });
    expect(item(view, 'notify', 'mail_configured').env).toBeUndefined();
    expect(item(view, 'notify', 'sentry_configured').env).toBeUndefined();
  });

  it('通知类：没配 → false（ALERT_EMAIL 只给布尔，不回邮箱本身）', () => {
    const config = loadConfig({
      ...BASE_ENV,
      DATABASE_URL: 'postgresql://app@localhost:5432/x',
      JWT_SECRET: 'j'.repeat(32),
      MAIL_FROM: undefined,
      APP_ID: undefined,
      ADMIN_EMAIL: undefined,
    });
    const view = buildSettingsView({ config, channels: [], dutyRates: [] });
    expect(item(view, 'notify', 'mail_configured').value).toBe(false);
    expect(item(view, 'notify', 'sentry_configured').value).toBe(false);
    expect(item(view, 'notify', 'alert_email_configured').value).toBe(false);
    const withAlert = buildSettingsView({
      config: { ...config, ALERT_EMAIL: 'ops-alert@waselect.example' },
      channels: [],
      dutyRates: [],
    });
    expect(item(withAlert, 'notify', 'alert_email_configured').value).toBe(true);
    expect(JSON.stringify(withAlert)).not.toContain('ops-alert@waselect.example');
  });

  it('写坏的 DSN 进不了配置（config 规则 7 拒启）——所以 sentry_configured 只需判"配没配"', () => {
    expect(() => build({ SENTRY_DSN: 'not-a-dsn' })).toThrow(ConfigError);
  });
});

describe('白名单内容：当前生效值 + 改它要不要重启', () => {
  it('分组固定为 店铺 / 支付 / 运费 / 税费 / 通知 / 汇率 六组（顺序即展示顺序）', () => {
    const { view } = build();
    expect(view.groups.map((g) => g.key)).toEqual([
      'shop',
      'payment',
      'shipping',
      'tax',
      'notify',
      'fx',
    ]);
  });

  it('店铺信息：未配的项 value = null（不编占位值），env 项改了要重启', () => {
    const { view } = build();
    expect(item(view, 'shop', 'seller_name')).toEqual({
      key: 'seller_name',
      value: '株式会社ワセレクト',
      source: 'env',
      apply: 'restart',
      env: 'SELLER_NAME',
    });
    expect(item(view, 'shop', 'seller_address').value).toBeNull();
    expect(item(view, 'shop', 'terms_version').value).toBe('TOS-2026-10-01');
    expect(item(view, 'shop', 'support_email').value).toBe('support@waselect.example');
  });

  it('支付：开放清单来自 PAYMENT_CHANNELS；展示属性来自装配产物（含来源），审核模式关', () => {
    const { view } = build();
    expect(item(view, 'payment', 'payment_channels')).toEqual({
      key: 'payment_channels',
      value: [
        {
          channel: 'stripe',
          enabled: true,
          priority: 20,
          label: '银行卡',
          countries: ['*'],
          currencies: ['USD'],
          attrs_source: 'table',
        },
        {
          channel: 'mock',
          enabled: true,
          priority: 90,
          label: '模拟支付',
          countries: ['*'],
          currencies: ['JPY'],
          attrs_source: 'builtin',
        },
      ],
      source: 'env',
      apply: 'restart',
      env: 'PAYMENT_CHANNELS',
    });
    expect(item(view, 'payment', 'review_mode').value).toBe('off');
    expect(item(view, 'payment', 'review_mode_until').value).toBeNull();
    expect(item(view, 'payment', 'checkout_base_url').value).toBe('https://pay.waselect.example');
  });

  // 两端逐页走查 2026-10-12：设置页的"审核商品"只有一串编号，看不出是哪件、能不能下单（AJ-505 同一类风险）
  it('🔴 审核商品带 value_label：找到 → "「名称」· 状态 · 库存 N"；找不到 → 明说；没配 → 不带', () => {
    const config = loadConfig({ ...BASE_ENV, ...canaryEnv().env, REVIEW_SKU_ID: 'p-review' });
    const label = (reviewSku: { title: string; status: string; stock: number } | null) =>
      buildSettingsView({ config, channels: CHANNELS, dutyRates: [], reviewSku })
        .groups.flatMap((g) => g.items)
        .find((i) => i.key === 'review_sku_id')?.value_label;
    expect(label({ title: '六花亭 葡萄干奶油夹心饼干 5 枚', status: 'active', stock: 50 })).toBe(
      '「六花亭 葡萄干奶油夹心饼干 5 枚」· 在售 · 库存 50',
    );
    expect(label({ title: '六花亭', status: 'offline', stock: 0 })).toBe(
      '「六花亭」· 已下架 · 库存 0',
    );
    expect(label(null)).toBe('找不到这件商品（编号填错了？审核期将没有能下单的商品）');
    const { view } = build();
    expect(item(view, 'payment', 'review_sku_id')).not.toHaveProperty('value_label');
  });

  it('运费 / 税费 / 汇率：数值原样；库里的项标 db + 立即生效（运费与汇率指向运营配置页）', () => {
    const { view } = build();
    expect(item(view, 'shipping', 'packaging_weight_g').value).toBe(300);
    expect(item(view, 'shipping', 'shipping_rates')).toEqual({
      key: 'shipping_rates',
      value: null,
      source: 'db',
      apply: 'immediate',
      edit_page: 'ops',
    });
    expect(item(view, 'tax', 'duty_rates')).toEqual({
      key: 'duty_rates',
      value: [{ origin: 'JP', dest: 'US', rate: '0.15000' }],
      source: 'db',
      apply: 'immediate',
    });
    expect(item(view, 'fx', 'fx_buffer_rate').value).toBe(0.035);
    expect(item(view, 'fx', 'fx_max_age_hours').value).toBe(48);
    expect(item(view, 'fx', 'fx_rates')).toMatchObject({ source: 'db', edit_page: 'ops' });
  });

  it('每一项的 env 名都是真实配置键（写错名字 = 页面教运营去改一个不存在的变量）', () => {
    const { view } = build();
    const envs = view.groups.flatMap((g) => g.items.flatMap((i) => (i.env ? [i.env] : [])));
    expect(envs.length).toBeGreaterThan(10);
    for (const e of envs) expect(CONFIG_KEYS).toContain(e);
  });
});
