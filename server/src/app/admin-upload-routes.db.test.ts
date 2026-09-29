/**
 * 职责：`POST /admin/upload` 的接线级真库用例（I2 U-I4）。
 *
 * @why 接线级才能证明的三件事：守卫挂没挂（401/403）、busboy 截断标志查没查
 *      （超限被砍半的图不能 201）、三档**真的写进了存储**——
 *      存储用 memory 驱动，断言读 `storage.get`（独立断言面，不是响应自证，§2 第 21 条）。
 *
 * @why 测试图用 sharp 现造（与 image-resize.unit.test.ts 同一理由：
 *      fixture 二进制进仓库后来路不明）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage, type MemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';
import { sniffImageType, IMAGE_TIERS, UPLOAD_MAX_BYTES } from '../domain/upload-image.js';

let db: Db;
let sink: MemorySink;
let storage: MemoryStorage;
const JWT_SECRET = 'admin-upload-test-jwt-secret-'.repeat(3);

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
  storage = createMemoryStorage();
});

async function buildServer(
  imgBaseUrl?: string,
  storageOverride: MemoryStorage | null = storage,
): Promise<{ url: string; close: () => Promise<void> }> {
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-upload-route-test',
    TERMS_VERSION: 'TOS-TEST-1',
    ...(imgBaseUrl !== undefined ? { IMG_BASE_URL: imgBaseUrl } : {}),
  });
  const app = createHttpApp({
    logger,
    mount: (a) =>
      mountAllRoutes(a, {
        config,
        logger,
        db,
        events: createEventBus(logger),
        storage: storageOverride,
      }),
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${String(server.port)}`, close: server.close };
}

async function seedUser(isAdmin: boolean, tag: string): Promise<string> {
  const id = `u-${tag}`;
  await db`
    insert into users (id, openid, email, is_admin)
    values (${id}, ${`o-${tag}`}, ${`${tag}@example.com`}, ${isAdmin})
    on conflict (id) do update set is_admin = ${isAdmin}
  `;
  return id;
}

/** ⚠️ `signToken` 是 async——必须 await，否则拼出 "Bearer [object Promise]"。 */
async function bearer(isAdmin = true, tag = 'admin'): Promise<string> {
  const sub = await seedUser(isAdmin, tag);
  const t = await signToken(
    { sub, role: isAdmin ? 'admin' : 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  return `Bearer ${t}`;
}

/** 现造 1200×800 jpeg（横图，三档都会真缩）。 */
async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 60, b: 90 } },
  })
    .jpeg()
    .toBuffer();
}

/** multipart body 手工拼：字段名 file、文件名与 Content-Type 都可控（含"撒谎"用例）。 */
function multipart(
  bytes: Buffer,
  filename: string,
  contentType: string,
): { body: Buffer; ct: string } {
  const boundary = '----waselect-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, bytes, tail]),
    ct: `multipart/form-data; boundary=${boundary}`,
  };
}

async function postUpload(
  url: string,
  auth: string,
  payload: { body: Buffer; ct: string },
): Promise<Response> {
  return fetch(`${url}/api/v1/admin/upload`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': payload.ct },
    body: payload.body,
  });
}

describe('POST /admin/upload', () => {
  it('未登录 → 40101；非管理员 → 40301（守卫必须真挂）', async () => {
    const srv = await buildServer('https://img.example.com');
    try {
      const jpeg = await makeJpeg();
      const payload = multipart(jpeg, 'a.jpg', 'image/jpeg');
      expect((await postUpload(srv.url, '', payload)).status).toBe(401);
      expect((await postUpload(srv.url, await bearer(false, 'buyer'), payload)).status).toBe(403);
    } finally {
      await srv.close();
    }
  });

  it('管理员传真 jpeg → 201：三档 URL + image_key；存储里三档字节都在且都是 webp', async () => {
    const srv = await buildServer('https://img.example.com');
    try {
      const res = await postUpload(
        srv.url,
        await bearer(),
        multipart(await makeJpeg(), 'a.jpg', 'image/jpeg'),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, string>;
      const key = body.image_key!;
      expect(key).toMatch(/^img\/.+\/detail\.webp$/);
      const base = key.replace(/\/detail\.webp$/, '');
      expect(body.thumb).toBe(`https://img.example.com/${base}/thumb.webp`);
      expect(body.card).toBe(`https://img.example.com/${base}/card.webp`);
      expect(body.detail).toBe(`https://img.example.com/${base}/detail.webp`);
      // 独立断言面：三档真的写进了存储，且内容是 webp（不是响应该有的样子，是存储实际的样子）
      for (const t of IMAGE_TIERS) {
        const stored = storage.get(`${base}/${t.name}.webp`);
        expect(stored, `存储里缺 ${t.name} 档`).toBeDefined();
        expect(sniffImageType(stored!.bytes)).toBe('webp');
        expect(stored!.contentType).toBe('image/webp');
      }
    } finally {
      await srv.close();
    }
  });

  it('Content-Type 撒谎（jpeg 字节叫 x.png）→ 仍按字节判，201（magic bytes 是唯一依据）', async () => {
    const srv = await buildServer('https://img.example.com');
    try {
      const res = await postUpload(
        srv.url,
        await bearer(),
        multipart(await makeJpeg(), 'lie.png', 'image/png'),
      );
      expect(res.status).toBe(201);
    } finally {
      await srv.close();
    }
  });

  it('垃圾字节（不是图）→ 40001，且存储零写入', async () => {
    const srv = await buildServer('https://img.example.com');
    try {
      const res = await postUpload(
        srv.url,
        await bearer(),
        multipart(Buffer.from('not an image at all'), 'x.jpg', 'image/jpeg'),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: number }).code).toBe(40001);
      expect(storage.size()).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('超过 10MB → 40001（截断不检查就会把砍半的图当合法小图存下来），且存储零写入', async () => {
    const srv = await buildServer('https://img.example.com');
    try {
      // ⚠️ 必须是"真 jpeg 头 + 填充到 11MB"：纯垃圾字节会被 sniff 顺手拦掉，
      //    于是"没查截断标志"这个缺陷依然绿——覆盖假象（§2 第 21 条同族）。
      const jpeg = await makeJpeg();
      const big = Buffer.concat([jpeg, Buffer.alloc(11 * 1024 * 1024 - jpeg.length, 0x61)]);
      expect(big.length).toBeGreaterThan(UPLOAD_MAX_BYTES);
      const res = await postUpload(
        srv.url,
        await bearer(),
        multipart(big, 'big.jpg', 'image/jpeg'),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: number }).code).toBe(40001);
      expect(storage.size()).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('边界（AJ-175 补测）：恰好 10MB（UPLOAD_MAX_BYTES）→ 201；多 1 字节 → 40001', async () => {
    const srv = await buildServer('https://img.example.com');
    try {
      const jpeg = await makeJpeg();
      // 真 jpeg + 尾部填充：EOI 之后的字节 libjpeg 不读（实测 201），所以能单独考"大小"这一个维度
      const exact = Buffer.concat([jpeg, Buffer.alloc(UPLOAD_MAX_BYTES - jpeg.length, 0x61)]);
      expect(exact.length).toBe(UPLOAD_MAX_BYTES);
      const ok = await postUpload(
        srv.url,
        await bearer(),
        multipart(exact, 'exact.jpg', 'image/jpeg'),
      );
      expect(ok.status).toBe(201);
      const over = Buffer.concat([exact, Buffer.from([0x61])]);
      const bad = await postUpload(
        srv.url,
        await bearer(),
        multipart(over, 'over.jpg', 'image/jpeg'),
      );
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { code: number }).code).toBe(40001);
    } finally {
      await srv.close();
    }
  });

  it.each([
    ['JSON 体（不是 multipart）', 'application/json', Buffer.from('{}'), 'upload_not_multipart'],
    ['缺 Content-Type', undefined, Buffer.from('x'), 'upload_not_multipart'],
  ] as const)(
    'KD-5 %s → 40001（客户端错误，不是 50000），存储零写入',
    async (_name, ct, body, reason) => {
      const srv = await buildServer('https://img.example.com');
      try {
        const res = await fetch(`${srv.url}/api/v1/admin/upload`, {
          method: 'POST',
          headers: {
            authorization: await bearer(),
            ...(ct === undefined ? {} : { 'content-type': ct }),
          },
          body,
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: number }).code).toBe(40001);
        expect(sink.lines.join('\n')).toContain(reason);
        expect(storage.size()).toBe(0);
      } finally {
        await srv.close();
      }
    },
  );

  it('KD-5 文件头合法、内容损坏的 jpeg → 40001 image_decode_failed，存储零写入，解码原因进 warn 日志', async () => {
    const srv = await buildServer('https://img.example.com');
    try {
      // 真 jpeg 只取前 64 字节：magic bytes 通过嗅探，解码必然失败
      const broken = (await makeJpeg()).subarray(0, 64);
      const res = await postUpload(
        srv.url,
        await bearer(),
        multipart(broken, 'b.jpg', 'image/jpeg'),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: number }).code).toBe(40001);
      expect(storage.size()).toBe(0);
      const warn = sink.lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((r) => r['event'] === 'admin_upload_decode_failed');
      expect(warn?.['level']).toBe('warn');
      expect(String(warn?.['err'])).toMatch(/jpeg|JPEG|header/);
    } finally {
      await srv.close();
    }
  });

  it('KD-8 第二档写存储失败 → 50000，已写成的第一档被删掉（不留半套孤儿对象），补偿过程进 error 日志', async () => {
    let n = 0;
    const flaky: MemoryStorage = {
      ...storage,
      put: async (key, bytes, contentType) => {
        n += 1;
        if (n === 2) throw new Error('simulated storage outage');
        await storage.put(key, bytes, contentType);
      },
      delete: (key) => storage.delete(key),
    };
    const srv = await buildServer('https://img.example.com', flaky);
    try {
      const res = await postUpload(
        srv.url,
        await bearer(),
        multipart(await makeJpeg(), 'a.jpg', 'image/jpeg'),
      );
      expect(res.status).toBe(500);
      expect(((await res.json()) as { code: number }).code).toBe(50000);
      expect(storage.size()).toBe(0); // 第一档写成后又被补偿删除
      const rb = sink.lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((r) => r['event'] === 'admin_upload_partial_rollback');
      expect(rb?.['level']).toBe('error');
      expect(rb?.['ctx']).toMatchObject({ written: 1, cleaned: 1 });
    } finally {
      await srv.close();
    }
  });

  it('⚠️ 存储未配置（生产无 R2 的形态）→ 50000 响亮拒绝，不是 201 也不是静默丢弃', async () => {
    const srv = await buildServer('https://img.example.com', null);
    try {
      const res = await postUpload(
        srv.url,
        await bearer(),
        multipart(await makeJpeg(), 'a.jpg', 'image/jpeg'),
      );
      expect(res.status).toBe(500);
      expect(((await res.json()) as { code: number }).code).toBe(50000);
      // ⚠️ 只断言 500/50000 不够：把 null 检查删掉后 `storage.put` 会抛 TypeError，
      //    全局兜底同样给 500/50000——两种"看起来一样"的响应必须靠 reason 区分开。
      const json = sink.lines.join('\n');
      expect(json).toContain('storage_not_configured');
    } finally {
      await srv.close();
    }
  });

  it('IMG_BASE_URL 未配置 → 201 但 URL 三档字段缺席，image_key 恒在（banner image 同口径）', async () => {
    const srv = await buildServer();
    try {
      const res = await postUpload(
        srv.url,
        await bearer(),
        multipart(await makeJpeg(), 'a.jpg', 'image/jpeg'),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.thumb).toBeUndefined();
      expect(body.card).toBeUndefined();
      expect(body.detail).toBeUndefined();
      expect(typeof body.image_key).toBe('string');
    } finally {
      await srv.close();
    }
  });
});
