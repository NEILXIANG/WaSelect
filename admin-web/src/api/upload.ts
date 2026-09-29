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
 *
 * @see ../../../contracts/api-contract.yaml（/admin/upload）
 */
import { ApiError, NETWORK_ERROR_CODE, UNAUTHORIZED_CODE } from './errors.js';

/** 上传响应：三档 URL 可选（IMG_BASE_URL 未配置时全省略），`image_key` 恒在。 */
export interface UploadedImage {
  thumb?: string;
  card?: string;
  detail?: string;
  image_key: string;
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
 * 上传响应形状校验（@limitation 二）：`image_key` 必须非空；
 * 三档 URL **全在或全缺**（全缺 = 服务端 IMG_BASE_URL 未配置，调用方自行决定能否接受——
 * Banner 只要 key 不受影响，商品图要 URL，由商品表单拦）。
 */
function assertUploadResponse(value: unknown, traceId: string): asserts value is UploadedImage {
  const o = value as Record<string, unknown> | null;
  if (typeof o?.image_key !== 'string' || o.image_key === '') {
    throw new ApiError(NETWORK_ERROR_CODE, '上传响应缺 image_key（0.6.8 起服务端恒返回）', traceId);
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
