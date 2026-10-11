/**
 * 职责：本地一键启动（F17 单元①）核心逻辑的 L0 单测——不连库、不起服务、不动真 fs（除临时目录）。
 *
 * @why 编排层的失效形态全部是「不报错但做错事」：
 *      步骤乱序（没迁移就灌数据）、失败归因丢失（只说"失败了"不说卡在哪步）、
 *      .env 被覆盖（把用户改过的密钥冲掉）、闸门被改松（对着远程库建库）。
 *      这些只能靠注入每一步、用「有脾气的假实现」逐条钉死。
 *
 * @see scripts/dev-up-lib.ts（被测）；scripts/dev-up-lib.db.test.ts（真库全链路：建库→迁移→灌数据）
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DevUpStepError,
  devLinkHints,
  ensureDatabase,
  ensureEnvFile,
  localOsRole,
  materializeEnv,
  migrateUp,
  parseDevUpArgs,
  runSteps,
  type ConnectFn,
  type DevUpStep,
  type ExecFn,
} from './dev-up-lib.js';
import { defaultDevUrl } from './seed-lib.js';

/* ── 临时目录工具（ensureEnvFile 用真 fs：它不是三方依赖，按 T-3 用真的） ── */
const tmpRoots: string[] = [];
function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devup-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
});

const FILL = { dbUser: 'alice', jwtSecret: 's'.repeat(64) };

describe('parseDevUpArgs：命令行参数', () => {
  it('默认：灌 demo 数据（仅当库是空的，见 seedStep）+ 起服务、非 full、不强制重灌', () => {
    expect(parseDevUpArgs([])).toEqual({ full: false, seed: true, reseed: false, serve: true });
  });

  it('四个开关各自生效', () => {
    const base = { full: false, seed: true, reseed: false, serve: true };
    expect(parseDevUpArgs(['--full'])).toEqual({ ...base, full: true });
    expect(parseDevUpArgs(['--no-seed'])).toEqual({ ...base, seed: false });
    expect(parseDevUpArgs(['--no-serve'])).toEqual({ ...base, serve: false });
    // AJ-242：清空重灌必须显式要求（默认不再清一个已有数据的库）
    expect(parseDevUpArgs(['--reseed'])).toEqual({ ...base, reseed: true });
  });

  it('组合：--full --no-serve', () => {
    expect(parseDevUpArgs(['--full', '--no-serve'])).toEqual({
      full: true,
      seed: true,
      reseed: false,
      serve: false,
    });
  });

  it('--no-seed 与 --reseed 同时给：互相矛盾，响亮拒绝（不猜用户想要哪个）', () => {
    expect(() => parseDevUpArgs(['--no-seed', '--reseed'])).toThrow(
      /--no-seed.*--reseed|--reseed.*--no-seed/,
    );
  });

  it('不认识的参数响亮拒绝（手滑的 --no-ser 不该被静默忽略）', () => {
    expect(() => parseDevUpArgs(['--no-ser'])).toThrow(/--no-ser/);
  });
});

describe('localOsRole：本机角色名', () => {
  it('与 defaultDevUrl 同源（独立推导做参照，防"两处一起改错"）', () => {
    const independent = process.env.USER ?? process.env.LOGNAME ?? 'postgres';
    expect(localOsRole()).toBe(independent);
    expect(defaultDevUrl()).toContain(`postgresql://${independent}@`);
  });
});

describe('materializeEnv：把 .env.example 物化成可用的 .env', () => {
  /** 缺口评估：全新克隆后 WECHAT_DEV_LOGIN 为空，小程序登录直接 50000——本地模拟全流程的第一步就断。 */
  it('🔴 WECHAT_DEV_LOGIN 为空 → 填开发前缀；已有值不动', () => {
    expect(materializeEnv('WECHAT_DEV_LOGIN=   # 注释', FILL)).toMatch(/^WECHAT_DEV_LOGIN=dev-/);
    expect(materializeEnv('WECHAT_DEV_LOGIN=mine', FILL)).toBe('WECHAT_DEV_LOGIN=mine');
    expect(materializeEnv('MOCK_AUTO_CONFIRM=  # x', FILL)).toMatch(/^MOCK_AUTO_CONFIRM=on/);
  });

  const template = [
    '# 注释行',
    'NODE_ENV=development          # 带行内注释',
    'JWT_SECRET=                   # 自定义 token 密钥（openssl rand -hex 32）',
    'DATABASE_URL=postgresql://<user>@localhost:5432/japan_shop',
    'PAYMENT_CHANNELS=mock,stripe  # 通道',
    '',
  ].join('\n');

  it('替换 DATABASE_URL 行的 <user> 占位，行内其余不动', () => {
    const out = materializeEnv(template, FILL);
    expect(out).toContain('DATABASE_URL=postgresql://alice@localhost:5432/japan_shop');
    expect(out).not.toContain('<user>');
  });

  it('空 JWT_SECRET（哪怕后面跟注释）被填入', () => {
    const out = materializeEnv(template, FILL);
    expect(out).toContain(`JWT_SECRET=${'s'.repeat(64)}`);
  });

  it('已有值的 JWT_SECRET 一个字不动（绝不覆盖用户改过的密钥）', () => {
    const filled = template.replace(
      /^JWT_SECRET=.*$/m,
      'JWT_SECRET=my-own-secret-12345678901234567890',
    );
    const out = materializeEnv(filled, FILL);
    expect(out).toContain('JWT_SECRET=my-own-secret-12345678901234567890');
    expect(out).not.toContain('s'.repeat(64));
  });

  it('已是真实用户的 DATABASE_URL 不动', () => {
    const real = template.replace('<user>', 'bob');
    const out = materializeEnv(real, FILL);
    expect(out).toContain('DATABASE_URL=postgresql://bob@localhost:5432/japan_shop');
  });

  it('幂等：物化后的内容再跑一次 = 原样', () => {
    const once = materializeEnv(template, FILL);
    expect(materializeEnv(once, FILL)).toBe(once);
  });

  it('注释行与其他配置行一个字不动', () => {
    const out = materializeEnv(template, FILL);
    expect(out).toContain('# 注释行');
    expect(out).toContain('NODE_ENV=development          # 带行内注释');
    expect(out).toContain('PAYMENT_CHANNELS=mock,stripe  # 通道');
  });

  it('fill 形状不合法时拒绝（写进 .env 的坏值要到启动期才炸）', () => {
    expect(() =>
      materializeEnv(template, { dbUser: 'bad user!', jwtSecret: FILL.jwtSecret }),
    ).toThrow(/dbUser/);
    expect(() => materializeEnv(template, { dbUser: 'alice', jwtSecret: 'short' })).toThrow(/32/);
  });
});

describe('ensureEnvFile：.env 不存在则从模板物化', () => {
  it('.env 已存在 → exists 且内容一个字不动（哪怕里面还是占位符）', () => {
    const root = makeTmpRoot();
    writeFileSync(join(root, '.env'), 'JWT_SECRET=\n', 'utf8');
    const res = ensureEnvFile(root, FILL);
    expect(res.status).toBe('exists');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('JWT_SECRET=\n');
  });

  it('.env 不存在 → 从 .env.example 物化创建（占位被替换、权限 600）', () => {
    const root = makeTmpRoot();
    writeFileSync(
      join(root, '.env.example'),
      'JWT_SECRET=\nDATABASE_URL=postgresql://<user>@localhost:5432/japan_shop\n',
      'utf8',
    );
    const res = ensureEnvFile(root, FILL);
    expect(res.status).toBe('created');
    const content = readFileSync(res.path, 'utf8');
    expect(content).toContain(`JWT_SECRET=${'s'.repeat(64)}`);
    expect(content).toContain('postgresql://alice@');
    // .env 将含密钥：创建即 600，不依赖用户事后 chmod
    expect(statSync(res.path).mode & 0o777).toBe(0o600);
  });

  it('.env.example 也缺 → 抛错指名缺哪个文件', () => {
    const root = makeTmpRoot();
    expect(() => ensureEnvFile(root, FILL)).toThrow(/.env.example/);
  });
});

describe('ensureDatabase：安全闸门（复用 seed-lib，先拒再连）', () => {
  it('远程 host → 拒绝，且根本没发起连接', async () => {
    let connected = 0;
    const connect: ConnectFn = () => {
      connected += 1;
      return { query: async () => [], end: async () => {} };
    };
    await expect(
      ensureDatabase('postgresql://u@db.render.com:5432/japan_shop', { connect }),
    ).rejects.toThrow(/localhost/);
    expect(connected, '闸门必须在任何连接尝试之前生效').toBe(0);
  });

  it('prod 库名 → 拒绝，且根本没发起连接', async () => {
    let connected = 0;
    const connect: ConnectFn = () => {
      connected += 1;
      return { query: async () => [], end: async () => {} };
    };
    await expect(
      ensureDatabase('postgresql://u@localhost:5432/japan_shop_prod', { connect }),
    ).rejects.toThrow(/生产/);
    expect(connected).toBe(0);
  });
});

/** 有脾气的假连接：按 URL 与 SQL 决定行为，并记录全部调用供断言。 */
function fakeConnect(opts: {
  missingTarget?: boolean;
  refuseTarget?: boolean;
  existingInAdmin?: boolean;
}) {
  const calls: { url: string; sql: string[] }[] = [];
  const connect: ConnectFn = (url) => {
    const entry = { url, sql: [] as string[] };
    calls.push(entry);
    return {
      query: async (sql: string) => {
        entry.sql.push(sql);
        if (!url.endsWith('/postgres')) {
          if (opts.refuseTarget === true) {
            const err = new Error('connect ECONNREFUSED 127.0.0.1:5432') as Error & {
              code?: string;
            };
            err.code = 'ECONNREFUSED';
            throw err;
          }
          if (opts.missingTarget === true) {
            const err = new Error('database "japan_shop" does not exist') as Error & {
              code?: string;
            };
            err.code = '3D000';
            throw err;
          }
          return [];
        }
        if (sql.includes('pg_database')) return opts.existingInAdmin === true ? [{ x: 1 }] : [];
        return [];
      },
      end: async () => {},
    };
  };
  return { connect, calls };
}

describe('ensureDatabase：行为（假连接）', () => {
  const URL_LOCAL = 'postgresql://u@localhost:5432/japan_shop';

  it('目标库可连 → exists，且不碰管理库', async () => {
    const { connect, calls } = fakeConnect({});
    expect(await ensureDatabase(URL_LOCAL, { connect })).toBe('exists');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith('/postgres'), '可连时不该连管理库').toBe(false);
  });

  it('目标库不存在（3D000）→ 管理库建库 → created', async () => {
    const { connect, calls } = fakeConnect({ missingTarget: true });
    expect(await ensureDatabase(URL_LOCAL, { connect })).toBe('created');
    const admin = calls.find((c) => c.url.endsWith('/postgres'));
    expect(admin, '目标库缺失时必须连管理库').toBeDefined();
    expect(admin?.sql.some((s) => /create database japan_shop/.test(s))).toBe(true);
  });

  it('竞态：探测时缺失、管理库里已存在 → exists 且不发 CREATE', async () => {
    const { connect, calls } = fakeConnect({ missingTarget: true, existingInAdmin: true });
    expect(await ensureDatabase(URL_LOCAL, { connect })).toBe('exists');
    const admin = calls.find((c) => c.url.endsWith('/postgres'));
    expect(admin?.sql.some((s) => /create database/i.test(s))).toBe(false);
  });

  it('连不上（ECONNREFUSED）→ 报错含"Postgres 是否在运行"，且不尝试建库', async () => {
    const { connect, calls } = fakeConnect({ refuseTarget: true });
    await expect(ensureDatabase(URL_LOCAL, { connect })).rejects.toThrow(/Postgres 是否在运行/);
    expect(
      calls.some((c) => c.url.endsWith('/postgres')),
      '服务没起来时不该去建库——那不是"库不存在"',
    ).toBe(false);
  });

  it('库名形状异常 → 拒绝拼接进 SQL', async () => {
    const { connect } = fakeConnect({});
    await expect(
      ensureDatabase('postgresql://u@localhost:5432/weird-name', { connect }),
    ).rejects.toThrow(/形状/);
  });
});

describe('migrateUp：迁移子进程', () => {
  const OPTS = { root: '/repo', databaseUrl: 'postgresql://u@localhost:5432/japan_shop' };

  it('调 node-pg-migrate CLI：同一份 migrations 目录、up 方向、env 带 DATABASE_URL', async () => {
    const seen: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec: ExecFn = async (file, args, opts) => {
      seen.push({ file, args, env: opts.env });
      return { stdout: '', stderr: '' };
    };
    await migrateUp(OPTS, { exec });
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.args.join(' ')).toContain('node-pg-migrate');
    expect(call?.args.join(' ')).toContain('-m migrations up');
    expect(call?.env.DATABASE_URL).toBe(OPTS.databaseUrl);
  });

  it('CLI 失败 → 错误里必须带 stdout/stderr（D29：迁移失败看不到原因是最差的形态）', async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error('Command failed: exit 1'), {
        stdout: 'relation "products" already exists',
        stderr: 'some stderr detail',
      });
    };
    await expect(migrateUp(OPTS, { exec })).rejects.toThrow(/relation "products" already exists/);
  });
});

describe('runSteps：步骤编排', () => {
  function step(name: string, log: string[], opts: { fail?: boolean } = {}): DevUpStep {
    return {
      name,
      hint: `怎么办-${name}`,
      run: async () => {
        log.push(name);
        if (opts.fail === true) throw new Error(`炸了-${name}\n第二行`);
        return `完成-${name}`;
      },
    };
  }

  it('按序执行、按序回调、返回全部摘要', async () => {
    const log: string[] = [];
    const done: string[] = [];
    const results = await runSteps([step('a', log), step('b', log), step('c', log)], {
      onStepDone: (name, summary) => done.push(`${name}:${summary}`),
    });
    expect(log).toEqual(['a', 'b', 'c']);
    expect(done).toEqual(['a:完成-a', 'b:完成-b', 'c:完成-c']);
    expect(results.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('第二步失败 → DevUpStepError：点名步骤、带怎么办、completed 只含第一步', async () => {
    const log: string[] = [];
    let caught: unknown;
    try {
      await runSteps([step('a', log), step('b', log, { fail: true }), step('c', log)]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DevUpStepError);
    const err = caught as DevUpStepError;
    expect(err.stepName).toBe('b');
    expect(err.hint).toBe('怎么办-b');
    expect(err.completed).toEqual(['a']);
    expect(log, '失败步骤之后不能再跑').toEqual(['a', 'b']);
    // message 必须单行（会被 npm script 与终端直接读），且保留失败原因
    expect(err.message).not.toContain('\n');
    expect(err.message).toContain('炸了-b');
  });

  it('第一步就失败 → completed 为空', async () => {
    let caught: unknown;
    try {
      await runSteps([step('a', [], { fail: true })]);
    } catch (e) {
      caught = e;
    }
    expect((caught as DevUpStepError).completed).toEqual([]);
  });
});

/**
 * E-7（工程缺口 2026-10-08）：本地联调的两个"静默卡住"——起服务时把原因说出来。
 * @why 一：没开 MOCK_AUTO_CONFIRM 时小程序里模拟付款永远到不了"已付款"，看起来像 bug（走查实测撞过）；
 *      二：小程序开发版写死连 `http://localhost:3000`，服务起在别的端口时模拟器报 ERR_CONNECTION_REFUSED（用户 2026-10-09 撞过）。
 */
describe('devLinkHints：起服务时的联调提示（E-7）', () => {
  const base = {
    NODE_ENV: 'development' as const,
    PORT: 3000,
    PAYMENT_CHANNELS: ['mock' as const],
    REVIEW_MODE: 'off' as const,
    MOCK_AUTO_CONFIRM: 'on' as const,
  };
  const MINI = 'http://localhost:3000';

  it('默认组合（3000 + 模拟付款自动确认）→ 没有提示', () => {
    expect(devLinkHints(base, MINI)).toEqual([]);
  });

  it('mock 通道开着但没开 MOCK_AUTO_CONFIRM → 提示怎么开', () => {
    const h = devLinkHints({ ...base, MOCK_AUTO_CONFIRM: undefined }, MINI);
    expect(h).toHaveLength(1);
    expect(h[0]).toContain('MOCK_AUTO_CONFIRM=on');
  });

  it('审核模式开着时不提示（审核期 mock 会话本来就由审核员手动确认）；没开 mock 通道也不提示', () => {
    expect(
      devLinkHints({ ...base, MOCK_AUTO_CONFIRM: undefined, REVIEW_MODE: 'on' }, MINI),
    ).toEqual([]);
    expect(
      devLinkHints(
        { ...base, MOCK_AUTO_CONFIRM: undefined, PAYMENT_CHANNELS: ['stripe' as const] },
        MINI,
      ),
    ).toEqual([]);
  });

  it('服务端口与小程序开发版地址不一致 → 提示两边各是多少、改哪里', () => {
    const h = devLinkHints({ ...base, PORT: 3001 }, MINI);
    expect(h).toHaveLength(1);
    expect(h[0]).toContain('3001');
    expect(h[0]).toContain('http://localhost:3000');
    expect(h[0]).toContain('miniprogram/config.js');
  });
});
