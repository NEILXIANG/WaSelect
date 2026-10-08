/**
 * 职责：`GET /admin/settings` 的接线级真库用例（AJ-404）——守卫、通道属性来自装配产物、关税率来自库、
 *       以及**走完整 HTTP 之后**密钥仍不外泄（视图层的单测管不到路由自己往响应里加东西）。
 *
 * @why 通道属性传一份**与内置常量不同**的表行（label 改成「信用卡 / 借记卡」）：
 *      若路由没用装配产物、而是自己读常量，显示的会是「银行卡」——两者相同的话这条用例分辨不出接线对错。
 * @why 关税率不插数据，读迁移 010 的 seed（('JP','US',0.15)）：配置表不随 resetTestDb 清空（test-db.ts @limitation），
 *      这正是生产库里的那一行。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';
import { CHANNEL_DEFAULTS } from '../adapters/payment/channels.js';

let db: Db;
let sink: MemorySink;
const JWT_SECRET = 'cnryJWT-admin-settings-test-jwt-secret-0001';
const SECRETS = {
  JWT_SECRET,
  MOCK_CALLBACK_SECRET: 'cnryMOCK-mock-callback-secret-for-settings-01',
  STRIPE_SECRET_KEY: 'sk_test_cnrySTRIPE0123456789abcdef',
  STRIPE_WEBHOOK_SECRET: 'whsec_cnryWHSEC0123456789abcdef',
  MAIL_PROVIDER_API_KEY: 're_cnryMAIL0123456789',
  SENTRY_DSN: 'https://cnrySENTRYpub@cnrysentryhost.ingest.sentry.io/4242',
  INTERNAL_JOB_SECRET: 'cnryJOB-internal-job-secret-for-settings-0001',
};

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  sink = new MemorySink();
  await db`insert into users (id, email, password_hash, is_admin) values ('u-admin', 'owner@waselect.example', 'x', true)`;
  await db`insert into users (id, openid) values ('u-buyer', 'oWx-openid-settings-buyer')`;
});

async function buildServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    PAYMENT_CHANNELS: 'mock,stripe',
    CHECKOUT_BASE_URL: 'https://pay.waselect.example',
    MAIL_FROM: 'noreply@waselect.example',
    TERMS_VERSION: 'TOS-2026-09-20',
    SELLER_NAME: '株式会社ワセレクト',
    ...SECRETS,
  });
  const stripe = CHANNEL_DEFAULTS['stripe']!;
  const app = createHttpApp({
    logger,
    mount: (a) =>
      mountAllRoutes(a, {
        config,
        logger,
        db,
        events: createEventBus(logger),
        storage: createMemoryStorage(),
        // 表里只有 stripe 一行，且展示名与内置常量不同（@see 文件头）
        channelDefaults: [
          {
            channel: 'stripe',
            priority: stripe.priority,
            countries: [...stripe.countries],
            currencies: [...stripe.currencies],
            label: '信用卡 / 借记卡',
            icon: undefined,
          },
        ],
      }),
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close };
}

async function bearer(sub: string, role: 'admin' | 'user'): Promise<string> {
  return `Bearer ${await signToken({ sub, role }, { secret: JWT_SECRET, issuer: 'waselect' })}`;
}

async function get(url: string, token?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${url}/api/v1/admin/settings`, {
    headers: token === undefined ? {} : { authorization: token },
  });
  return { status: res.status, text: await res.text() };
}

type Item = { key: string; value: unknown; source: string; apply: string; env?: string };
type Body = { generated_at: string; groups: Array<{ key: string; items: Item[] }> };

function find(body: Body, group: string, key: string): Item | undefined {
  return body.groups.find((g) => g.key === group)?.items.find((i) => i.key === key);
}

describe('GET /admin/settings', () => {
  it('守卫：无 token → 40101；买家 → 40301', async () => {
    const { url, close } = await buildServer();
    try {
      expect(JSON.parse((await get(url)).text)['code']).toBe(40101);
      expect(JSON.parse((await get(url, await bearer('u-buyer', 'user'))).text)['code']).toBe(
        40301,
      );
    } finally {
      await close();
    }
  });

  it('生效值：通道属性来自装配产物（表优先）、关税率来自库；完整 HTTP 响应里没有任何密钥片段或密钥名', async () => {
    const { url, close } = await buildServer();
    try {
      const r = await get(url, await bearer('u-admin', 'admin'));
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text) as Body;
      expect(find(body, 'payment', 'payment_channels')?.value).toEqual([
        {
          channel: 'mock',
          enabled: true,
          priority: 90,
          label: '模拟支付',
          countries: ['*'],
          currencies: ['JPY'],
          attrs_source: 'builtin',
        },
        {
          channel: 'stripe',
          enabled: true,
          priority: 20,
          label: '信用卡 / 借记卡',
          countries: ['*'],
          currencies: ['USD'],
          attrs_source: 'table',
        },
      ]);
      expect(find(body, 'tax', 'duty_rates')?.value).toEqual([
        { origin: 'JP', dest: 'US', rate: '0.15000' },
      ]);
      expect(find(body, 'shop', 'seller_name')?.value).toBe('株式会社ワセレクト');
      expect(find(body, 'notify', 'sentry_configured')?.value).toBe(true);
      expect(find(body, 'notify', 'mail_configured')?.value).toBe(true);
      // 密钥：值的任一片段（cnry 标记）与变量名都不得出现；数据库连接串也不得出现
      expect(r.text).not.toMatch(/cnry/i);
      for (const name of Object.keys(SECRETS)) expect(r.text).not.toContain(name);
      expect(r.text).not.toContain('DATABASE_URL');
      expect(r.text).not.toContain(new URL(TEST_DB_URL).pathname.slice(1));
      // 业务日志：谁看过设置页（actor 由守卫写入上下文）
      const rows = sink.find('admin_settings_viewed');
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>)['actor']).toBe('admin:u-admin');
    } finally {
      await close();
    }
  });
});
