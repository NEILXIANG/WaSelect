/**
 * 职责：`POST /admin/upload` 的封装（multipart 图片上传 → `ImageSet`）。
 *
 * @why 从 `products/api.ts` 搬到这里：上传是**商品图与 Banner 图共用**的能力，
 *      放在商品模块里会让 Banner 反过来 import 商品模块——
 *      两个业务模块互相依赖之后，"改商品的上传"会牵动 Banner，而这条依赖毫无业务含义。
 *
 * @why **不走** `api/client.ts` 的通用封装：那个封装恒发 JSON
 *      （`content-type: application/json` + `JSON.stringify(body)`），
 *      而 multipart 的边界由浏览器生成、body 不能被序列化。
 *      为它给通用封装开一个"不序列化"的分支，等于让封装知道两种完全不同的传输语义——
 *      那正是封装要消灭的东西。所以这里单独实现，共享的只有 baseUrl / token / trace 头。
 *
 * @limitation 一：超时用 `AbortController`（与 client.ts @limitation 二 同口径）——
 *              取消的是等待，不是服务端执行；失败重发要重新选同一个文件，不自动重试。
 * @limitation 二：`ImageSet` 三档（thumb/card/detail）**全在或全缺**——服务端在
 *              `IMG_BASE_URL` 未配置时三档全省略（banner `image` 同口径：字段缺席
 *              才是"没有可展示的 URL"）；缺一/缺二是畸形响应，抛。
 *              `image_key` 恒在（0.6.8 起，AJ-143），缺它即抛。
 * @limitation 四：`image_id` 恒在（0.6.28 起 / AJ-361），缺它即抛。
 *              它与三档 URL **不同命运**：三档可以全省略（图床域名没配），
 *              `image_id` **不依赖** `IMG_BASE_URL`——因为它是"要存进库的值"，
 *              不能因为"域名还没配"就换一种形态（否则同一批商品里会混着 id 与 URL 两种条目）。
 *              商品表单从 0.6.29 / AJ-362 起**只存 `image_id`**，所以缺它必须响亮失败：
 *              静默放行的表现是"图存进去了、但存的是 URL"（第一步的收益被悄悄抹掉）。
 *
 * @see ../../../contracts/api-contract.yaml（/admin/upload）
 */
import { ApiError, NETWORK_ERROR_CODE, UNAUTHORIZED_CODE } from './errors.js';

/**
 * 单文件上限（字节）：**镜像**服务端 `server/src/domain/upload-image.ts` 的 `UPLOAD_MAX_BYTES`
 * （由 `server/src/app/admin-upload-routes.ts` 消费）。改服务端那份时**必须同步改这里**。
 * @why 不在 shared：服务端常量住在 domain 层且不在 shared 里，本轮约定不改服务端；
 *      前端这份只用于"上传前就告诉运营太大了"，即使漂移，最终仍以服务端为准（多拒或少拒一次预检）。
 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** 服务端只认这三族（按 magic bytes 嗅探，见 upload-image.ts @limitation 二）；也用作 `<input accept>`。 */
export const UPLOAD_ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const UPLOAD_ACCEPT = UPLOAD_ACCEPT_TYPES.join(',');

/**
 * 上传前预检（P2-45）：返回给运营看的错误文案；通过返回 ''。
 * @why 10MB 的图要传完才被服务端拒，运营等了几十秒只看到一句泛化错误；HEIC（iPhone 直出）同理。
 * @limitation `file.type` 是浏览器按扩展名猜的，可被改名绕过——这只是体验预检，真闸门是服务端的字节嗅探。
 *             `type` 为空串（系统认不出）时放行，交给服务端判。
 */
export function uploadPrecheck(file: { size: number; type: string; name?: string }): string {
  if (file.type !== '' && !(UPLOAD_ACCEPT_TYPES as readonly string[]).includes(file.type)) {
    return `不支持的图片格式（${file.type}）：只收 JPEG / PNG / WebP，iPhone 的 HEIC 请先转成 JPEG`;
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `图片太大（${mb}MB）：单张不能超过 10MB，请压缩后再传`;
  }
  return '';
}

/**
 * 上传响应：三档 URL 可选（IMG_BASE_URL 未配置时全省略），`image_key` 与 `image_id` **恒在**。
 *
 * @why 商品图从 0.6.29 / AJ-362 起**只存 `image_id`**（三档的共同主键）——
 *      三档 URL 只是给编辑页**预览**用的，不是要存进库的值。
 *      两者在响应里同时出现，但用途完全不同，别在表单里互相顶替。
 */
export interface UploadedImage {
  thumb?: string;
  card?: string;
  detail?: string;
  image_key: string;
  /** `img/{image_id}/{tier}.webp` 里的那一段；**恒返回**（不依赖 IMG_BASE_URL）。 */
  image_id: string;
}

/**
 * `POST /admin/upload`（multipart 图片上传 → `ImageSet`）。
 *
 * @why **不走** `requestApi`：那个封装恒发 JSON（`content-type: application/json` +
 *      `JSON.stringify(body)`），而 multipart 的边界由浏览器生成、body 不能被序列化。
 *      为它给通用封装开一个"不序列化"的分支，等于让封装知道两种完全不同的传输语义——
 *      那正是封装要消灭的东西。所以这里单独实现，共享的只有 baseUrl / token / trace 头。
 * @limitation 三：超时用 `AbortController`（与 client.ts @limitation 二 同口径）——
 *              取消的是等待，不是服务端执行；失败重发要重新选同一个文件，不自动重试。
 */
/**
 * @why 错误收敛与 `client.ts` **同一口径**（KD-13，AJ-175，前后端接缝测试实测）：
 *      原实现把一切非 2xx 折成 `NETWORK_ERROR_CODE` + "HTTP 400/401"——
 *      ① 服务端的业务码（40001 图片解不开 / 格式不收）被丢掉，运营只看到"上传失败（HTTP 400）"，不知道是图的问题；
 *      ② 40101 不触发 `onUnauthorized`：登录过期时 JSON 请求会把人带回登录页，唯独上传不会，
 *         运营反复重选文件、反复"HTTP 401"。现在：body 带数字 `code` → 按业务错抛（带服务端 message 与
 *         响应头的 trace id）；40101 先通知 `onUnauthorized` 再抛（与 client.ts 同序）；body 不是 JSON 才归网络错。
 */
export async function uploadImage(
  deps: {
    baseUrl: string;
    getToken: () => string;
    fetchImpl?: typeof fetch;
    /** 40101 时的通知出口（与 `createAdminApi` 的同名依赖同一语义：装配层清 token 回登录页）。 */
    onUnauthorized?: ((err: ApiError) => void) | undefined;
  },
  file: File,
  traceId?: string,
): Promise<UploadedImage> {
  // 预检不过不发请求（P2-45）；用 40001 与服务端"格式不收"同码，调用方按 message 展示
  const pre = uploadPrecheck(file);
  if (pre !== '') throw new ApiError(40001, pre, traceId ?? '');
  const doFetch = deps.fetchImpl ?? fetch;
  const form = new FormData();
  form.set('file', file);
  const headers: Record<string, string> = {};
  const token = deps.getToken();
  if (token !== '') headers['authorization'] = `Bearer ${token}`;
  if (traceId !== undefined) headers['x-trace-id'] = traceId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await doFetch(`${deps.baseUrl}/api/v1/admin/upload`, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(NETWORK_ERROR_CODE, '图片上传失败（网络或超时）', traceId ?? '');
  } finally {
    clearTimeout(timer);
  }
  const serverTraceId = res.headers.get('x-trace-id') ?? traceId ?? '';
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      code?: unknown;
      message?: unknown;
    } | null;
    if (typeof errBody?.code === 'number') {
      const err = new ApiError(
        errBody.code,
        typeof errBody.message === 'string'
          ? `图片上传失败：${errBody.message}`
          : `图片上传失败（${errBody.code}）`,
        serverTraceId,
      );
      if (err.code === UNAUTHORIZED_CODE) deps.onUnauthorized?.(err);
      throw err;
    }
    throw new ApiError(NETWORK_ERROR_CODE, `图片上传失败（HTTP ${res.status}）`, serverTraceId);
  }
  const body: unknown = await res.json();
  assertUploadResponse(body, traceId ?? '');
  return body;
}

/**
 * 上传响应形状校验（@limitation 二 / 四）：`image_key` 与 `image_id` 都必须非空；
 * 三档 URL **全在或全缺**（全缺 = 服务端 IMG_BASE_URL 未配置，调用方自行决定能否接受——
 * Banner 只要 key 不受影响，商品图要 URL 做预览，由商品表单拦）。
 */
function assertUploadResponse(value: unknown, traceId: string): asserts value is UploadedImage {
  const o = value as Record<string, unknown> | null;
  if (typeof o?.image_key !== 'string' || o.image_key === '') {
    throw new ApiError(NETWORK_ERROR_CODE, '上传响应缺 image_key（0.6.8 起服务端恒返回）', traceId);
  }
  if (typeof o?.image_id !== 'string' || o.image_id === '') {
    throw new ApiError(
      NETWORK_ERROR_CODE,
      '上传响应缺 image_id（0.6.28 起服务端恒返回；缺了商品图只能存回三档 URL）',
      traceId,
    );
  }
  const present = ['thumb', 'card', 'detail'].filter(
    (k) => typeof o[k] === 'string' && (o[k] as string) !== '',
  );
  if (present.length !== 0 && present.length !== 3) {
    throw new ApiError(
      NETWORK_ERROR_CODE,
      `上传响应 ImageSet 三档不全（只有 ${present.join('/')}）：畸形响应`,
      traceId,
    );
  }
}
