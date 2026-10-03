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
import { setAuditTarget } from './admin-audit.js';

export interface AdminUploadRoutesDeps {
  logger: Logger;
  config: AppConfig;
  idGen: IdGen;
  auth: AuthConfig;
  identity: IdentityCheck;
  storage: ObjectStorage | null;
}

/**
 * 收完整 multipart（单文件）。超限截断 / 无文件 / 非 multipart / 报文损坏都在此变成 40001。
 *
 * @why busboy 对"不是 multipart"是在**构造时同步抛普通 Error**，报文中途损坏是 `error` 事件——
 *      两者都是**客户端**的问题。原实现让它们落到全局兜底成 50000（KD-5，2026-09-28 测试审查实测），
 *      运营看到"服务器内部错误"去找技术，而不是换个方式重传。
 *      @measured busboy 1.6：`application/json` → `Error: Unsupported content type: application/json`；
 *      无 Content-Type → `Error: Missing Content-Type`（均为普通 Error，无 code 字段）。
 */
function readImageFile(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      // ⚠️ `+ 1`（KD-15，AJ-175 边界补测实测）：busboy 的 fileSize 是**排他**上限——
      //    @measured(busboy 1.6.0, limits.fileSize=16)：15 字节 → limit 未触发；**恰好 16 字节 → limit 触发、
      //    truncated=true**；17 字节 → received=16、truncated=true。直接传 UPLOAD_MAX_BYTES 的后果是
      //    "恰好 10MB 的图被判超限"，与契约"上限 10MB"差一个字节。+1 之后：≤10MB 放行，>10MB 截断即拒。
      bb = Busboy({ headers: req.headers, limits: { fileSize: UPLOAD_MAX_BYTES + 1, files: 1 } });
    } catch {
      reject(new AppError(40001, { reason: 'upload_not_multipart' }));
      return;
    }
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
    bb.on('error', () => reject(new AppError(40001, { reason: 'upload_malformed' })));
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
      const storage = deps.storage;
      // ⚠️ 文件头合法、内容损坏（截半的 jpeg 等）会在**解码**时失败——那仍是客户端给的坏图，
      //    不是服务端故障（KD-5）。@measured sharp 0.35：截断 jpeg →
      //    `Error: Input buffer has corrupt header: VipsJpeg: premature end of JPEG image`。
      //    @tradeoff 解码阶段的**一切**异常都归 40001：sharp 自身的资源类故障（极少见）也会被说成"图坏了"，
      //    代价是一次误判的重传；反过来把坏图说成 50000 是每一张坏图都误判。原始信息进 warn 日志备查。
      const tiers = await resizeToTiers(bytes, imageId).catch((e: unknown) => {
        deps.logger.warn('admin_upload_decode_failed', {
          result: 'rejected',
          ctx: { image_id: imageId, bytes: bytes.length },
          err: e instanceof Error ? e.message : String(e),
        });
        throw new AppError(40001, { reason: 'image_decode_failed' });
      });
      // 三档**顺序**写入；任一档失败 → 删掉已写成的档再抛（KD-8：否则留下半套孤儿对象，
      // 且响应是 50000、运营会重传，每次重传都再多留一套）。补偿是 best-effort：
      // 删除本身失败只记日志，不覆盖原始错误——原始错误才是要报给调用方的事实。
      const written: string[] = [];
      try {
        for (const t of tiers) {
          await storage.put(t.key, t.bytes, t.contentType);
          written.push(t.key);
        }
      } catch (e) {
        let cleaned = 0;
        for (const key of written) {
          await storage.delete(key).then(
            () => {
              cleaned += 1;
            },
            () => undefined,
          );
        }
        deps.logger.error('admin_upload_partial_rollback', {
          result: 'failed',
          ctx: { image_id: imageId, written: written.length, cleaned },
          err: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
      deps.logger.info('admin_upload_ok', {
        result: 'ok',
        ctx: { bytes: bytes.length, image_id: imageId },
      });
      const urlOf = (key: string): string | undefined =>
        imgBase === undefined ? undefined : `${imgBase}/${key}`;
      const [thumb, card, detail] = tiers.map((t) => urlOf(t.key));
      // 上传也是"新建类"：target 记 **image_key**（业务表里存的就是它），
      // 于是"这张图后来被用在哪条 Banner"可以按 key 反查（SEC-12 / AJ-344）。
      // 不记 imageId：它只在本系统内部有意义，且业务表存的是 key 不是 id。
      setAuditTarget(res, detailObjectKey(imageId));
      res.status(201).json({
        ...(thumb === undefined ? {} : { thumb }),
        ...(card === undefined ? {} : { card }),
        ...(detail === undefined ? {} : { detail }),
        image_key: detailObjectKey(imageId),
      });
    })().catch(next);
  });
}
