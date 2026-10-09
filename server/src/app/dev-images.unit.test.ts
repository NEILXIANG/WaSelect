/**
 * 职责：开发期本地图片路由（`/dev-img`）——缺文件回 404，不当成服务端故障。
 * @why 三端联动走查 2026-10-08：模拟库里有指向不存在文件的图片 key（"テスト"、200 多个 "x"），
 *      每次首页加载都在运行日志里打一条 500 + unhandled_error，真正的故障被这些噪声淹没。
 *      `express.static({fallthrough:false})` 缺文件时 next(err) 带 status 404，原先一路落进全局 500 兜底。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountDevImages } from './dev-images.js';

let base = '';
let close: () => void = () => undefined;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-img-'));
  writeFileSync(join(dir, 'a.webp'), 'RIFF');
  const app = express();
  mountDevImages(app, dir);
  // 全局兜底：走到这里就是 500（模拟真实装配里的错误处理器）
  app.use(
    (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).end();
    },
  );
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe('/dev-img', () => {
  it('🔴 缺文件 → 404（不落进全局 500）；非 ASCII 文件名同样 404', async () => {
    expect((await fetch(`${base}/dev-img/nope.webp`)).status).toBe(404);
    expect((await fetch(`${base}/dev-img/${encodeURIComponent('テスト')}`)).status).toBe(404);
  });

  it('文件在 → 200', async () => {
    expect((await fetch(`${base}/dev-img/a.webp`)).status).toBe(200);
  });
});
