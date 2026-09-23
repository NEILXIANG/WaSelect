/**
 * 职责：配置 schema 的 L0 单测（F3）。
 * 覆盖：默认值 / 空串语义 / 必填缺失 / 范围越界 / 通道未登记 / 脱敏。
 *
 * @why 配置层是"启动即失败"的护栏，它自己错了整套防线就失效；
 *      所以这里刻意测**会不会拒绝**，而不只是测能不能解析成功。
 * @see docs/地基搭建清单.md F3；.env.example
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactConfig, SECRET_KEYS } from './config.js';

/** 最小可启动环境：必填项齐备（PAYMENT_CHANNELS 刻意必填，见 config.ts @tradeoff）。 */
const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://app@localhost:5432/japan_shop',
  JWT_SECRET: 'a'.repeat(32),
  PAYMENT_CHANNELS: 'mock,stripe',
  TERMS_VERSION: 'TOS-2026-09-20',
};

/** 复制一份环境并删掉某个键——模拟"这个变量没配"。 */
function without(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy[key];
  return copy;
}

/** 断言 loadConfig 一定抛 ConfigError，并返回 issues 便于进一步断言。 */
function expectReject(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error('期望 loadConfig 抛出 ConfigError，但解析通过了');
}

/**
 * @why Vitest 启动时会把 `NODE_ENV` 设成 `test`。配置层若不认这个值，
 *      测试里一调 `loadConfig(process.env)` 就失败（D17）——
 *      而"测试与生产共用同一条装配路径"（A1）之后，这是必然撞上的第一类问题。
 */
describe('NODE_ENV（D17）', () => {
  it('接受 test：Vitest 自动设的值不能让配置校验失败', () => {
    const c = loadConfig({ ...baseEnv, NODE_ENV: 'test' });
    expect(c.NODE_ENV).toBe('test');
  });

  it('三个非生产值都合法', () => {
    for (const env of ['development', 'staging', 'test']) {
      expect(loadConfig({ ...baseEnv, NODE_ENV: env }).NODE_ENV).toBe(env);
    }
  });

  it('production 同样是已登记值（用一套合法生产配置验证，避免被跨字段规则误判）', () => {
    // ⚠️ production 有独立的跨字段规则（不许连 localhost、必须声明 CORS_ORIGINS、
    //    启用 stripe 必须有密钥），所以这里必须给一套**完整合法**的生产配置，
    //    否则失败的是别的规则，测不到"production 是否被认得"这一件事。
    const prod = {
      ...baseEnv,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u@db.internal.example:5432/waselect',
      CORS_ORIGINS: 'https://admin.example.com',
      PAYMENT_CHANNELS: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    };
    expect(loadConfig(prod).NODE_ENV).toBe('production');
  });

  it('拼错的值一律拒绝，不能静默回落到 development', () => {
    expect(expectReject({ ...baseEnv, NODE_ENV: 'prod' }).join('\n')).toContain('NODE_ENV');
  });
});

describe('loadConfig 正常路径', () => {
  it('最小环境即可启动，其余取默认值', () => {
    const c = loadConfig(baseEnv);
    expect(c.NODE_ENV).toBe('development');
    expect(c.PORT).toBe(3000);
    expect(c.PRICING_ANCHOR).toBe('JPY');
    expect(c.MAX_ORDER_JPY).toBe(180000);
    expect(c.PACKAGING_WEIGHT_G).toBe(250);
    expect(c.ORDER_PAYMENT_TTL_MIN).toBe(30);
    expect(c.SCHEDULER_TICK_MS).toBe(60000);
    expect(c.FX_BUFFER_RATE).toBeCloseTo(0.03, 10);
  });

  it('逗号分隔的通道被解析成数组，顺序保留', () => {
    const c = loadConfig({ ...baseEnv, PAYMENT_CHANNELS: 'stripe, wechat' });
    expect(c.PAYMENT_CHANNELS).toEqual(['stripe', 'wechat']);
  });

  it('数字型环境变量从字符串正确转换（不会变成字符串拼接）', () => {
    const c = loadConfig({ ...baseEnv, PORT: '8080', MAX_ORDER_JPY: '120000' });
    expect(c.PORT).toBe(8080);
    expect(c.MAX_ORDER_JPY).toBe(120000);
    expect(c.PORT + 1).toBe(8081);
  });
});

describe('空串 = 未设置（.env.example 的 KEY= 是占位）', () => {
  it('APP_ID 留空解析为 undefined，不是空字符串', () => {
    const c = loadConfig({ ...baseEnv, APP_ID: '' });
    expect(c.APP_ID).toBeUndefined();
  });

  it('FREE_SHIPPING_JPY 留空为 undefined——若当成 0 会变成"全场包邮"', () => {
    expect(loadConfig({ ...baseEnv, FREE_SHIPPING_JPY: '' }).FREE_SHIPPING_JPY).toBeUndefined();
    expect(loadConfig({ ...baseEnv, FREE_SHIPPING_JPY: '10000' }).FREE_SHIPPING_JPY).toBe(10000);
  });

  it('ADMIN_OPENIDS 留空为空数组', () => {
    expect(loadConfig({ ...baseEnv, ADMIN_OPENIDS: '' }).ADMIN_OPENIDS).toEqual([]);
    expect(loadConfig({ ...baseEnv, ADMIN_OPENIDS: 'o1,o2' }).ADMIN_OPENIDS).toEqual(['o1', 'o2']);
  });
});

describe('loadConfig 拒绝路径（启动即失败，不静默降级）', () => {
  it('缺 DATABASE_URL 拒绝启动', () => {
    expect(expectReject(without(baseEnv, 'DATABASE_URL')).join('\n')).toContain('DATABASE_URL');
  });

  it('JWT_SECRET 短于 32 字符拒绝启动', () => {
    expect(expectReject({ ...baseEnv, JWT_SECRET: 'short' }).join('\n')).toContain('JWT_SECRET');
  });

  it('PAYMENT_CHANNELS 缺失拒绝启动——默认成 mock 会让生产静默跑假支付', () => {
    expect(expectReject(without(baseEnv, 'PAYMENT_CHANNELS')).join('\n')).toContain(
      'PAYMENT_CHANNELS',
    );
  });

  it('PAYMENT_CHANNELS 出现未登记通道拒绝启动（新增支付方式必须先改 shared 枚举）', () => {
    expect(expectReject({ ...baseEnv, PAYMENT_CHANNELS: 'mock,alipay' }).join('\n')).toContain(
      'PAYMENT_CHANNELS',
    );
  });

  it('TERMS_VERSION 缺失拒绝启动（否则全站下单 40011）', () => {
    expect(expectReject(without(baseEnv, 'TERMS_VERSION')).join('\n')).toContain('TERMS_VERSION');
  });

  it('数字型变量写成非数字拒绝启动，不静默变 0 或 NaN', () => {
    expect(expectReject({ ...baseEnv, SCHEDULER_TICK_MS: 'abc' }).join('\n')).toContain(
      'SCHEDULER_TICK_MS',
    );
    expect(expectReject({ ...baseEnv, MAX_ORDER_JPY: '12.5' }).join('\n')).toContain(
      'MAX_ORDER_JPY',
    );
  });

  it('FX_BUFFER_RATE 越界（>0.5）拒绝启动，防量纲写错', () => {
    expect(expectReject({ ...baseEnv, FX_BUFFER_RATE: '30' }).join('\n')).toContain(
      'FX_BUFFER_RATE',
    );
  });

  it('展示币种出现未登记币种拒绝启动', () => {
    expect(expectReject({ ...baseEnv, DISPLAY_CURRENCIES: 'CNY,EUR' }).join('\n')).toContain(
      'DISPLAY_CURRENCIES',
    );
  });

  it('一次列出全部问题，而不是发现第一条就停', () => {
    const issues = expectReject({ JWT_SECRET: 'x' });
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('redactConfig 脱敏', () => {
  it('登记在册的密钥一律替换为 ***', () => {
    const redacted = redactConfig({
      ...loadConfig(baseEnv),
      STRIPE_SECRET_KEY: 'sk_test_51H8xxx',
      R2_SECRET_ACCESS_KEY: 'secret',
    });
    expect(redacted.STRIPE_SECRET_KEY).toBe('***');
    expect(redacted.R2_SECRET_ACCESS_KEY).toBe('***');
    expect(redacted.DATABASE_URL).toBe('***');
  });

  it('不修改原对象（日志脱敏不能把运行中的配置也抹掉）', () => {
    const cfg = { ...loadConfig(baseEnv), STRIPE_SECRET_KEY: 'sk_live_1' } as Record<
      string,
      unknown
    >;
    redactConfig(cfg);
    expect(cfg.STRIPE_SECRET_KEY).toBe('sk_live_1');
  });

  it('密钥名单本身不为空——新增密钥类变量必须同步维护', () => {
    expect(SECRET_KEYS.length).toBeGreaterThan(5);
    expect(SECRET_KEYS).toContain('JWT_SECRET');
  });
});

/**
 * 跨字段校验（P1）。
 * @why 逐字段校验回答不了"这套配置放在一起能不能收钱"：下面每一条里**没有一个字段是非法值**，
 *      但每一种组合都是线上事故，且都不会报错——只会表现为"下单失败"或"钱没到账"。
 */
describe('跨字段校验：单项合法但组合成事故', () => {
  const prod = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...baseEnv,
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app@db.internal:5432/japan_shop',
    PAYMENT_CHANNELS: 'stripe',
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    CORS_ORIGINS: 'https://admin.example.com',
    ...extra,
  });

  it('生产 + mock 通道 → 拒绝（会收真钱走假支付）', () => {
    const issues = expectReject(prod({ PAYMENT_CHANNELS: 'mock,stripe' }));
    expect(issues.join('\n')).toContain('PAYMENT_CHANNELS');
  });

  it('生产 + mock + 审核模式 → 放行（审核期是唯一合法场景）', () => {
    const c = loadConfig(
      prod({ PAYMENT_CHANNELS: 'mock', REVIEW_MODE: 'on', REVIEW_SKU_ID: 'sku-1' }),
    );
    expect(c.REVIEW_MODE).toBe('on');
  });

  it('审核模式开了却没指定 SKU → 拒绝（否则审核期全站下不了单）', () => {
    const issues = expectReject(prod({ REVIEW_MODE: 'on' }));
    expect(issues.join('\n')).toContain('REVIEW_SKU_ID');
  });

  it('生产启用 stripe 却缺密钥 → 拒绝（缺密钥的表现是下单 500，不是启动报错）', () => {
    expect(expectReject(prod({ STRIPE_SECRET_KEY: '' })).join('\n')).toContain('STRIPE_SECRET_KEY');
    expect(expectReject(prod({ STRIPE_WEBHOOK_SECRET: '' })).join('\n')).toContain(
      'STRIPE_WEBHOOK_SECRET',
    );
  });

  it('生产启用 wechat 却缺机构配置 → 拒绝', () => {
    const issues = expectReject(prod({ PAYMENT_CHANNELS: 'wechat' }));
    expect(issues.join('\n')).toContain('WECHAT_INSTITUTION_MERCHANT_ID');
    expect(issues.join('\n')).toContain('WECHAT_INSTITUTION_API_KEY');
  });

  it('生产 DATABASE_URL 指向 localhost → 拒绝（漏配环境变量的典型症状）', () => {
    expect(
      expectReject(prod({ DATABASE_URL: 'postgresql://app@localhost:5432/japan_shop' })).join('\n'),
    ).toContain('DATABASE_URL');
  });

  it('生产未声明 CORS_ORIGINS → 拒绝（管理端所有跨域请求都会被拒）', () => {
    expect(expectReject(prod({ CORS_ORIGINS: '' })).join('\n')).toContain('CORS_ORIGINS');
  });

  it('开发环境不受生产规则约束（占位期还没签约，不能一上来就启动不了）', () => {
    expect(loadConfig(baseEnv).PAYMENT_CHANNELS).toEqual(['mock', 'stripe']);
  });
});

/** 数值下限：挡住"值合法但量纲荒谬"的配置（曾经全部能正常启动）。 */
describe('数值型配置的下限', () => {
  const bad: ReadonlyArray<[string, string]> = [
    ['SCHEDULER_TICK_MS', '0'], // 每 0ms 一次 tick，打满 CPU
    ['ORDER_PAYMENT_TTL_MIN', '0'], // 订单刚建就过期
    ['RATE_LIMIT_LOGIN_PER_15MIN', '0'], // 等于全站禁登录
    ['RATE_LIMIT_QUOTE_PER_MIN', '0'],
    ['MAX_ORDER_JPY', '0'],
    ['AUTO_DELIVER_DAYS', '0'],
    ['PORT', '0'],
  ];
  for (const [key, value] of bad) {
    it(`${key}=${value} 拒绝启动`, () => {
      expect(expectReject({ ...baseEnv, [key]: value }).join('\n')).toContain(key);
    });
  }

  it('SCHEDULER_TICK_MS 低于 1000ms 也拒绝（常驻调度器的最小 sane 间隔）', () => {
    expect(expectReject({ ...baseEnv, SCHEDULER_TICK_MS: '999' }).join('\n')).toContain(
      'SCHEDULER_TICK_MS',
    );
  });
});
