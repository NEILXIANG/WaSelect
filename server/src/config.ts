/**
 * 职责：配置体系第一层——环境变量的 schema 校验与脱敏（F3）。
 * 边界：只做「读 + 校验 + 脱敏」。第二层（运行时可改的 `app_config` 表）在 F7 之后接入，不在此文件。
 *
 * @why 配置错必须在**进程启动时**就炸，而不是跑到某个分支才炸：跨境支付里少一个密钥的代价是静默丢单，
 *      而静默丢单在日志里长得跟"用户自己放弃支付"一模一样，事后无法区分。
 * @why 变量名与取值范围以 `.env.example` 为唯一真源——本文件是它的**可执行镜像**，两边必须逐项对齐；
 *      只改一边会让"文档说有、代码读不到"成为一类长期潜伏的 bug。
 *
 * @limitation 一：zod 默认 strip 未知键，所以**变量名拼错会被静默忽略**（例如 `JWT_SECRECT=` 不报错、读到默认值）。
 *              这里不能用 `.strict()`，因为 `process.env` 里有 PATH/HOME 等大量无关变量。
 *              缓解手段：`.env.example` 与本 schema 一一对应 + 启动时打印 `redactConfig()`（F5 接入），
 *              拼错的变量会表现为"打印出来是默认值"，肉眼可发现。
 * @limitation 二：只校验形状与范围，不校验"值与外部世界是否匹配"（例如 DATABASE_URL 是否真能连上）——
 *              连通性由 F7 的启动自检负责，配置层不做 IO。
 * @limitation 三：`DUTY_RATE_US` 是迁移期保留项。ADR-28 要求关税率外置到 `duty_rates(origin,dest,rate)` 表，
 *              F7 只把它当作 seed 默认值写入该表，运行期一律查表，不再读此变量。
 *
 * @tradeoff 新增环境变量必须同步改 schema，否则启动失败——这是**有意的硬失败**，
 *           比"读不到就用一个看起来合理的默认值"安全，尤其在金额/税率/通道这类字段上。
 * @tradeoff `PAYMENT_CHANNELS` 刻意**不给默认值**：若默认成 `mock`，生产环境漏配就会静默跑假支付（收真钱不到账）。
 *           代价是每个环境都必须显式声明，测试里也要显式传。
 *
 * @see .env.example（变量名唯一真源）、docs/地基搭建清单.md F3、技术文档 v0.5 §8、ADR-28（关税外置）
 */
import { z } from 'zod';
import { CURRENCY, PAYMENT_CHANNEL } from '@waselect/shared';

/** 密钥类配置的键名：日志 / 诊断 / 错误上报一律脱敏（评审 #9 红线）。新增密钥类变量必须同步加这里。 */
export const SECRET_KEYS = [
  'DATABASE_URL', // 含主机、库名、可能含口令
  'JWT_SECRET',
  'APP_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'MOCK_CALLBACK_SECRET',
  'WECHAT_INSTITUTION_API_KEY',
  'WECHAT_INSTITUTION_MERCHANT_ID',
  'INTERNAL_JOB_SECRET',
  'MAIL_PROVIDER_API_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'ADMIN_INITIAL_PASSWORD',
] as const;

/* ── 环境变量转换助手 ────────────────────────────────────────────────────────
 * process.env 里一切都是字符串，且 `.env.example` 用 `KEY=`（空串）表示"未设置"。
 * 所以统一约定：**空串 = 未设置**，不能当有效值（否则 `FREE_SHIPPING_JPY=` 会被解析成 0 而变成"全场包邮"）。
 * ------------------------------------------------------------------------- */

/** 数字（可带小数）：空串 / 缺失 → 用默认值；'abc' → NaN → 校验失败（不会静默变 0）。 */
function num(defaultValue: number) {
  return z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().default(defaultValue),
  );
}

/**
 * 整数：同上，额外要求整数（Infinity / NaN 都会被拒）。
 * @param min 下限。**必须给**：曾经所有数值只有"能解析成数字"这一层校验，
 *            于是 `SCHEDULER_TICK_MS=0`（每 0ms 跑一次，打满 CPU）、`RATE_LIMIT_LOGIN_PER_15MIN=0`
 *            （等于全站禁登录）、`ORDER_PAYMENT_TTL_MIN=0`（订单刚建就过期）都能正常启动，
 *            且每一种都表现为"线上怪异但不报错"。数值型配置的量纲错误必须挡在启动阶段。
 */
function int(defaultValue: number, min?: number) {
  const base = z.number().int();
  return z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    (min === undefined ? base : base.min(min)).default(defaultValue),
  );
}

/** 可选整数：空串 / 缺失 → undefined（用于"不设置即关闭该功能"的开关，如包邮阈值）。 */
function optionalInt() {
  return z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().int().optional(),
  );
}

/** 可选字符串：空串 → undefined（`.env.example` 里 `APP_ID=` 是占位，不是空字符串值）。 */
function optionalText() {
  return z.preprocess((v) => (v === undefined || v === '' ? undefined : v), z.string().optional());
}

/**
 * 可选 URL（N11）：空串 → undefined；否则必须是 http(s) URL。
 * @why `CHECKOUT_BASE_URL=nope` 这类配置启动时不拦，就要等到拼支付短链才炸——形状问题必须启动期拦。
 *      生产的 https 要求在 crossField（需要看 NODE_ENV，字段级判断不了）。
 */
function optionalUrl() {
  return z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : v),
    z
      .url({ protocol: /^https?$/, error: '必须是 http(s) URL（如 https://checkout.example.com）' })
      .optional(),
  );
}

/**
 * 可选密钥类字符串（N11）：空串 → undefined；否则有最小长度。
 * @why HMAC 共享密钥 / 初始口令是爆破与撞库的第一目标，"配了但很短"和"没配"是两回事，
 *      前者更危险（看起来有保护）。形状规则不分环境（staging 同样生效）——staging 就是用来提前撞错的。
 */
function optionalSecret(minLen: number, label: string) {
  return z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : v),
    z.string().min(minLen, `${label} 至少 ${minLen} 字符（密钥/口令强度下限，N11）`).optional(),
  );
}

/** 逗号分隔列表 → 字符串数组；空 / 缺失 → 空数组。 */
function csv() {
  return z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim()
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    z.array(z.string()),
  );
}

/**
 * CORS 源列表（N11）：每项必须是带 scheme 的 http(s) origin，禁止通配、禁止带路径。
 * @why `CORS_ORIGINS=*` 不会真的生效（http.ts 按白名单逐项匹配），但也**不报错**——
 *      静默通过等于"你以为配上了"。缺 scheme 的 `admin.example.com` 同理。
 * @why 还必须**拒绝带路径/查询/哈希/用户信息的值**（2026-09-23 自查发现）：
 *      浏览器发的 `Origin` 头只有 `scheme://host[:port]`，永远不带路径。
 *      配成 `https://admin.example.com/app` 的后果不是"更精确"而是**永不匹配**——
 *      管理端所有跨域请求全被拒，而配置看起来是配好的。"配了但不生效"比"没配"更难查。
 * @limitation 尾斜杠（`https://a.com/`）按合法处理并**归一化**成 `https://a.com`：
 *             它是 origin 的等价写法，拒绝它会让"看起来最正常的写法"启不来。
 */
function corsOrigins() {
  return (
    csv()
      .refine(
        (items) =>
          items.every((o) => {
            // 注：不需要单独的通配符判断——'*' 不是合法 URL host，new URL 会先抛
            // （'CORS_ORIGINS=* 拒启'用例钉住这个行为；曾有一行 includes('*') 守卫，实测是冗余分支）
            try {
              const u = new URL(o);
              if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
              if (u.host.length === 0) return false;
              // origin 只由 scheme/host/port 组成：其余部分一律视为"配错了"
              return (
                u.username === '' &&
                u.password === '' &&
                u.search === '' &&
                u.hash === '' &&
                (u.pathname === '' || u.pathname === '/')
              );
            } catch {
              return false;
            }
          }),
        {
          message:
            'CORS_ORIGINS 每项必须是带 scheme 的 http(s) origin（如 https://admin.example.com）：禁止通配符、路径、查询串与用户信息（Origin 头不含这些，配了也永不匹配）',
        },
      )
      // 归一化：'https://a.com/' → 'https://a.com'，与浏览器实际发送的 Origin 头严格相等
      .transform((items) => items.map((o) => new URL(o).origin))
  );
}

const schema = z.object({
  // ── 运行时 ──────────────────────────────────────────────────────────────
  /**
   * 运行环境。**必须接受 `test`**（D17）：Vitest 启动时就会把 `NODE_ENV` 设成 `test`，
   *      而组装根一接进来，测试里调 `loadConfig(process.env)` 就会因这个值未登记而直接失败——
   *      属于"测试与生产共用同一条装配路径"之后必然撞上的第一类问题。
   * @limitation `test` 与 `development` 走同一套"非生产"规则（骨架照挂、日志 debug 级）。
   *              刻意不把它单独成一类：那会让"测试环境的特殊行为"成为长期的隐藏分支。
   */
  NODE_ENV: z.enum(['development', 'staging', 'test', 'production']).default('development'),
  PORT: int(3000, 1),
  /**
   * 监听地址。**生产必须 0.0.0.0**（容器平台从宿主机外部探端口，绑回环 → 健康检查超时、发布失败）。
   * @why 曾经过 `process.env.HOST` 裸读、schema 里根本没有这一项：
   *      结果 `.env.example` 写了 HOST 但配置层不认识它——拼成 `HOST=0.0.0.O`（字母 O）也不会报错，
   *      只会静默回落到默认值。这类"文档有、代码没有"的键正是配置漂移的入口，
   *      现在由 `config.contract.test.ts` 的"文档 ↔ schema 键集合必须一致"自动兜住。
   */
  HOST: z
    .preprocess(
      (v) => (v === undefined || v === '' ? undefined : String(v).trim()),
      z.string().min(1).default('0.0.0.0'),
    )
    .refine(
      (v) => v === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(v) || v === '::' || v === '::1',
      'HOST 必须是 IP 地址或 localhost（拼错会静默回落到默认值，不会报错）',
    ),

  /**
   * 可信反向代理层数（D23）。
   * @why 必须是**层数**而不是布尔：Express 的 `trust proxy = true` 会采信 `X-Forwarded-For` 最左值，
   *      而最左值是客户端自己能填的——一旦将来按 IP 做限流 / 登录锁定，伪造一个头就绕过去了
   *      （实测：true 取最左 1.1.1.1；1 取最右 3.3.3.3，即平台那一跳写入的值）。
   * @limitation 取值宁小勿大：小于实际层数时取到中间代理的 IP（错，但至少不可伪造）；
   *              大于实际层数才会重新变得可伪造。Render 前一层 = 1，本机无代理 = 0。
   */
  TRUST_PROXY_HOPS: int(1, 0),

  // ── 微信小程序 ──────────────────────────────────────────────────────────
  APP_ID: optionalText(),
  APP_SECRET: optionalText(),

  // ── 服务端与管理员 ──────────────────────────────────────────────────────
  /** 自定义 token 密钥；≥32 字符（openssl rand -hex 32）。生产环境绝不允许短密钥。 */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符，用 openssl rand -hex 32 生成'),
  ADMIN_OPENIDS: csv(),
  ADMIN_EMAIL: optionalText(),
  ADMIN_INITIAL_PASSWORD: optionalSecret(12, 'ADMIN_INITIAL_PASSWORD'),

  // ── 数据库 ──────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 必填（postgresql://user@host:5432/db）'),

  // ── 货币与定价（JPY 唯一锚，ADR-09）─────────────────────────────────────
  /** 定价锚 = 结算币 = 记账币。用 literal 而不是 enum：这里不允许"暂时改成 USD 试试"。 */
  PRICING_ANCHOR: z.literal('JPY').default('JPY'),
  /** 展示币（JPY 是锚，恒显示；这里列的是锚之外的展示币）。非法币种直接启动失败。 */
  DISPLAY_CURRENCIES: z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim()
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : ['CNY', 'USD'],
    z.array(z.enum(CURRENCY)).min(1, 'DISPLAY_CURRENCIES 至少一种'),
  ),
  /** 汇率缓冲（写 fx_rates.buffer）。上限 0.5 防止配置写成 0.3% 之类的量纲错误。 */
  FX_BUFFER_RATE: num(0.03).pipe(z.number().min(0).max(0.5)),
  /** 迁移期保留：F7 用它 seed `duty_rates`，运行期查表（@limitation 三）。 */
  DUTY_RATE_US: num(0.15).pipe(z.number().min(0).max(1)),
  /** 包邮阈值（整数円）；空 = 不包邮。 */
  FREE_SHIPPING_JPY: optionalInt(),
  /** 单笔上限（D-42）：低于 ¥200,000 出口申报阈值与 Zonos 预付上限；超出 → 40906。 */
  MAX_ORDER_JPY: int(180000, 1),
  /** 包材自重（D-42）。下限 1：0 克在业务上无意义，且会让运费向下取错档（D-46 同源的方向性错误）。 */
  PACKAGING_WEIGHT_G: int(250, 1),

  // ── 订单生命周期 ────────────────────────────────────────────────────────
  ORDER_PAYMENT_TTL_MIN: int(30, 1),
  /**
   * 回调早到宽限期（毫秒，AJ-32）：回调到达时订单不存在，
   * 距事件首次到达 ≤ 此值 → 503 让机构重发；超过 → 2xx + error 告警 + 落 unmatched 转对账。
   * @why 15 分钟是**拍的**（无机构实测数据）：远大于建单链路 P99 延迟（秒级），
   *      远小于机构放弃重发的窗口（小时级～3 天）。上线后拿到真实回调延迟分布再校准——
   *      它是配置项，调整不发版。
   */
  CALLBACK_ORDER_GRACE_MS: int(900_000, 0),
  /** 常驻调度器 tick 间隔（D-43：web 进程内 setInterval + pg_try_advisory_lock；不是 Render Cron Job）。 */
  SCHEDULER_TICK_MS: int(60000, 1000),
  /**
   * N7：停机时摘流量（/readyz 转 503）后、close 前的等待毫秒数。
   * @why 平台健康检查有周期，立即 close 则 503 窗口≈0、在途请求被腰斩。
   *      5s 是**拍的**（Render 健康检查间隔量级为几秒）：够平台发现，又不至于显著拖慢发布。
   *      拿到平台真实摘流延迟后再校准——配置项，调整不发版。0 合法（开发/测试不等）。
   */
  SHUTDOWN_READY_DELAY_MS: int(5_000, 0),
  AUTO_DELIVER_DAYS: int(30, 1),
  AUTO_COMPLETE_DAYS: int(7, 1),
  /** 建单必传且必须与服务端相等，否则 40011（D-43）。必填 → 忘了配就启动失败，而不是全站下单失败。 */
  TERMS_VERSION: z.string().min(1, 'TERMS_VERSION 必填（建单比对，D-43）'),

  // ── 支付通道（可插拔，ADR-28）────────────────────────────────────────────
  /**
   * 启用的通道。刻意不给默认值（@tradeoff）。
   * 值必须是 shared 枚举里的成员——**新增支付方式必须先改 shared 枚举**，这里会硬拦住拼错/未登记的通道。
   */
  PAYMENT_CHANNELS: z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim()
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z
      .array(z.enum(PAYMENT_CHANNEL))
      .min(1, 'PAYMENT_CHANNELS 至少启用一个（mock | stripe | wechat）'),
  ),
  CHECKOUT_BASE_URL: optionalUrl(),
  STRIPE_SECRET_KEY: optionalText(),
  STRIPE_WEBHOOK_SECRET: optionalText(),
  /**
   * mock 回调的 HMAC 密钥（骨架期 / 审核期专用）。
   * @why 独立字段、**绝不默认复用 JWT_SECRET**（基座自查 P1-4）：
   *      ① 回调密钥与登录密钥的泄露半径不同——回调密钥要配给模拟器/审核脚本，JWT 密钥哪都不该去；
   *      ② JWT 密钥轮换是既定需求，若回调验签挂在同一把钥匙上，轮换当天所有模拟回调全部失效。
   *      非生产环境可留空（装配层回落到开发占位值）；生产启用 mock（= 审核模式）时必填。
   */
  MOCK_CALLBACK_SECRET: optionalText(),
  WECHAT_INSTITUTION_MERCHANT_ID: optionalText(),
  WECHAT_INSTITUTION_API_KEY: optionalText(),
  /** on 时仅 REVIEW_SKU_ID 商品允许 channel=mock（审核期用）。 */
  REVIEW_MODE: z.enum(['on', 'off']).default('off'),
  REVIEW_SKU_ID: optionalText(),

  // ── 限流与内部任务（D-52 / D-43）────────────────────────────────────────
  RATE_LIMIT_LOGIN_PER_15MIN: int(5, 1),
  RATE_LIMIT_QUOTE_PER_MIN: int(30, 1),
  /** Cron Job 调 POST /internal/jobs/daily 的共享密钥；留空时该端点在启动时关闭（F6 接入）。 */
  INTERNAL_JOB_SECRET: optionalSecret(32, 'INTERNAL_JOB_SECRET'),

  // ── 通知与可观测性（F5 接入）─────────────────────────────────────────────
  SENTRY_DSN: optionalText(),
  CORS_ORIGINS: corsOrigins(),
  MAIL_PROVIDER_API_KEY: optionalText(),
  SUBSCRIBE_TMPL_PAID: optionalText(),
  SUBSCRIBE_TMPL_SHIPPED: optionalText(),
  SUBSCRIBE_TMPL_DELIVERED: optionalText(),

  // ── 对象存储与对外域名 ──────────────────────────────────────────────────
  R2_ACCOUNT_ID: optionalText(),
  R2_ACCESS_KEY_ID: optionalText(),
  R2_SECRET_ACCESS_KEY: optionalText(),
  R2_BUCKET: optionalText(),
  IMG_BASE_URL: optionalUrl(),
  PUBLIC_API_BASE: optionalUrl(),
});

/**
 * 跨字段校验——**单项都合法、组合起来是事故**的那一类。
 *
 * @why 逐字段 schema 只能回答"这个值本身对不对"，回答不了"这套配置放在一起能不能收钱"。
 *      真实事故形态全部落在组合里：生产开了 `mock` 通道（收真钱、走假支付）、
 *      开了 stripe 却没配密钥（下单必失败且报的是泛化 500）、审核模式开了却没指定 SKU（全站下不了单）。
 *      这些组合里没有一个字段是"非法值"，所以只能靠跨字段规则拦。
 *
 * @limitation 只拦"确定错误"的组合，不做"提醒级"校验（例如建议配 Sentry）。
 *              提醒一旦进启动校验就会被当成噪音忽略，宁可少而硬。
 */
const crossField = schema.superRefine((c, ctx) => {
  const isProd = c.NODE_ENV === 'production';
  const add = (path: string, message: string): void => {
    ctx.addIssue({ code: 'custom', path: [path], message });
  };

  // 1. 生产跑假支付：最危险的一条——用户能正常下单、钱不到账，且日志里长得跟"放弃支付"一样
  if (isProd && c.PAYMENT_CHANNELS.includes('mock') && c.REVIEW_MODE !== 'on') {
    add(
      'PAYMENT_CHANNELS',
      '生产环境不得启用 mock 通道（会收真钱走假支付）。审核期确需时须同时设 REVIEW_MODE=on 与 REVIEW_SKU_ID',
    );
  }

  // 2. 审核模式必须指定 SKU，否则所有商品都不能用 mock 下单，等于审核期全站不可用
  if (c.REVIEW_MODE === 'on' && c.REVIEW_SKU_ID === undefined) {
    add('REVIEW_SKU_ID', 'REVIEW_MODE=on 时必须指定 REVIEW_SKU_ID（否则审核期没有任何商品可下单）');
  }

  // 2b. 审核模式 = 上线前状态：只允许 mock 通道（AJ-30）。
  //     若真实通道同时在线，审核人员的测试下单会产生真实扣款；
  //     商店已上线后不需要也不应再开 REVIEW_MODE（那是首版审核专用状态，见 AJ-30 的权衡）。
  if (c.REVIEW_MODE === 'on' && c.PAYMENT_CHANNELS.some((ch) => ch !== 'mock')) {
    add('PAYMENT_CHANNELS', 'REVIEW_MODE=on 时仅允许 mock 通道（审核期真实通道必须离线，AJ-30）');
  }

  // 2c. mock 密钥独立（P1-4）：与 JWT_SECRET 相同 = 回调验签挂在登录密钥上，轮换/泄露互相牵连
  if (c.MOCK_CALLBACK_SECRET !== undefined && c.MOCK_CALLBACK_SECRET === c.JWT_SECRET) {
    add(
      'MOCK_CALLBACK_SECRET',
      'MOCK_CALLBACK_SECRET 不得与 JWT_SECRET 相同（泄露半径与轮换周期都不同）',
    );
  }

  // 3. 启用真实通道就必须有对应密钥：缺密钥的表现是"下单报 500"，而不是"启动时告诉我少配了东西"
  if (isProd) {
    if (c.PAYMENT_CHANNELS.includes('stripe')) {
      if (c.STRIPE_SECRET_KEY === undefined) {
        add('STRIPE_SECRET_KEY', '启用了 stripe 通道：生产环境必须配置 STRIPE_SECRET_KEY');
      }
      if (c.STRIPE_WEBHOOK_SECRET === undefined) {
        add(
          'STRIPE_WEBHOOK_SECRET',
          '启用了 stripe 通道：生产环境必须配置 STRIPE_WEBHOOK_SECRET（回调验签）',
        );
      }
      // D-49 的 H5 收银依赖它拼支付链接；缺了的表现是"小程序外支付链接拼不出来"——运行时才暴露
      if (c.CHECKOUT_BASE_URL === undefined) {
        add(
          'CHECKOUT_BASE_URL',
          '启用了 stripe 通道：生产环境必须配置 CHECKOUT_BASE_URL（D-49 短链域名）',
        );
      }
    }
    // 生产启用 mock 只可能发生在审核模式（规则 1 已拦其它情况）：此时必须有**独立的**回调密钥
    if (c.PAYMENT_CHANNELS.includes('mock') && c.MOCK_CALLBACK_SECRET === undefined) {
      add(
        'MOCK_CALLBACK_SECRET',
        '生产环境启用 mock（审核模式）必须显式配置 MOCK_CALLBACK_SECRET，不得回落到开发占位值',
      );
    }
    if (c.PAYMENT_CHANNELS.includes('wechat')) {
      if (c.WECHAT_INSTITUTION_MERCHANT_ID === undefined) {
        add('WECHAT_INSTITUTION_MERCHANT_ID', '启用了 wechat 通道：生产环境必须配置机构商户号');
      }
      if (c.WECHAT_INSTITUTION_API_KEY === undefined) {
        add('WECHAT_INSTITUTION_API_KEY', '启用了 wechat 通道：生产环境必须配置机构 API Key');
      }
    }
    // 4. 生产连到本地库：漏配 DATABASE_URL 时最典型的静默错误——服务起得来、写的却是另一个库。
    //    N11：按 **URL hostname** 判定而不是正则碰运气——`[::1]`（IPv6 环回）与 127.x 整段
    //    都能绕过 `/(localhost|127\.0\.0\.1)/` 这类字面匹配。
    try {
      const host = new URL(c.DATABASE_URL).hostname.toLowerCase();
      if (host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.')) {
        add(
          'DATABASE_URL',
          '生产环境的 DATABASE_URL 不得指向本机（localhost / 127.x / ::1；漏配环境变量的典型症状）',
        );
      }
    } catch {
      // URL 解析失败说明它本就不像 postgres URL——由字段级 min(1) 之外的其他规则兜，这里不重复报
      add('DATABASE_URL', 'DATABASE_URL 不是合法的 URL 形状（postgresql://user@host:5432/db）');
    }
    // 4b. 生产对外 URL 必须 https（N11）：http 的支付短链/图片域名会被浏览器与渠道当钓鱼拦截
    for (const [key, value] of [
      ['CHECKOUT_BASE_URL', c.CHECKOUT_BASE_URL],
      ['IMG_BASE_URL', c.IMG_BASE_URL],
      ['PUBLIC_API_BASE', c.PUBLIC_API_BASE],
    ] as const) {
      if (value !== undefined && !value.startsWith('https://')) {
        add(key, `生产环境 ${key} 必须是 https（http 会被浏览器/渠道当不安全来源拦截）`);
      }
    }
    // 5. 生产必须声明 CORS 源：不声明 = 管理端所有跨域请求被拒，且只在浏览器里才看得出来
    if (c.CORS_ORIGINS.length === 0) {
      add('CORS_ORIGINS', '生产环境必须配置 CORS_ORIGINS（管理端 Web 的域名）');
    }
  }
});

export type AppConfig = z.infer<typeof schema>;

/**
 * schema 认识的全部环境变量名。
 * @why 供"`.env.example` ↔ schema 键集合必须一致"的测试使用。zod 默认 strip 未知键，
 *      所以**变量名拼错会被静默忽略**（`JWT_SECRECT=` 不报错、直接用默认值），
 *      单看代码永远发现不了——只能靠"文档里写的名字"和"代码认识的名字"做集合比对来兜。
 */
export const CONFIG_KEYS: readonly string[] = Object.keys(schema.shape);

/** 配置校验失败：携带结构化 issues，供启动日志一次列全（不逐个试错重启）。 */
export class ConfigError extends Error {
  constructor(
    message: string,
    /** 形如 `JWT_SECRET: 至少 32 字符…`；不含值本身（值可能是密钥）。 */
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 校验环境变量；任一项不合法即抛 `ConfigError`（**不做兜底默认值**）。
 * @param env 默认 process.env；测试注入用，保证纯函数可测。
 * @throws {ConfigError} 校验失败时，issues 里列出全部问题（不是第一条就停）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = crossField.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError('配置校验失败，服务拒绝启动', issues);
  }
  return parsed.data;
}

/**
 * 把配置对象中的密钥替换为 `***`，供日志与诊断安全输出。
 * @limitation 只掩码 `SECRET_KEYS` 里登记的键；新增密钥类环境变量必须同步加进去，否则会漏脱敏——
 *             这是"名单制"的固有缺点，替代方案（按值形如 sk_live_ 的模式匹配）会漏掉自造密钥格式，故仍用名单。
 */
export function redactConfig<T extends Record<string, unknown>>(
  config: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const key of SECRET_KEYS) {
    const value = out[key];
    if (typeof value === 'string' && value.length > 0) out[key] = '***';
  }
  return out;
}
