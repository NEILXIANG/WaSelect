/**
 * 职责：本地一键启动（F17 单元①）的核心逻辑——参数解析、.env 物化、建库、迁移、步骤编排。
 *      与 CLI 薄壳（dev-up.ts）分离，好让每一步都能被单测/真库测试直接调用。
 *
 * 链路：.env（缺则从 .env.example 物化）→ 建库（缺则创建）→ 迁移（真 CLI）→ 灌数据 → 起服务。
 *
 * @why 安全闸门**复用** seed-lib 的 `assertSafeTarget` 而不是写第三份：
 *      「只碰本机、拒 prod 库名」是全仓库一条口径，复制必漂移（seed-lib @limitation 二
 *      已经留了两份清表名单的教训——能 import 解决的就不要复制）。
 *
 * @why 建库自动做：「新机器照 README 从零跑通」（F17 验收标准）的前提是库里得有库。
 *      本机 + 拒 prod 两道闸门在前，自动建库的风险面只剩「在本机多建一个空库」，可逆且廉价。
 *
 * @why 迁移走 **CLI 子进程**而不是 node-pg-migrate 的可编程 API：
 *      与 test/db/test-db.ts 的 `runMigrations` 同一口径——生产（npm run db:migrate）走的就是
 *      这个 CLI，可编程 API 是第二条没被人天天踩的路径。@limitation 这是第三处调用同一 CLI
 *      的代码（另两处：package.json script、test-db.ts），参数构造各自一份；
 *      抽公共要动测试基础设施，风险高于收益，改一处必须想到另两处。
 *
 * @limitation 一：起服务**在进程内**调 `bootstrap()`（dev-up.ts），不开子进程。
 *              信号处理复用 server 已测过的 `installShutdownHandlers`；
 *              代价是没有 watch 模式（改代码要重跑 npm run dev）。
 *              若将来要 watch，须加 spawn 层**并补信号转发测试**——那是目前不存在的一条未测路径。
 * @limitation 二：materializeEnv 只认「占位/空值」，不做任意键的覆盖——
 *              它存在的全部理由是让**首次**克隆能零配置跑起来，不是配置管理器。
 *
 * @see scripts/dev-up.ts（CLI 入口）；scripts/seed-lib.ts（闸门与灌数据）；docs/地基搭建清单.md F17
 */
import { execFile } from 'node:child_process';
import { applyFxBuffer } from '../server/src/domain/fx-input.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDb, type Db } from '../server/src/adapters/db.js';
import { assertSafeTarget, defaultDevUrl, seedOnce } from './seed-lib.js';

/* ── 命令行参数 ─────────────────────────────────────────────────────────── */

export interface DevUpOptions {
  /** 灌完整商品目录（默认 demo 小店）。 */
  full: boolean;
  /** 是否灌假数据（默认 true；但**只在库里还没有商品时**才真的灌，见 `seedStep`）。 */
  seed: boolean;
  /** 清空业务表后重灌（显式要求才做；会过内容闸门，库里有真订单就拒绝）。 */
  reseed: boolean;
  /** 是否最后起服务（--no-serve = 只准备环境）。 */
  serve: boolean;
}

const KNOWN_ARGS = ['--full', '--no-seed', '--reseed', '--no-serve'] as const;

export function parseDevUpArgs(argv: readonly string[]): DevUpOptions {
  const unknown = argv.filter((a) => !(KNOWN_ARGS as readonly string[]).includes(a));
  if (unknown.length > 0) {
    // 手滑的 --no-ser 若被静默忽略，用户会以为服务没起是 bug——不认识的参数必须响亮
    throw new Error(`不认识的参数：${unknown.join(' ')}（只支持 ${KNOWN_ARGS.join(' / ')}）`);
  }
  if (argv.includes('--no-seed') && argv.includes('--reseed')) {
    // 一个说"别灌"，一个说"清空重灌"——不猜用户想要哪个
    throw new Error('--no-seed 与 --reseed 互相矛盾：只能给其中一个');
  }
  return {
    full: argv.includes('--full'),
    seed: !argv.includes('--no-seed'),
    reseed: argv.includes('--reseed'),
    serve: !argv.includes('--no-serve'),
  };
}

/* ── 灌数据这一步 ───────────────────────────────────────────────────────── */

/**
 * "灌假数据"这一步：**库里已有商品就跳过**，只有显式 `--reseed` 才清空重灌（AJ-242）。
 *
 * @returns 给用户看的一句话（灌了什么 / 为什么跳过）
 *
 * @why `npm run dev` 原先每次都 `seedOnce`——它会先清空全部业务表。B31（AJ-184）为防"端口转发到生产时清库"
 *      加了内容闸门：库里有 `is_test=false` 的订单或非 mock 的支付行就拒绝清表。
 *      但那条闸门的前提——"dev 库的订单只可能是 is_test=true"——不成立：`is_test` 取自 `REVIEW_MODE`，
 *      默认 off，本地下的每一张单都是 `is_test=false`。于是本地下过一张单之后，
 *      下一次 `npm run dev` 就抛"拒绝清表"，服务起不来。
 *      @measured(dev-up-lib.db.test.ts「默认：库里已有商品数据」, 2026-09-30)：
 *        修复前同样的步骤（灌好的库 + 一张 is_test=false 的单 → 再跑一次默认流程）得到 `拒绝清表：库里有 1 张…`。
 * @why 修法是**默认不清一个已有数据的库**，而不是给闸门加 `--force`：
 *      "每次启动都清空你昨天的测试数据"本来就不是开发者想要的默认行为；
 *      而内容闸门存在的唯一理由是没有后门（seed-lib.ts @limitation 三），不能为了日常开发把它拆掉。
 * @why 以"有没有商品"判断是否已灌过：商品是 demo 数据里一定会有的东西，也是服务能不能用的前提；
 *      订单 / 用户可能被开发者清过，不适合作为判据。
 * @limitation 库里有商品但数据是"坏的"（手工改乱了）时不会自动修复——`--reseed` 就是为此准备的；
 *              若届时被内容闸门拒绝，说明库里有本地下过的真订单：先删掉它们（或换一个库）再重灌。
 */
export async function seedStep(db: Db, opts: { full: boolean; reseed: boolean }): Promise<string> {
  if (!opts.reseed) {
    const rows = await db<{ yes: boolean }[]>`select exists(select 1 from products) as yes`;
    if (rows[0]?.yes === true) {
      return '库里已有商品数据，跳过灌数（你的订单与改动都保留）；要清空重灌请加 --reseed';
    }
  }
  const { bundle, counts } = await seedOnce(db, { full: opts.full });
  return (
    `已灌入「${bundle.name}」：` +
    `users=${counts.users} products=${counts.products} shipping_rates=${counts.shippingRates}`
  );
}

/* ── .env 物化 ──────────────────────────────────────────────────────────── */

/**
 * 本机 OS 角色名（物化 DATABASE_URL 占位用）。
 * @why 单一来源是 seed-lib 的 `defaultDevUrl()`——它本就是「本机 dev 库连接串长什么样」的
 *      唯一答案（USER / LOGNAME → postgres），这里只把角色名从里面取出来，不抄第三份推导。
 */
export function localOsRole(): string {
  return new URL(defaultDevUrl()).username;
}

/**
 * 把 .env.example 物化成可直接用的 .env 内容。
 * 只做两件事：DATABASE_URL 行的 `<user>` 占位 → 真实角色；空 JWT_SECRET → 生成值。
 * 其余行（含已有值的同名键）一个字不动。
 *
 * @why 幂等是硬要求：物化后的内容再喂进来必须原样返回——
 *      「覆盖用户改过的密钥」是这类工具最贵的失败形态（不报错，但登录/验签全失效）。
 */
export function materializeEnv(
  template: string,
  fill: { dbUser: string; jwtSecret: string },
): string {
  // 写进 .env 的就是配置：坏值不在此拦，就要到 loadConfig 启动期才炸，且指向不明
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(fill.dbUser)) {
    throw new Error(`dbUser 形状不合法，拒绝写入 .env：${fill.dbUser.slice(0, 20)}`);
  }
  if (fill.jwtSecret.length < 32 || /\s/.test(fill.jwtSecret)) {
    throw new Error('jwtSecret 至少 32 字符且不含空白（config.ts 的硬门槛）');
  }
  return template
    .split('\n')
    .map((line) => {
      if (/^DATABASE_URL=/.test(line) && line.includes('<user>')) {
        return line.replaceAll('<user>', fill.dbUser);
      }
      // 「空值」= 等号后只有空白 + 可选的行内注释；已有值的行不匹配、不动
      if (/^JWT_SECRET=[ \t]*(#[^\n]*)?$/.test(line)) {
        return `JWT_SECRET=${fill.jwtSecret}  # 由 npm run dev 生成（仅本地开发；可按需自行更换）`;
      }
      // 开发登录替身（缺口评估）：空着时小程序登录直接 50000，本地模拟全流程第一步就断。
      //    只写进本地 .env；staging / production 配了它会被 config.ts 拒绝启动
      if (/^MOCK_AUTO_CONFIRM=[ \t]*(#[^\n]*)?$/.test(line)) {
        return 'MOCK_AUTO_CONFIRM=on  # 由 npm run dev 填写：模拟付款自动确认（仅本地）';
      }
      if (/^WECHAT_DEV_LOGIN=[ \t]*(#[^\n]*)?$/.test(line)) {
        return 'WECHAT_DEV_LOGIN=dev-  # 由 npm run dev 填写：开发者工具里的 wx.login code 拼成 openid（仅本地）';
      }
      return line;
    })
    .join('\n');
}

export interface EnsureEnvResult {
  status: 'exists' | 'created';
  path: string;
}

/**
 * .env 不存在则从 .env.example 物化创建；已存在则**一个字不动**。
 * @why 新建即 0600：.env 从诞生起就含 JWT_SECRET，不能依赖用户事后记得 chmod。
 */
export function ensureEnvFile(
  root: string,
  fill: { dbUser: string; jwtSecret: string },
): EnsureEnvResult {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) return { status: 'exists', path: envPath };
  const examplePath = join(root, '.env.example');
  if (!existsSync(examplePath)) {
    throw new Error(`缺少模板 ${examplePath}：一键启动靠它物化 .env，请先恢复该文件`);
  }
  const materialized = materializeEnv(readFileSync(examplePath, 'utf8'), fill);
  writeFileSync(envPath, materialized, { mode: 0o600 });
  return { status: 'created', path: envPath };
}

/* ── 建库 ───────────────────────────────────────────────────────────────── */

/** 最小连接抽象：只要「发一条 SQL」与「关掉」两个动作，好让单测能注入有脾气的假实现。 */
export interface DbProbe {
  query(sql: string): Promise<unknown[]>;
  end(): Promise<void>;
}
export type ConnectFn = (url: string) => DbProbe;

/** 默认真实连接：postgres.js 是懒连接，真正的连接发生在第一条 query。 */
const realConnect: ConnectFn = (url) => {
  const db = createDb({ url, max: 1 });
  return {
    query: async (sql) => {
      const rows = await db.unsafe(sql);
      return Array.from(rows as Iterable<unknown>);
    },
    end: async () => {
      await db.end();
    },
  };
};

const DB_NAME_SHAPE = /^[a-z_][a-z0-9_]*$/;
/** PG 错误码：3D000 = 数据库不存在；42P04 = 数据库已存在（建库竞态）。 */
const ERR_DATABASE_MISSING = '3D000';
const ERR_DATABASE_DUPLICATE = '42P04';

function pgCode(e: unknown): string | undefined {
  return (e as { code?: unknown } | null)?.code as string | undefined;
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

/**
 * 确保目标库存在：能连上 → 'exists'；库不存在（3D000）→ 连管理库创建 → 'created'。
 *
 * @why 先连目标库、只在「库不存在」时才去建：**连不上**（Postgres 没起、端口错、口令错）
 *      与**库不存在**是两种完全不同的病，前者去建库只会得到另一个看不懂的错误。
 * @why 库名形状白名单：CREATE DATABASE 不能参数化，只能拼接——
 *      库名又来自 URL（用户可控），所以拼之前必须卡死形状。
 * @limitation 建库与探测之间存在竞态（两个 dev-up 同时跑）：pg_database 检查 + 42P04 容忍
 *              已覆盖；结果只是某一边多连了一次管理库，无害。
 */
export async function ensureDatabase(
  url: string,
  deps: { connect?: ConnectFn } = {},
): Promise<'exists' | 'created'> {
  assertSafeTarget(url); // 闸门①②：只碰本机、拒 prod（seed-lib 的唯一实现，先拒再连）
  const connect = deps.connect ?? realConnect;
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!DB_NAME_SHAPE.test(dbName)) {
    throw new Error(`库名形状异常，拒绝拼接进 SQL：${dbName}`);
  }

  let missing = false;
  const target = connect(url);
  try {
    await target.query('select 1');
  } catch (e) {
    if (pgCode(e) !== ERR_DATABASE_MISSING) {
      throw new Error(
        `连不上数据库（${oneLine(errMessage(e))}）。本机 Postgres 是否在运行？` +
          `（例如 brew services start postgresql@16）`,
      );
    }
    missing = true;
  } finally {
    await target.end().catch(() => undefined);
  }
  if (!missing) return 'exists';

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = connect(adminUrl.toString());
  try {
    const rows = await admin.query(`select 1 from pg_database where datname = '${dbName}'`);
    if (rows.length > 0) return 'exists'; // 竞态：探测之后别人建好了
    try {
      await admin.query(`create database ${dbName}`);
    } catch (e) {
      if (pgCode(e) !== ERR_DATABASE_DUPLICATE) throw e; // 竞态：检查之后别人建了
    }
    return 'created';
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/* ── 迁移（真 CLI 子进程） ──────────────────────────────────────────────── */

export type ExecFn = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const realExec: ExecFn = (file, args, opts) =>
  new Promise((resolvePromise, reject) => {
    execFile(file, [...args], opts, (error, stdout, stderr) => {
      if (error !== null) {
        // execFile 的异步错误**不自带** stdout/stderr（同步版才带）——手动挂上，否则 D29 重演
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

/**
 * 跑一次 `node-pg-migrate up`（幂等：已应用的自然跳过）。
 * @why 失败时把 stdout/stderr 原样带上（D29）：「迁移失败」四个字没有任何价值，
 *      价值全在 CLI 打出来的那条 PG 错误里。
 */
export async function migrateUp(
  opts: { root: string; databaseUrl: string },
  deps: { exec?: ExecFn } = {},
): Promise<void> {
  const exec = deps.exec ?? realExec;
  const bin = resolve(opts.root, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
  try {
    await exec(process.execPath, [bin, '-m', 'migrations', 'up'], {
      cwd: opts.root,
      env: { ...process.env, DATABASE_URL: opts.databaseUrl },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = [err.stdout, err.stderr]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
    throw new Error(
      `迁移失败：${err.message ?? String(e)}${detail.length > 0 ? `\n${detail}` : ''}`,
    );
  }
}

/* ── 步骤编排 ───────────────────────────────────────────────────────────── */

export interface DevUpStep {
  /** 步骤名：失败时点名用（「数据库可达」比「步骤 2」有用得多）。 */
  name: string;
  /** 失败时告诉人「怎么办」：一句话，指向可单独验证该步的命令或动作。 */
  hint: string;
  /** 执行体；返回单行结果摘要（给 onStepDone 与终端回显）。 */
  run: () => Promise<string>;
}

/** 步骤失败：点名卡在哪一步、之前成了哪几步、该怎么办。 */
export class DevUpStepError extends Error {
  readonly stepName: string;
  readonly hint: string;
  readonly completed: readonly string[];
  constructor(step: DevUpStep, completed: readonly string[], cause: unknown) {
    // message 必须单行：它会被 npm script 与终端直接读；多行细节留在 cause 里
    super(`步骤「${step.name}」失败：${oneLine(errMessage(cause))}`, { cause });
    this.name = 'DevUpStepError';
    this.stepName = step.name;
    this.hint = step.hint;
    this.completed = completed;
  }
}

/**
 * 按序执行步骤；任何一步失败即停（后面的不再跑），抛出 DevUpStepError。
 * @why 失败即停而不是继续：后续步骤依赖前序产物（没迁移就灌数据 = 第二轮更难懂的错误）。
 */
export async function runSteps(
  steps: readonly DevUpStep[],
  hooks: { onStepDone?: (name: string, summary: string) => void } = {},
): Promise<{ name: string; summary: string }[]> {
  const done: { name: string; summary: string }[] = [];
  for (const step of steps) {
    let summary: string;
    try {
      summary = await step.run();
    } catch (e) {
      throw new DevUpStepError(
        step,
        done.map((d) => d.name),
        e,
      );
    }
    done.push({ name: step.name, summary });
    hooks.onStepDone?.(step.name, summary);
  }
  return done;
}

/* ── 开发汇率 ───────────────────────────────────────────────────────────── */

/**
 * 开发库的展示汇率（日元 → 外币）。只给本地报价用，**不是**真实汇率。
 * @why 本地演练实测（2026-10-06）：开发库的汇率是灌数那天录的，超过 FX_MAX_AGE_HOURS（72h）后
 *      报价一律 50003（这是生产要的保护）；全新克隆则根本没有汇率。本地每次 `npm run dev` 补一条，
 *      避免"隔了三天再开发，整店报价全挂"。
 */
const DEV_FX: Readonly<Record<string, number>> = { USD: 0.0068, CNY: 0.0495 };

/**
 * 没有或已过期的币种补一条开发汇率（effective_from = now，按 FX_BUFFER_RATE 套缓冲，created_by = dev-up）。
 * @returns 给终端看的一句话
 * @limitation 只在 `npm run dev` 里调用；生产汇率只由管理端录入（没有自动拉取，见缺口清单）。
 */
export async function ensureDevFxStep(
  db: Db,
  maxAgeHours: number,
  /**
   * 缓冲比例（= FX_BUFFER_RATE，缺省 0.03）。三端联动 UI 模拟 2026-10-08：原先写死 buffer = 0、生效汇率 = 原始汇率，
   * 管理端汇率表显示"缓冲 0"，本地报价比生产口径低 3%——本地看到的价格不是线上会看到的价格。
   */
  buffer = 0.03,
): Promise<string> {
  const added: string[] = [];
  for (const [quote, raw] of Object.entries(DEV_FX)) {
    // 与管理端录入同一个换算（domain/fx-input.ts applyFxBuffer），不另写一份
    const rate = applyFxBuffer(raw, buffer);
    const fresh = await db`
      select 1 from fx_rates
       where quote = ${quote} and effective_from <= now()
         and effective_from > now() - make_interval(hours => ${maxAgeHours})
       limit 1`;
    if (fresh.length > 0) continue;
    await db`
      insert into fx_rates (quote, rate, raw_rate, buffer, effective_from, created_by)
      values (${quote}, ${rate}, ${raw}, ${buffer}, now(), 'dev-up')`;
    added.push(quote);
  }
  return added.length === 0
    ? '汇率都在有效期内，无需补录'
    : `已补录开发汇率 ${added.join(' / ')}（仅本地报价用，不是真实汇率）`;
}

/**
 * 起服务时的联调提示（E-7，工程缺口 2026-10-08）：把两种"静默卡住"在启动那一刻说出来。
 *
 * @why 一：开发环境开着 mock 通道却没开 `MOCK_AUTO_CONFIRM` 时，小程序里的模拟付款永远到不了"已付款"
 *      （pay-plan 判 unsupported），看起来像 bug——走查当天靠仓库外的临时脚本打开才走通。
 *      新生成的 .env 会自动填 on，但**老的 .env 不会被改**（ensureEnvFile 已有一个字不动），所以要提示。
 * @why 二：小程序开发版写死连 `API_BASES.develop`（`http://localhost:3000`），服务起在别的端口时
 *      开发者工具只报 ERR_CONNECTION_REFUSED，不说是端口对不上（用户 2026-10-09 撞过）。
 * @limitation 只提示、不改任何配置：端口与开关都是开发者自己的选择（例如同时起两套服务就得用两个端口）。
 * @param cfg 生效后的配置（bootstrap 之后的 runtime.config）
 * @param miniDevelopBase 小程序开发版的 API 根地址（miniprogram/config.js `API_BASES.develop`）
 * @returns 要打印的提示行；空数组 = 一切对得上
 */
export function devLinkHints(
  cfg: {
    NODE_ENV: string;
    PORT: number;
    PAYMENT_CHANNELS: readonly string[];
    REVIEW_MODE: string;
    MOCK_AUTO_CONFIRM?: string | undefined;
  },
  miniDevelopBase: string,
): string[] {
  const hints: string[] = [];
  if (
    cfg.NODE_ENV === 'development' &&
    cfg.PAYMENT_CHANNELS.includes('mock') &&
    cfg.REVIEW_MODE !== 'on' &&
    cfg.MOCK_AUTO_CONFIRM !== 'on'
  ) {
    hints.push(
      '小程序里的模拟付款不会自动变成"已付款"：要走通付款，在 .env 里设 MOCK_AUTO_CONFIRM=on 后重启（只在本地生效）',
    );
  }
  let miniPort = '';
  try {
    const u = new URL(miniDevelopBase);
    miniPort = u.port !== '' ? u.port : u.protocol === 'https:' ? '443' : '80';
  } catch {
    miniPort = '';
  }
  if (miniPort !== '' && miniPort !== String(cfg.PORT)) {
    hints.push(
      `服务起在 :${String(cfg.PORT)}，而小程序开发版连的是 ${miniDevelopBase}——模拟器会报 ERR_CONNECTION_REFUSED。` +
        `二选一：把 .env 的 PORT 改回 ${miniPort}，或在本地改 miniprogram/config.js 的 API_BASES.develop（不要提交）`,
    );
  }
  return hints;
}
