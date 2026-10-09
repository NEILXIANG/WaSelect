/**
 * 职责：开发期本地图片（`/dev-img`，仅 development + fs 存储时由 mount.ts 挂载）。
 *
 * @why 缺文件回 **404** 而不是落进全局 500（三端联动走查 2026-10-08）：模拟库里有指向不存在文件的 key，
 *      每次首页加载都打一条 500 + unhandled_error，真正的故障被噪声淹没。
 *      `express.static({ fallthrough: false })` 缺文件时以 `status: 404` 的错误调 next——这里就地接住。
 * @limitation 只用于本地开发；生产图片走 R2 公网域名，不经过本进程。
 * @see server/src/adapters/storage.ts `devImageDir`
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

export function mountDevImages(app: Express, dir: string): void {
  app.use('/dev-img', express.static(dir, { index: false, fallthrough: false, maxAge: '1h' }));
  app.use('/dev-img', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status;
    if (status === 404) {
      res.status(404).end();
      return;
    }
    next(err);
  });
}
