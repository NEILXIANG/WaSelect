/**
 * 职责：`POST /admin/upload`（I2 U-I4）——multipart 收图 → 嗅探 → 三档缩放 → 写对象存储
 *      → 201 返回 `ImageSet`（三档 URL + `image_key` = detail 档键，AJ-143/AJ-166）。
 *
 * @why 类型按 **magic bytes** 判（`sniffImageType`），不信 multipart 的 Content-Type——
 *      那是客户端自己写的（domain/upload-image.ts @why）。busboy 的 `limits.fileSize`
 *      超限会**截断**而不是报错，所以截断标志必须显式检查：
 *      不查的话 11MB 的图被砍成 10MB 后按"合法小图"存下来——图裂了还 201。
 *
 * @why `storage === null` → 50000 `storage_not_configured`（响亮拒绝）：
 *      生产未配置存储是"入口不可用"的既定现实（R2 凭据在公司登记链后），
 *      与 wechat 未配置的同款处理——路由照挂、调用时给明白话，不是 404 也不是静默成功。
 *
 * @limitation 一：`IMG_BASE_URL` **未配置时 URL 三档字段缺席**（与 banner `image` 同口径，
 *              admin-banner-routes @limitation 一）：空串会被前端当成"图裂了"，
 *              字段缺席才是"没有可展示的 URL"；`image_key` 恒在（它不依赖域名）。
 * @limitation 二：单次请求只收**一个文件**（`files: 1`）——契约的 multipart 只声明了
 *              一个 `file` 字段；多文件形态没有消费方，放进来只会多一条"部分成功"分支。
 * @limitation 三：开发期 fs 驱动的**预览**需要 `IMG_BASE_URL` 指向能提供该目录的静态服务
 *              （本地另起 `npx serve var/uploads` 之类）；服务端不内嵌静态路由——
 *              挂一条无鉴权静态路径的暴露面要单独立项评估，不与本单元混。
 *
 * @see domain/upload-image.ts（嗅探 / 键形 / 上限）；adapters/image-resize.ts（三档）；
 *      ports/storage.ts（驱动）；contracts/api-contract.yaml（/admin/upload，0.6.8）
 */
import type { Express, Request, Response, NextFunction } from 'express';
import Busboy from 'busboy';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { IdGen } from '../ports/ids.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { ObjectStorage } from '../ports/storage.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import { resizeToTiers } from '../adapters/image-resize.js';
import { detailObjectKey, sniffImageType, UPLOAD_MAX_BYTES } from '../domain/upload-image.js';

export interface AdminUploadRoutesDeps {
  logger: Logger;
  config: AppConfig;
  idGen: IdGen;
  auth: AuthConfig;
  identity: IdentityCheck;
  storage: ObjectStorage | null;
}

/** 收完整 multipart（单文件）。超限截断 / 无文件 / 非图字节都在此变成 40001。 */
function readImageFile(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } });
    const chunks: Buffer[] = [];
    let seen = false;
    let truncated = false;
    bb.on('file', (_name, stream) => {
      seen = true;
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => {
        truncated = true;
      });
    });
    bb.on('error', (e) => reject(e));
    bb.on('finish', () => {
      if (!seen) reject(new AppError(40001, { reason: 'upload_file_missing' }));
      else if (truncated) reject(new AppError(40001, { reason: 'upload_file_too_large' }));
      else resolve(Buffer.concat(chunks));
    });
    req.pipe(bb);
  });
}

export function mountAdminUploadRoutes(app: Express, deps: AdminUploadRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const imgBase = deps.config.IMG_BASE_URL?.replace(/\/+$/, '');

  app.post('/api/v1/admin/upload', guard, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      if (deps.storage === null) throw new AppError(50000, { reason: 'storage_not_configured' });
      const bytes = await readImageFile(req);
      if (sniffImageType(bytes) === null) {
        throw new AppError(40001, { reason: 'unsupported_image_type' });
      }
      const imageId = deps.idGen.uuid();
      const tiers = await resizeToTiers(bytes, imageId);
      for (const t of tiers) await deps.storage.put(t.key, t.bytes, t.contentType);
      deps.logger.info('admin_upload_ok', {
        result: 'ok',
        ctx: { bytes: bytes.length, image_id: imageId },
      });
      const urlOf = (key: string): string | undefined =>
        imgBase === undefined ? undefined : `${imgBase}/${key}`;
      const [thumb, card, detail] = tiers.map((t) => urlOf(t.key));
      res.status(201).json({
        ...(thumb === undefined ? {} : { thumb }),
        ...(card === undefined ? {} : { card }),
        ...(detail === undefined ? {} : { detail }),
        image_key: detailObjectKey(imageId),
      });
    })().catch(next);
  });
}
