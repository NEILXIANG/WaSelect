/**
 * 职责：`resolveStorage` 的单测——钉住"**哪个环境用哪个驱动**"这一层。
 *
 * @why 这一层此前没有任何用例，而它是配置语义的另一半：config.ts 管"值合不合法"，
 *      这里管"值意味着什么"。它判错的表现不是报错——是**换了个驱动**：
 *      生产漏配 → null（上传 50000，响亮）尚可；但如果将来有人把生产缺省改成 fs，
 *      表现就变成"上传成功、随后图静默消失"，且没有任何一方报错。
 *      这种失效只能靠"给定环境、断言拿到的是哪个驱动"来钉。
 *
 * @why 用**行为探针**判断拿到的是哪一个驱动（出网的是 r2、落盘的是 fs、都没有的是 memory），
 *      而不是断言实例身份：三个驱动都只是 `{ put, delete }`，没有任何可辨识的标记，
 *      断言身份就得给生产代码加仅供测试的字段——那是为测试污染实现。
 *      行为探针顺带把"这个驱动真的能用"也一起验了。
 *
 * @limitation fs 分支会往临时目录写一个文件（不是纯内存用例）：fs 驱动的职责就是落盘，
 *      不落盘就验不到它。每条用例一个独立临时目录、用后即删，不污染仓库也不互相污染。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest, HttpResponse } from '../ports/http-client.js';
import { loadConfig } from '../config.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { resolveStorage } from './storage.js';

/** 最小可启动环境（与 config.unit.test.ts 同口径）。 */
const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://app@localhost:5432/japan_shop',
  JWT_SECRET: 'a'.repeat(32),
  PAYMENT_CHANNELS: 'mock,stripe',
  TERMS_VERSION: 'TOS-2026-09-20',
};

const r2Full: NodeJS.ProcessEnv = {
  R2_ACCOUNT_ID: 'r2-account-id-like',
  R2_ACCESS_KEY_ID: 'r2-access-key-id-like',
  R2_SECRET_ACCESS_KEY: 'r2-secret-access-key-like',
  R2_BUCKET: 'jp-shop-images',
};

/**
 * 一套**完整合法**的生产环境（与 config.unit.test.ts 的 prod 夹具同口径）。
 * @why production 有独立的跨字段规则（APP_ID / CORS / stripe 三件套…），
 *      用最小环境去测"生产未配置存储 → null"会先被别的规则拒掉，
 *      于是红的不是被测的那件事——这是配置类用例最容易踩的假信号。
 */
const prodEnv: NodeJS.ProcessEnv = {
  ...baseEnv,
  NODE_ENV: 'production',
  APP_ID: 'wx-prod-like',
  APP_SECRET: 'prod-like-app-secret',
  DATABASE_URL: 'postgresql://app@db.internal:5432/japan_shop',
  PAYMENT_CHANNELS: 'stripe',
  STRIPE_SECRET_KEY: 'sk_live_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  // ⚠️ 生产夹具必须是**真实形态**的域名：`*.example.com` 是保留/占位域，
  //    会被配置层规则 4c（AJ-375）拒启，失败的就不是本文件要测的那件事了。
  CHECKOUT_BASE_URL: 'https://checkout.waselect.jp',
  CORS_ORIGINS: 'https://admin.waselect.jp',
  SENTRY_DSN: 'https://abc123@o1.ingest.sentry.io/42', // config 规则 9b：生产至少一个告警通道
};

const KEY = 'img/probe/detail.webp';

/** 假出站：只记录调用，不出网（外网闸门 AJ-56）。 */
function recordingHttp(): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    http: {
      async send(req) {
        calls.push(req);
        return { status: 200, body: '', headers: {} } satisfies HttpResponse;
      },
    },
  };
}

/**
 * 解析出驱动并**用行为判断它是哪一个**。
 *
 * @why 见文件头 @why：三个驱动没有可辨识的身份标记，只能靠副作用区分。
 * @why 每条用例一个**独立**临时目录：共用一个目录的话，先跑的 fs 用例留下的文件
 *      会让后跑的 memory 用例被误判成 fs（"没写盘"必须是从空目录看出来的结论）。
 */
async function resolveAndProbe(extra: NodeJS.ProcessEnv): Promise<'r2' | 'fs' | 'memory' | 'null'> {
  const dir = mkdtempSync(join(tmpdir(), 'storage-probe-'));
  try {
    const f = recordingHttp();
    const storage = resolveStorage(loadConfig({ ...baseEnv, ...extra, STORAGE_FS_DIR: dir }), {
      http: f.http,
      clock: fixedClock('2026-10-01T00:00:00.000Z'),
    });
    if (storage === null) return 'null';
    await storage.put(KEY, Buffer.from('probe-bytes'), 'image/webp');
    if (f.calls.length > 0) return 'r2';
    if (existsSync(join(dir, ...KEY.split('/')))) return 'fs';
    return 'memory';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolveStorage：显式驱动优先于环境缺省', () => {
  it('STORAGE_DRIVER=memory → memory 驱动（不出网、不落盘）', async () => {
    expect(await resolveAndProbe({ NODE_ENV: 'test', STORAGE_DRIVER: 'memory' })).toBe('memory');
  });

  it('STORAGE_DRIVER=fs → fs 驱动（写盘生效）', async () => {
    expect(await resolveAndProbe({ NODE_ENV: 'test', STORAGE_DRIVER: 'fs' })).toBe('fs');
  });

  it('STORAGE_DRIVER=r2 且四要素齐 → r2 驱动（走了出站，而不是落到本地盘）', async () => {
    expect(await resolveAndProbe({ NODE_ENV: 'test', STORAGE_DRIVER: 'r2', ...r2Full })).toBe('r2');
  });

  /**
   * @why test 环境显式选 fs 也要生效：开发期要能"上传 → 文件在 → 管理端能预览"，
   *      若环境缺省把显式配置盖掉，开发期看到的永远是 memory，链路验不出来。
   */
  it('test 环境 + 显式 fs → 仍是 fs（显式配置不被环境缺省覆盖）', async () => {
    expect(await resolveAndProbe({ NODE_ENV: 'test', STORAGE_DRIVER: 'fs' })).toBe('fs');
  });
});

describe('resolveStorage：环境缺省', () => {
  it('NODE_ENV=test 未配置 → memory（测试不碰盘不碰网）', async () => {
    expect(await resolveAndProbe({ NODE_ENV: 'test' })).toBe('memory');
  });

  it('NODE_ENV=development 未配置 → fs（开发期要能预览）', async () => {
    expect(await resolveAndProbe({ NODE_ENV: 'development' })).toBe('fs');
  });

  /**
   * @why null 而不是降级 fs：Render 的盘易失，"上传成功、随后图静默消失"没有任何一方报错。
   *      null 由上传路由 50000 响亮拒绝——与 wechat 未配置的同款处理。
   */
  it('NODE_ENV=production 未配置 → null（不静默降级到易失盘）', async () => {
    expect(await resolveAndProbe(prodEnv)).toBe('null');
  });

  it('NODE_ENV=staging 未配置 → null（同 production：公网环境不回落易失盘）', async () => {
    // staging 启用 mock 必须显式密钥（P3-7），否则失败的是别的规则，测不到存储这一件事
    expect(
      await resolveAndProbe({
        NODE_ENV: 'staging',
        MOCK_CALLBACK_SECRET: 'explicit-mock-callback-secret-32ch',
      }),
    ).toBe('null');
  });
});

describe('resolveStorage：fs 根目录缺省', () => {
  const f = recordingHttp();
  const deps = { http: f.http, clock: fixedClock('2026-10-01T00:00:00.000Z') };

  /**
   * @why 这两条**不落盘**（只断言拿到了驱动）：缺省目录是 `./var/uploads`（进程 cwd 相对），
   *      真去 put 会在仓库里留下文件。这里要覆盖的是"`STORAGE_FS_DIR` 没配时走缺省"这个分支，
   *      不是"写盘成功"（后者由第一条 fs 用例用临时目录钉住）。
   */
  it('显式 fs 且未配 STORAGE_FS_DIR → 用缺省目录（不静默拒绝）', () => {
    const cfg = loadConfig({ ...baseEnv, NODE_ENV: 'test', STORAGE_DRIVER: 'fs' });
    expect(cfg.STORAGE_FS_DIR).toBeUndefined();
    expect(resolveStorage(cfg, deps)).toMatchObject({ put: expect.any(Function) });
  });

  it('development 缺省 fs 且未配 STORAGE_FS_DIR → 同样用缺省目录', () => {
    const cfg = loadConfig({ ...baseEnv, NODE_ENV: 'development' });
    expect(resolveStorage(cfg, deps)).toMatchObject({ put: expect.any(Function) });
  });
});

describe('resolveStorage：r2 缺要素时不静默补默认值', () => {
  const f = recordingHttp();
  const deps = { http: f.http, clock: fixedClock('2026-10-01T00:00:00.000Z') };

  /**
   * 先拿一份**已通过** config 的 AppConfig，再在它上面抠掉字段。
   *
   * @why 不走 `loadConfig`：config 的跨字段规则 1d-2 会**先**拒（那道闸由 config.unit.test.ts 钉），
   *      于是这里永远测不到 `resolveStorage` 自己的第二道闸。装配层拿到的是 AppConfig，
   *      凡是"直接构造 AppConfig 的调用方"（测试装配、将来可能的插件式装配）都不经过 config
   *      ——第二道闸正是为它们存在的，必须单独钉。
   */
  const ok = loadConfig({ ...baseEnv, NODE_ENV: 'test', STORAGE_DRIVER: 'r2', ...r2Full });

  /**
   * @why `needed` 抛而不是 `String(x)`：写 `String` 会把 undefined 变成字符串 `"undefined"`，
   *      于是请求打到一个长得合法的端点上，报错是 403/404——排障被带到"凭据错了"，
   *      而实际是"根本没配"。
   */
  it('缺 R2_BUCKET → 抛 r2_storage_config_missing（指名道姓，不是泛化 500）', () => {
    expect(() => resolveStorage({ ...ok, R2_BUCKET: undefined }, deps)).toThrow(
      /r2_storage_config_missing:R2_BUCKET/,
    );
  });

  it('值为空串（而非 undefined）同样抛：String(undefined)="undefined" 那条路必须堵死', () => {
    expect(() => resolveStorage({ ...ok, R2_ACCOUNT_ID: '' }, deps)).toThrow(
      /r2_storage_config_missing:R2_ACCOUNT_ID/,
    );
  });

  it('缺 secret → 同样抛（且是构造期抛，不是等第一次上传才 500）', () => {
    expect(() => resolveStorage({ ...ok, R2_SECRET_ACCESS_KEY: '' }, deps)).toThrow(
      /r2_storage_config_missing:R2_SECRET_ACCESS_KEY/,
    );
  });
});
