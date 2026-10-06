/**
 * 职责：配置 schema 的 L0 单测（F3）。
 * 覆盖：默认值 / 空串语义 / 必填缺失 / 范围越界 / 通道未登记 / 脱敏。
 *
 * @why 配置层是"启动即失败"的护栏，它自己错了整套防线就失效；
 *      所以这里刻意测**会不会拒绝**，而不只是测能不能解析成功。
 * @see docs/地基搭建清单.md F3；.env.example
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  mockAutoConfirmEnabled,
  redactConfig,
  SECRET_KEYS,
} from './config.js';

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
      // staging 启用 mock 必须显式密钥（P3-7：公网环境不许回落公开占位值），
      // 这里测的是"NODE_ENV 值是否被认得"，给它一把密钥以免碰到别的规则
      expect(
        loadConfig({
          ...baseEnv,
          NODE_ENV: env,
          MOCK_CALLBACK_SECRET: 'explicit-mock-callback-secret-32ch',
        }).NODE_ENV,
      ).toBe(env);
    }
  });

  it('production 同样是已登记值（用一套合法生产配置验证，避免被跨字段规则误判）', () => {
    // ⚠️ production 有独立的跨字段规则（不许连 localhost、必须声明 CORS_ORIGINS、
    //    启用 stripe 必须有密钥），所以这里必须给一套**完整合法**的生产配置，
    //    否则失败的是别的规则，测不到"production 是否被认得"这一件事。
    const prod = {
      ...baseEnv,
      NODE_ENV: 'production',
      APP_ID: 'wx-prod-like',
      APP_SECRET: 'prod-like-app-secret',
      DATABASE_URL: 'postgres://u@db.internal.example:5432/waselect',
      CORS_ORIGINS: 'https://admin.example.com',
      PAYMENT_CHANNELS: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
      CHECKOUT_BASE_URL: 'https://checkout.example.com',
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
    // AJ-240：每用户在途单上限，默认 3（order-routes.db.test.ts 的用例按这个默认值写）
    expect(c.MAX_OPEN_ORDERS_PER_USER).toBe(3);
    expect(c.ORDER_PAYMENT_TTL_MIN).toBe(30);
    expect(c.CALLBACK_ORDER_GRACE_MS).toBe(900_000);
    expect(c.SCHEDULER_TICK_MS).toBe(60000);
    expect(c.SHUTDOWN_READY_DELAY_MS).toBe(5_000);
    // B13 / AJ-202：8s = 出站总预算 6s + 2s 排队余量（等得比 6s 短 = 注定等不到订阅者里的机构调用）
    expect(c.SHUTDOWN_EVENT_DRAIN_MS).toBe(8_000);
    expect(c.FX_BUFFER_RATE).toBeCloseTo(0.03, 10);
    expect(c.SHIP_WITHIN_BUSINESS_DAYS).toBe(7); // FTC 发货时限承诺（D-39⑦ / AJ-180）
    // A2 / AJ-197：默认 0（宁小勿大）——取到的是直连对端 IP（错但**不可伪造**），
    // 而默认 1 在"前面其实有两层"时取到的是 Cloudflare 边缘那一跳，方向是"可伪造"。
    // ⚠️ 生产由 render.yaml 显式给值，不许依赖默认。
    expect(c.TRUST_PROXY_HOPS).toBe(0);
    expect(c.ORIGIN_VERIFY_SECRET).toBeUndefined(); // 源站闸门默认关闭（拓扑未实测）
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

  /**
   * DB-16（CAT-15）：`FX_BUFFER_RATE` 还要限**小数位数**。
   *
   * @why `fx_rates.buffer` 是 `NUMERIC(6,4)`，而 `rate` 是 JS 里用**未取整**的 buffer 算的。
   *      @measured(PostgreSQL 16.15)：`0.03125::numeric(6,4)` → `0.0313`。
   *      于是配 5 位小数时，库里同一行 `rate ≠ raw_rate × (1 + buffer)`——
   *      对账时是一笔说不清的账（分不清"四舍五入"还是"算错"）。
   *      它和上面那条是**两个不同的护栏**：那条挡量纲（30 当成 30%），这条挡精度。
   * @limitation 这里只验"启动被拒"，不验落库后的数值——后者是 `fx_rates` 的真库用例的事。
   */
  it('🔴 FX_BUFFER_RATE 超过 4 位小数拒绝启动（buffer 列是 NUMERIC(6,4)）', () => {
    for (const bad of ['0.03125', '0.00001', '0.12345']) {
      const msg = expectReject({ ...baseEnv, FX_BUFFER_RATE: bad }).join('\n');
      expect(msg, `${bad} 应被拒（第 5 位小数会让落库 buffer 与算 rate 用的值不一致）`).toContain(
        'FX_BUFFER_RATE',
      );
    }
  });

  /**
   * 容差必须**双向**钉住：只测"多一位小数被拒"的话，一个**把合法值也拒掉**的实现
   * （例如直接 `Number.isInteger(v * 10_000)`）同样能过——它会让 `FX_BUFFER_RATE=0.07`
   * 的机器**起不来**，而 0.07 是个再正常不过的值。
   *
   * ⚠️ 用例初版就是个假绿灯：我只放了 `0.03 / 0.0001 / 0.5 / 0 / 0.0312`，
   *    而 `0.03 * 1e4` 实测是**精确**的 300（我原以为会漂成 300.00000000000006）。
   *    全量扫过 0 → 0.5 步进 0.0001（5001 个合法值）才找到真正会漂的：
   *    `0.07 → 700.0000000000001`、`0.0003 → 2.9999999999999996`；严格判法误拒 **576** 个。
   *    下面这两个值就是那次扫描挑出来的代表性样本，不是随手写的。
   */
  it('FX_BUFFER_RATE 恰 4 位小数放行（含实测会漂的 0.07 / 0.0003）', () => {
    for (const ok of ['0.03', '0.0001', '0.5', '0', '0.0312', '0.07', '0.0003']) {
      expect(loadConfig({ ...baseEnv, FX_BUFFER_RATE: ok }).FX_BUFFER_RATE, `${ok} 应放行`).toBe(
        Number(ok),
      );
    }
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
    APP_ID: 'wx-prod-like',
    APP_SECRET: 'prod-like-app-secret',
    DATABASE_URL: 'postgresql://app@db.internal:5432/japan_shop',
    PAYMENT_CHANNELS: 'stripe',
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    CHECKOUT_BASE_URL: 'https://checkout.example.com',
    CORS_ORIGINS: 'https://admin.example.com',
    ...extra,
  });

  it('配了邮件密钥却没配 MAIL_FROM → 拒绝（每封信都会被服务商拒，且只在第一次发信时才暴露，2-2）', () => {
    expect(expectReject(prod({ MAIL_PROVIDER_API_KEY: 're_x' })).join('\n')).toContain('MAIL_FROM');
    expect(
      loadConfig(prod({ MAIL_PROVIDER_API_KEY: 're_x', MAIL_FROM: 'Waselect <shop@example.com>' }))
        .MAIL_FROM,
    ).toBe('Waselect <shop@example.com>');
  });

  it('SENTRY_DSN 形状不对 → 拒绝（解析失败 = 错误静默不上报，2-3）', () => {
    expect(expectReject(prod({ SENTRY_DSN: 'not-a-dsn' })).join('\n')).toContain('SENTRY_DSN');
    expect(
      loadConfig(prod({ SENTRY_DSN: 'https://abc123@o1.ingest.sentry.io/42' })).SENTRY_DSN,
    ).toBe('https://abc123@o1.ingest.sentry.io/42');
  });

  /**
   * 剩余清单 5-2（O5）：生产信任两层以上反代却没有源站校验 → 拒绝启动。
   * @why 层数 ≥ 2 = 采信 XFF 倒数第二跳；源站若还能被直连，直连者伪造的 XFF 会被当成真客户端 IP，
   *      限流与登录锁定可被任意绕过（config.ts ORIGIN_VERIFY_SECRET 的 @why 早就写明"两件事必须成对"，此前无人强制）。
   * @why 不是"生产一律必填"：api 尚未接入 Cloudflare 时没有人注入这个头，一律必填 = 全站 403。
   */
  it('🔴 生产 + TRUST_PROXY_HOPS ≥ 2 + 没配 ORIGIN_VERIFY_SECRET → 拒绝；配了 → 放行；层数 1 不要求', () => {
    expect(expectReject(prod({ TRUST_PROXY_HOPS: '2' })).join('\n')).toContain(
      'ORIGIN_VERIFY_SECRET',
    );
    expect(
      loadConfig(
        prod({
          TRUST_PROXY_HOPS: '2',
          ORIGIN_VERIFY_SECRET: 'cf-origin-verify-secret-0123456789abcdef',
        }),
      ).TRUST_PROXY_HOPS,
    ).toBe(2);
    expect(loadConfig(prod({ TRUST_PROXY_HOPS: '1' })).TRUST_PROXY_HOPS).toBe(1);
  });

  /** 扫描 S-02：生产配了告警收件人却没配邮件服务——告警只记日志，谁都收不到。 */
  it('🔴 生产 + ALERT_EMAIL + 没配 MAIL_PROVIDER_API_KEY → 拒绝', () => {
    expect(expectReject(prod({ ALERT_EMAIL: 'ops@example.com' })).join('\n')).toContain(
      'ALERT_EMAIL',
    );
  });

  /** 扫描 S-03：配了源站校验 = 所有请求都经 Cloudflare，层数还是 1 → req.ip 是边缘节点，整个地区共用一个限流桶。 */
  it('🔴 生产 + ORIGIN_VERIFY_SECRET + TRUST_PROXY_HOPS < 2 → 拒绝', () => {
    expect(
      expectReject(
        prod({
          TRUST_PROXY_HOPS: '1',
          ORIGIN_VERIFY_SECRET: 'cf-origin-verify-secret-0123456789abcdef',
        }),
      ).join('\n'),
    ).toContain('TRUST_PROXY_HOPS');
  });

  it('🔴 生产配置 MOCK_AUTO_CONFIRM=on → 拒绝（自动确认只给本地模拟用）', () => {
    expect(expectReject(prod({ MOCK_AUTO_CONFIRM: 'on' })).join('\n')).toContain(
      'MOCK_AUTO_CONFIRM',
    );
  });

  it('生产 + mock 通道 → 拒绝（会收真钱走假支付）', () => {
    const issues = expectReject(prod({ PAYMENT_CHANNELS: 'mock,stripe' }));
    expect(issues.join('\n')).toContain('PAYMENT_CHANNELS');
  });

  it('生产 + mock + 审核模式 → 放行（审核期是唯一合法场景）', () => {
    const c = loadConfig(
      prod({
        PAYMENT_CHANNELS: 'mock',
        REVIEW_MODE: 'on',
        REVIEW_SKU_ID: 'sku-1',
        MOCK_CALLBACK_SECRET: 'review-mock-callback-secret-2026-period',
      }),
    );
    expect(c.REVIEW_MODE).toBe('on');
  });

  it('生产 + STORAGE_DRIVER=fs → 拒绝（Render 易失盘，上传的图静默丢且无报错）', () => {
    const issues = expectReject(prod({ STORAGE_DRIVER: 'fs' }));
    expect(issues.join('\n')).toContain('STORAGE_DRIVER');
  });

  it('生产 + STORAGE_DRIVER=memory → 拒绝（进程死即丢）', () => {
    const issues = expectReject(prod({ STORAGE_DRIVER: 'memory' }));
    expect(issues.join('\n')).toContain('STORAGE_DRIVER');
  });

  it('生产未配置 STORAGE_DRIVER → 放行（不拦"不需要上传的部署"；装配层给 storage=null，上传 50000 响亮拒绝）', () => {
    const c = loadConfig(prod());
    expect(c.STORAGE_DRIVER).toBeUndefined();
  });

  /** r2 四要素齐备的夹具——@why 抽出来而不是每条用例内联：四条用例共享同一组"合法值"，各写一份会在改夹具值时漂移。 */
  const r2Full = {
    R2_ACCOUNT_ID: 'r2-account-id-like',
    R2_ACCESS_KEY_ID: 'r2-access-key-id-like',
    R2_SECRET_ACCESS_KEY: 'r2-secret-access-key-like',
    R2_BUCKET: 'jp-shop-images',
  };

  it('STORAGE_DRIVER=r2 缺四要素 → 拒绝，且四个缺失键一次全列（逐个报 = 改一次重启一次）', () => {
    const issues = expectReject(prod({ STORAGE_DRIVER: 'r2' }));
    const joined = issues.join('\n');
    expect(joined).toContain('STORAGE_DRIVER');
    for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
      expect(joined).toContain(key);
    }
  });

  it('STORAGE_DRIVER=r2 只缺 R2_BUCKET → 只报这一个（不把已配的混进去，否则会被读成"四个都要重配"）', () => {
    const issues = expectReject(prod({ STORAGE_DRIVER: 'r2', ...r2Full, R2_BUCKET: '' }));
    const joined = issues.join('\n');
    expect(joined).toContain('R2_BUCKET');
    expect(joined).not.toContain('R2_ACCOUNT_ID');
    expect(joined).not.toContain('R2_SECRET_ACCESS_KEY');
  });

  it('生产 + STORAGE_DRIVER=r2 四要素齐 → 放行（r2 是生产唯一可用驱动）', () => {
    const c = loadConfig(prod({ STORAGE_DRIVER: 'r2', ...r2Full }));
    expect(c.STORAGE_DRIVER).toBe('r2');
    expect(c.R2_BUCKET).toBe('jp-shop-images');
  });

  it('非生产 + STORAGE_DRIVER=r2 缺要素 → 同样拒绝（规则不分层：缺凭据在哪一层都是每次上传 500）', () => {
    const issues = expectReject({ ...baseEnv, STORAGE_DRIVER: 'r2' });
    expect(issues.join('\n')).toContain('R2_BUCKET');
  });

  it('生产启用 stripe 却缺 CHECKOUT_BASE_URL → 拒绝（D-49 收银链接拼不出来，运行时才暴露）', () => {
    const issues = expectReject(prod({ CHECKOUT_BASE_URL: '' }));
    expect(issues.join('\n')).toContain('CHECKOUT_BASE_URL');
  });

  it('生产审核模式（mock 的唯一合法场景）缺 MOCK_CALLBACK_SECRET → 拒绝（P1-4）', () => {
    const issues = expectReject(
      prod({ PAYMENT_CHANNELS: 'mock', REVIEW_MODE: 'on', REVIEW_SKU_ID: 'sku-1' }),
    );
    expect(issues.join('\n')).toContain('MOCK_CALLBACK_SECRET');
  });

  /**
   * 三审 S1：生产**未列出** mock 却残留 MOCK_CALLBACK_SECRET → 拒绝。
   * @why 装配层的"下线通道保留回调"语义（P1-NEW-1）对 mock 是反向的：审核期结束后残留的密钥
   *      会让 mock 回调门继续开着，而 mark-paid 不核对"订单属于哪个通道"——持有该密钥者能把
   *      任意真实订单置 paid。render.yaml 把它列为长期 sync:false 密钥，残留是最可能的形态。
   */
  it('生产未启用 mock 却残留 MOCK_CALLBACK_SECRET → 拒绝（审核期结束必须撤掉伪造回调的门）', () => {
    const issues = expectReject(
      prod({ MOCK_CALLBACK_SECRET: 'left-over-from-review-period-2026-09' }),
    );
    expect(issues.join('\n')).toContain('MOCK_CALLBACK_SECRET');
    expect(issues.join('\n')).toContain('残留');
  });

  it('生产/staging 配置 WECHAT_DEV_LOGIN → 拒绝（I1-U6b：dev 登录等价无密码登录，公网环境同拒）', () => {
    const prodIssues = expectReject(prod({ WECHAT_DEV_LOGIN: 'dev-' }));
    expect(prodIssues.join('\n')).toContain('WECHAT_DEV_LOGIN');
    const stagingIssues = expectReject({
      ...baseEnv,
      NODE_ENV: 'staging',
      WECHAT_DEV_LOGIN: 'dev-',
    });
    expect(stagingIssues.join('\n')).toContain('WECHAT_DEV_LOGIN');
  });

  it('development / test 配置 WECHAT_DEV_LOGIN → 通过（AppID 未下来前的本机联调通道）', () => {
    for (const env of ['development', 'test']) {
      const c = loadConfig({ ...baseEnv, NODE_ENV: env, WECHAT_DEV_LOGIN: 'dev-' });
      expect(c.WECHAT_DEV_LOGIN).toBe('dev-');
    }
  });

  it('staging 启用 mock 缺 MOCK_CALLBACK_SECRET → 拒绝（P3-7：公网环境不许回落公开占位值）', () => {
    const issues = expectReject({ ...baseEnv, NODE_ENV: 'staging', PAYMENT_CHANNELS: 'mock' });
    expect(issues.join('\n')).toContain('MOCK_CALLBACK_SECRET');
  });

  it('staging 显式配置 MOCK_CALLBACK_SECRET → 通过', () => {
    const c = loadConfig({
      ...baseEnv,
      NODE_ENV: 'staging',
      PAYMENT_CHANNELS: 'mock',
      MOCK_CALLBACK_SECRET: 'explicit-mock-callback-secret-32ch',
    });
    expect(c.MOCK_CALLBACK_SECRET).toBe('explicit-mock-callback-secret-32ch');
  });

  it('development / test 启用 mock 允许回落占位密钥（本机环境，可伪造面不出本机）', () => {
    for (const env of ['development', 'test']) {
      expect(loadConfig({ ...baseEnv, NODE_ENV: env }).MOCK_CALLBACK_SECRET).toBeUndefined();
    }
  });

  it('MOCK_CALLBACK_SECRET 与 JWT_SECRET 相同 → 拒绝（回调密钥与登录密钥的泄露半径必须不同）', () => {
    const issues = expectReject(
      prod({
        PAYMENT_CHANNELS: 'mock',
        REVIEW_MODE: 'on',
        REVIEW_SKU_ID: 'sku-1',
        MOCK_CALLBACK_SECRET: 'a'.repeat(32), // 与 baseEnv.JWT_SECRET 相同
      }),
    );
    expect(issues.join('\n')).toContain('MOCK_CALLBACK_SECRET');
  });

  it('REVIEW_MODE=on 时仍启用真实通道 → 拒绝（审核期只能跑 mock，AJ-30）', () => {
    // 审核模式是"上线前"状态：真实通道若同时在线，审核人员的测试下单会产生真实扣款
    const issues = expectReject(prod({ REVIEW_MODE: 'on', REVIEW_SKU_ID: 'sku-1' }));
    expect(issues.join('\n')).toContain('PAYMENT_CHANNELS');
  });

  it('STRIPE_SECRET_KEY 形状不是 sk_test_/sk_live_ → 拒绝（P3-6：贴错值启动期就该看见）', () => {
    const issues = expectReject({ ...baseEnv, STRIPE_SECRET_KEY: 'not-a-stripe-key' });
    expect(issues.join('\n')).toContain('STRIPE_SECRET_KEY');
  });

  it('STRIPE_WEBHOOK_SECRET 形状不是 whsec_ → 拒绝（webhook 密钥与 API key 混淆是最常见的验签失败原因）', () => {
    const issues = expectReject({ ...baseEnv, STRIPE_WEBHOOK_SECRET: 'sk_test_1' });
    expect(issues.join('\n')).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('生产配 sk_test_ → 拒绝（P3-6：表现是真实用户全部无法付款）', () => {
    const issues = expectReject(prod({ STRIPE_SECRET_KEY: 'sk_test_1' }));
    expect(issues.join('\n')).toContain('sk_live_');
  });

  it('CB_FAILURE_THRESHOLD ≤ 3 → 拒绝（一次请求的重试就能把上游判死，P3-11）', () => {
    const issues = expectReject({ ...baseEnv, CB_FAILURE_THRESHOLD: '3' });
    expect(issues.join('\n')).toContain('CB_FAILURE_THRESHOLD');
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
    ['SHIP_WITHIN_BUSINESS_DAYS', '0'], // "付款后 0 个工作日内发出"——承诺不可能兑现
    ['SHIP_WITHIN_BUSINESS_DAYS', '31'], // FTC 未写时限时默认 30 天；承诺比默认还长 = 文案自相矛盾
    ['PORT', '0'],
    ['PACKAGING_WEIGHT_G', '0'], // 包材 0 克会让运费向下取错档（D-46 同源的方向性错误）
    ['MAX_OPEN_ORDERS_PER_USER', '0'], // 0 = 任何人都下不了单（AJ-240）
    ['CALLBACK_ORDER_GRACE_MS', '-1'], // 负宽限期无意义（0 合法 = 不要宽限期）
    ['SHUTDOWN_READY_DELAY_MS', '-1'], // 负摘流等待无意义（0 合法 = 不等，开发用）
    ['SHUTDOWN_EVENT_DRAIN_MS', '-1'], // 负 drain 等待同理（0 合法 = 不等，开发用）
    ['FREE_SHIPPING_JPY', '0'], // 三审：0 / 负阈值 = 全场包邮，与"留空 = 不包邮"的语义相撞；要包邮就写正数
    ['FREE_SHIPPING_JPY', '-5'],
    ['MAX_ORDER_JPY', '200000'], // 三审：D-42 单笔必须低于 ¥200,000 出口申报阈值——超过就是每单要报关
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

/**
 * N10：ConfigError.issues 会**逐行打到 stderr**（main.ts），所以它们绝不能携带原始值——
 * 一条 "received 'sk_live_...'" 就能把密钥写进平台日志。
 *
 * @why 现状靠 zod v4 默认消息**碰巧**不含值（v4 移除了 v3 的 ", received 'x'"），
 *      但"碰巧安全"不是安全：升级 zod、自定义 error map、或哪个字段写了
 *      `message: \`...${input}...\`` 就会破。这条用例把"值不出现"变成硬约束。
 */
describe('issues 不携带原始值（N10）', () => {
  it('非法枚举值与过短密钥的原始值都不出现在 issues 里', () => {
    const issues = expectReject({
      ...baseEnv,
      NODE_ENV: 'secret-value-must-not-appear-1',
      JWT_SECRET: 'secret-value-must-not-appear-2',
    });
    const all = issues.join('\n');
    expect(all).toContain('NODE_ENV');
    expect(all).toContain('JWT_SECRET');
    expect(all).not.toContain('secret-value-must-not-appear');
  });
});

/**
 * N11：配置形状缺口——"值本身不像它该像的东西"。
 * @why 这类缺口的特点是**启动全绿、运行时才炸**：`CHECKOUT_BASE_URL=nope` 要到拼支付短链
 *      才发现不是 URL；`CORS_ORIGINS=*` 不会生效但也不报错，你以为配上了；
 *      `[::1]` 绕过了"生产不得连本机库"的正则。形状规则对 staging 同样生效（第二轮 §N11 口径）——
 *      staging 就是拿来提前撞这些错的。
 */
describe('配置形状（N11）', () => {
  const prodLike = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...baseEnv,
    NODE_ENV: 'production',
    APP_ID: 'wx-prod-like',
    APP_SECRET: 'prod-like-app-secret',
    DATABASE_URL: 'postgresql://app@db.internal:5432/japan_shop',
    PAYMENT_CHANNELS: 'stripe',
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    CHECKOUT_BASE_URL: 'https://checkout.example.com',
    CORS_ORIGINS: 'https://admin.example.com',
    ...extra,
  });

  it('微信登录配置：APP_ID / APP_SECRET 只配一个 → 拒启；生产两者都缺 → 拒启（全量审计 P2：半配登录 500）', () => {
    expect(expectReject(prodLike({ APP_SECRET: '' })).join('\n')).toContain('APP_ID');
    expect(expectReject(prodLike({ APP_ID: '' })).join('\n')).toContain('APP_ID');
    expect(expectReject(prodLike({ APP_ID: '', APP_SECRET: '' })).join('\n')).toContain(
      '生产环境必须配置 APP_ID',
    );
    // 开发环境两者都缺是合法的（走 WECHAT_DEV_LOGIN 或根本不登录）
    expect(() => loadConfig({ ...baseEnv, APP_ID: '', APP_SECRET: '' })).not.toThrow();
  });

  it('CHECKOUT_BASE_URL 非 URL → 拒启（staging 也拦，不能等拼短链才发现）', () => {
    const issues = expectReject({ ...baseEnv, NODE_ENV: 'staging', CHECKOUT_BASE_URL: 'nope' });
    expect(issues.join('\n')).toContain('CHECKOUT_BASE_URL');
  });

  it('生产 CHECKOUT_BASE_URL 必须 https（http 短链会被当钓鱼域名拦截）', () => {
    const issues = expectReject(prodLike({ CHECKOUT_BASE_URL: 'http://checkout.example.com' }));
    expect(issues.join('\n')).toContain('CHECKOUT_BASE_URL');
  });

  it('合法 URL 通过（staging 允许 http://localhost 调试用；回归：不能把正常配置拦死）', () => {
    const c = loadConfig({
      ...baseEnv,
      NODE_ENV: 'staging',
      CHECKOUT_BASE_URL: 'http://localhost:4000',
      // staging 启用 mock 必须显式密钥（P3-7）；本用例测的是 URL 规则，补密钥隔离变量
      MOCK_CALLBACK_SECRET: 'explicit-mock-callback-secret-32ch',
    });
    expect(c.CHECKOUT_BASE_URL).toBe('http://localhost:4000');
  });

  it('CHECKOUT_BASE_URL 带尾斜杠 → 规范化去掉（全量审查 B9：三处拼接只有一处处理过）', () => {
    /**
     * @why 2026-09-29 全量审查 B9：`CHECKOUT_BASE_URL` 有三处拼接——
     *      `pay-intent.ts` 的短链 `${base}/o/${id}`、`channels.ts` 的 Stripe
     *      `successUrl/cancelUrl` `${base}${path}`、以及 `pay-link-routes.ts` 的
     *      `expiredPageUrl`。**只有第三处**做了 `.replace(/\/+$/, '')`。
     *      部署时多打一个斜杠（zod 的 url 规则接受且不规范化）的表现是：
     *      · 银行卡短链变成 `https://checkout.example.com//o/<id>` → 静态站的 `/o/*`
     *        路由规则不匹配 → 用户点了短链打不开收银页；
     *      · Stripe 付完款回跳 `//pay/done` → 404。
     *      **不报错、启动全绿**，属于"配置对了一半"的静默故障，且只有走到付款那一步才发现。
     * @why 在**配置层**规范化而不是在每个拼接点各写一次：拼接点是会被新增的
     *      （将来加一个"订单详情页地址"就又是一处），而"URL 该长什么样"只有一个答案。
     *      把答案放在唯一入口，新增拼接点不用记得做处理。
     * @limitation 只去**路径末尾**的斜杠，不动 query / 其余部分
     *      （`https://x.com/a/` 与 `https://x.com/a//` 都归一到 `https://x.com/a`）。
     *      根路径 `https://x.com/` 归一化成 `https://x.com`，与"不带斜杠"等价。
     */
    const c = loadConfig({
      ...baseEnv,
      NODE_ENV: 'staging',
      CHECKOUT_BASE_URL: 'http://localhost:4000/',
      MOCK_CALLBACK_SECRET: 'explicit-mock-callback-secret-32ch',
    });
    expect(c.CHECKOUT_BASE_URL).toBe('http://localhost:4000');
    // 多个尾斜杠同样归一（防"去掉一个还剩一个"）
    const c2 = loadConfig({
      ...baseEnv,
      NODE_ENV: 'staging',
      CHECKOUT_BASE_URL: 'http://localhost:4000//',
      MOCK_CALLBACK_SECRET: 'explicit-mock-callback-secret-32ch',
    });
    expect(c2.CHECKOUT_BASE_URL).toBe('http://localhost:4000');
    // 不带斜杠的原样保留（回归：不能把正常值改坏）
    const c3 = loadConfig({
      ...baseEnv,
      NODE_ENV: 'staging',
      CHECKOUT_BASE_URL: 'http://localhost:4000',
      MOCK_CALLBACK_SECRET: 'explicit-mock-callback-secret-32ch',
    });
    expect(c3.CHECKOUT_BASE_URL).toBe('http://localhost:4000');
  });

  it('TERMS_VERSION 超过 32 字符 → 拒启（全量审查 B32：超列宽会让之后所有建单 500）', () => {
    /**
     * @why 2026-09-29 全量审查 B32：`orders.terms_version` 在迁移 008 里已加宽到
     *      `VARCHAR(32)`，但配置层只有 `.min(1)`、没有上界。于是
     *      `TERMS_VERSION=TOS-2026-10-01-with-a-very-long-suffix`（>32）能通过启动校验，
     *      `/terms` 接口**照常下发**这个版本，前端照常把它塞进建单请求体，
     *      然后每一笔建单都在写库时撞 22001（value too long）→ 50000。
     *      失败形态是"服务起来了、对账也健康、就是所有人都下不了单"，
     *      而且启动期不报错意味着**部署后第一次成功请求之前没人知道**。
     * @why 上界取自列宽而不是拍一个数：列宽是硬约束，配置上界比它大就是漏网、
     *      比它小就是把合法值拦死。二者必须同源（下一条 db 用例从 information_schema 读列宽对拍）。
     */
    const issues = expectReject({ ...baseEnv, TERMS_VERSION: 'T'.repeat(33) });
    expect(issues.join('\n')).toContain('TERMS_VERSION');
    // 边界：32 恰好放行（不能把最大值本身拦掉）
    expect(() => loadConfig({ ...baseEnv, TERMS_VERSION: 'T'.repeat(32) })).not.toThrow();
  });

  it('MOCK_CALLBACK_SECRET 短于 32 → 拒启（全量审查 B19：短密钥可被在线枚举伪造"支付成功"）', () => {
    /**
     * @why 2026-09-29 全量审查 B19：`MOCK_CALLBACK_SECRET` 是**审核期伪造"支付成功"**的
     *      HMAC 密钥——持有它就能给任意订单落账（把订单置为 paid）。它此前用 `optionalText()`，
     *      即**没有长度下限**：`NODE_ENV=production` + `PAYMENT_CHANNELS=mock` +
     *      `REVIEW_MODE=on` + `MOCK_CALLBACK_SECRET=a` 能正常启动。
     *      审核期这条通路是**刻意**暴露在公网上的（审核员要用它下单），
     *      一个 1 字符密钥在线枚举几十次即可命中，后果是审核期订单被任意置为已付款。
     * @why N11 自己的论断是"配了但很短比没配更危险"（短值给了安全的错觉），
     *      但这条论断此前没有落实到这里——`optionalSecret()` 就是为它写的，却没被用上。
     * @why 阈值取 32（与 JWT_SECRET 同档，见同一份 `.env.example` 的口径）：
     *      它是 HMAC 密钥，强度和 JWT 密钥是同一量级的问题。
     */
    const issues = expectReject({ ...baseEnv, MOCK_CALLBACK_SECRET: 'a' });
    expect(issues.join('\n')).toContain('MOCK_CALLBACK_SECRET');
    // 边界：32 恰好放行（不能把合法长度拦掉）
    expect(() => loadConfig({ ...baseEnv, MOCK_CALLBACK_SECRET: 'b'.repeat(32) })).not.toThrow();
  });

  it('CORS_ORIGINS=* → 拒启（通配不会生效但也不报错——静默通过等于以为配上了）', () => {
    const issues = expectReject({ ...baseEnv, CORS_ORIGINS: '*' });
    expect(issues.join('\n')).toContain('CORS_ORIGINS');
  });

  it('CORS_ORIGINS 条目必须是带 scheme 的 origin（缺 scheme 的 "admin.example.com" 拦下）', () => {
    const issues = expectReject({ ...baseEnv, CORS_ORIGINS: 'admin.example.com' });
    expect(issues.join('\n')).toContain('CORS_ORIGINS');
  });

  /**
   * @why 浏览器发的 `Origin` 头**只有** `scheme://host[:port]`，永远不带路径。
   *      所以配成 `https://admin.example.com/app` 的后果不是"更精确"，而是
   *      **永不匹配**：服务端的精确白名单比对必然落空，管理端所有跨域请求全被拒，
   *      而配置看起来是"配好了"——这类"配了但不生效"比"没配"更难查（后者至少会报跨域错）。
   *      同理带查询串、哈希、用户信息（user:pass@）的值都不是合法 origin。
   */
  it('CORS_ORIGINS 条目带路径/查询/用户信息 → 拒启（配了也永不匹配，静默失效）', () => {
    for (const bad of [
      'https://admin.example.com/app',
      'https://admin.example.com/app/',
      'https://admin.example.com/?a=1',
      'https://admin.example.com/#x',
      'https://user:pw@admin.example.com',
    ]) {
      const issues = expectReject({ ...baseEnv, CORS_ORIGINS: bad });
      expect(issues.join('\n'), `「${bad}」应当被拒`).toContain('CORS_ORIGINS');
    }
    // 尾斜杠是合法写法（origin 归一化后一致），带端口的也必须放行——两者都不该误伤
    expect(
      loadConfig({ ...baseEnv, CORS_ORIGINS: 'https://admin.example.com/' }).CORS_ORIGINS,
    ).toEqual(['https://admin.example.com']);
    expect(loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://localhost:5173' }).CORS_ORIGINS).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('生产 DATABASE_URL 指向 [::1] / 127.x 都拒启（本机判定按 URL hostname 解析，不是正则碰运气）', () => {
    expect(
      expectReject(prodLike({ DATABASE_URL: 'postgresql://app@[::1]:5432/japan_shop' })).join('\n'),
    ).toContain('DATABASE_URL');
    expect(
      expectReject(prodLike({ DATABASE_URL: 'postgresql://app@127.0.0.2:5432/japan_shop' })).join(
        '\n',
      ),
    ).toContain('DATABASE_URL');
    // 三审链路补盲时发现的漏洞：`0.0.0.0` / `[::]` 作为**连接目标**等同于本机（内核路由到环回），
    // 却不在名单里——与 test-db.ts 的测试库闸门（拒 0.0.0.0）方向不一致。
    for (const url of [
      'postgresql://app@0.0.0.0:5432/japan_shop',
      'postgresql://app@[::]:5432/japan_shop',
    ]) {
      expect(expectReject(prodLike({ DATABASE_URL: url })).join('\n'), url).toContain(
        'DATABASE_URL',
      );
    }
  });

  it('INTERNAL_JOB_SECRET < 32 → 拒启（HMAC 共享密钥，staging 同样生效）', () => {
    const issues = expectReject({ ...baseEnv, NODE_ENV: 'staging', INTERNAL_JOB_SECRET: 'abc' });
    expect(issues.join('\n')).toContain('INTERNAL_JOB_SECRET');
  });

  /**
   * B17 / AJ-209：配对规则改为**单向**。
   * @why 旧规则要求"成对或同时留空"，于是"建号后从平台删掉初始口令"会让服务**拒绝启动**
   *      ——而"删掉初始口令"恰恰是 AJ-181 与 .env.example 承诺过的收尾动作（B17）。
   *      两条放行/拒绝方向都必须各钉一条：只钉"只配口令要拒"的话，
   *      把规则改回"成对"仍然全绿（因为那条本来就红）；只钉"只配邮箱放行"的话，
   *      把规则整个删掉也全绿。两个方向同时钉住，规则才被**钉在**单向这一态。
   */
  it('只配 ADMIN_INITIAL_PASSWORD 没有 ADMIN_EMAIL → 拒启（口令没有落点）', () => {
    expect(
      expectReject({ ...baseEnv, ADMIN_INITIAL_PASSWORD: 'initial-password-123' }).join('\n'),
    ).toContain('ADMIN_EMAIL');
  });

  it('只配 ADMIN_EMAIL、没配口令 → **允许启动**（管理员已建号、口令已从平台删除的正常终态）', () => {
    const c = loadConfig({ ...baseEnv, ADMIN_EMAIL: 'boss@example.com' });
    expect(c.ADMIN_EMAIL).toBe('boss@example.com');
    expect(c.ADMIN_INITIAL_PASSWORD).toBeUndefined();
  });

  it('两者都配 → seed 会跑（正常初装态）', () => {
    expect(
      loadConfig({
        ...baseEnv,
        ADMIN_EMAIL: 'boss@example.com',
        ADMIN_INITIAL_PASSWORD: 'initial-password-123',
      }).ADMIN_EMAIL,
    ).toBe('boss@example.com');
  });

  it('ADMIN_INITIAL_PASSWORD < 12 → 拒启（初始口令是爆破的第一目标）', () => {
    const issues = expectReject({ ...baseEnv, NODE_ENV: 'staging', ADMIN_INITIAL_PASSWORD: 'abc' });
    expect(issues.join('\n')).toContain('ADMIN_INITIAL_PASSWORD');
  });
});

/**
 * 喂给 setTimeout / setInterval 的毫秒配置要有上限（S-06）。
 * @why ≥ 2^31 ms 时 Node 把定时器截成 1ms（TimeoutOverflowWarning）：调度器每毫秒跑一轮打满数据库，
 *      停机总预算 1ms 就到点、不排空直接退出。启动期拒掉比运行期出事好。
 */
describe('定时类毫秒配置的上限（S-06）', () => {
  it.each([
    'SCHEDULER_TICK_MS',
    'SHUTDOWN_TOTAL_BUDGET_MS',
    'SHUTDOWN_READY_DELAY_MS',
    'SHUTDOWN_EVENT_DRAIN_MS',
    'SHUTDOWN_JOB_WAIT_MS',
    'SHUTDOWN_BUDGET_FLUSH_MS',
    'HTTP_TIMEOUT_MS',
    'HTTP_TOTAL_BUDGET_MS',
    'CB_COOLDOWN_MS',
  ])('%s=2147483648 → 拒启', (key) => {
    const issues = expectReject({ ...baseEnv, [key]: '2147483648' });
    expect(issues.join('\n')).toContain(key);
  });

  it('2147483647（定时器能表示的最大值）仍然接受', () => {
    expect(loadConfig({ ...baseEnv, SCHEDULER_TICK_MS: '2147483647' }).SCHEDULER_TICK_MS).toBe(
      2147483647,
    );
  });
});

describe('mockAutoConfirmEnabled（本地模拟付款，AJ-373）', () => {
  it('只在开关 on 且 development / test 时生效；生产即使开关 on 也不生效（第二道防线）', () => {
    expect(mockAutoConfirmEnabled({ MOCK_AUTO_CONFIRM: 'on', NODE_ENV: 'development' })).toBe(true);
    expect(mockAutoConfirmEnabled({ MOCK_AUTO_CONFIRM: 'on', NODE_ENV: 'test' })).toBe(true);
    expect(mockAutoConfirmEnabled({ MOCK_AUTO_CONFIRM: 'on', NODE_ENV: 'production' })).toBe(false);
    expect(mockAutoConfirmEnabled({ MOCK_AUTO_CONFIRM: 'off', NODE_ENV: 'development' })).toBe(
      false,
    );
  });
});
