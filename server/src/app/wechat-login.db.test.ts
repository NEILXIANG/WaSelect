/**
 * 职责：小程序登录核心（wechat-login.ts）的真库用例（I1-U6b）——首登建行 /
 *      复登复用 / 并发首登只建一行 / token 可验 / openid 不进日志。
 *
 * @why 用可注入的假 WechatAuth（端口实现），不打微信也不打 dev 替身——
 *      核心要验的是"拿到 openid 之后"的行为；适配器自己的行为在各自单测里钉。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import type { WechatAuth } from '../ports/wechat-auth.js';
import { verifyToken } from './auth.js';
import { loginWithWechat, type WechatLoginDeps } from './wechat-login.js';

let db: Db;
let sink: MemorySink;

const JWT_SECRET = 'wechat-login-test-'.repeat(3);
const OPENID = 'oWx9K2mNpQ7rS4tU';

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
});

let seq = 0;
function deps(wechatAuth: WechatAuth): WechatLoginDeps {
  return {
    wechatAuth,
    authConfig: { secret: JWT_SECRET, issuer: 'waselect' },
    idGen: {
      uuid: () => `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`,
      orderSeq: () => 'AAAAAA',
    },
    logger: createLogger({ env: 'test', destination: sink }),
  };
}

/** 假端口：openid 可配（模拟"微信说这个 code 属于谁"）。 */
function fakeWechat(openid: string): WechatAuth {
  return { code2session: () => Promise.resolve({ openid }) };
}

describe('loginWithWechat', () => {
  it('首登：建 users 行 + 签 token（sub=user.id, role=user, aud=mp）+ is_new_user=true', async () => {
    const r = await loginWithWechat(db, deps(fakeWechat(OPENID)), { code: 'c-1' });

    const rows = await db`select id, openid, is_admin from users where openid = ${OPENID}`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.['id']).toBe(r.user.id);
    expect(r.user.isAdmin).toBe(false);

    // token 必须能被自家验签通过（aud=mp / iss / sub 逐项核）
    const principal = await verifyToken(
      r.token,
      { secret: JWT_SECRET, issuer: 'waselect' },
      'user',
    );
    expect(principal.sub).toBe(r.user.id);

    const logs = sink.find('wechat_login');
    expect(logs.length).toBe(1);
    expect(JSON.stringify(logs[0])).toContain('"is_new_user":true');
  });

  it('复登：不重复建行（仍 1 行）+ 同一 user.id + is_new_user=false', async () => {
    const d = deps(fakeWechat(OPENID));
    const first = await loginWithWechat(db, d, { code: 'c-1' });
    sink.clear();
    const second = await loginWithWechat(db, d, { code: 'c-2' });

    expect(second.user.id).toBe(first.user.id);
    const rows = await db`select count(*)::int as n from users where openid = ${OPENID}`;
    expect(Number(rows[0]?.['n'])).toBe(1);
    expect(JSON.stringify(sink.find('wechat_login')[0])).toContain('"is_new_user":false');
  });

  it('并发首登（同 openid 同时到达）→ 只建一行、两个响应同 user.id', async () => {
    const d = deps(fakeWechat(OPENID));
    const [a, b] = await Promise.all([
      loginWithWechat(db, d, { code: 'c-a' }),
      loginWithWechat(db, d, { code: 'c-b' }),
    ]);
    expect(a.user.id).toBe(b.user.id);
    const rows = await db`select count(*)::int as n from users where openid = ${OPENID}`;
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  it('is_admin 行从小程序登录也只拿 role=user 的 token；isAdmin 如实回带（UI 引导用）', async () => {
    await db`insert into users (id, openid, is_admin) values ('u-admin-1', ${OPENID}, true)`;
    const r = await loginWithWechat(db, deps(fakeWechat(OPENID)), { code: 'c-1' });

    expect(r.user.isAdmin).toBe(true); // 如实回带（前端引导走管理端）
    const principal = await verifyToken(
      r.token,
      { secret: JWT_SECRET, issuer: 'waselect' },
      'user',
    );
    expect(principal.sub).toBe('u-admin-1');
    // role 必须是 user——verifyToken(_, _, 'admin') 必须拒（aud=mp 过不了 admin 关）
    await expect(
      verifyToken(r.token, { secret: JWT_SECRET, issuer: 'waselect' }, 'admin'),
    ).rejects.toMatchObject({ code: 40301 });
  });

  it('openid 明文不进任何日志（ADR-29 红线：用户级标识）', async () => {
    await loginWithWechat(db, deps(fakeWechat(OPENID)), { code: 'c-1' });
    expect(JSON.stringify(sink.rows())).not.toContain(OPENID);
  });
});
