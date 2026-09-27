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
 * @limitation 二：`ImageSet` 三档（thumb/card/detail）缺一档即抛：
 *              缺了前端会渲染空 src，运营以为图没传上去。
 *
 * @see ../../../contracts/api-contract.yaml（/admin/upload）
 */
import { ApiError, NETWORK_ERROR_CODE } from './errors.js';

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
export async function uploadImage(
  deps: { baseUrl: string; getToken: () => string; fetchImpl?: typeof fetch },
  file: File,
  traceId?: string,
): Promise<{ thumb: string; card: string; detail: string }> {
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
  if (!res.ok) {
    throw new ApiError(NETWORK_ERROR_CODE, `图片上传失败（HTTP ${res.status}）`, traceId ?? '');
  }
  const body: unknown = await res.json();
  assertImageSet(body, traceId ?? '');
  return body;
}

/** `ImageSet` 形状校验（三档 URL 必须都有：缺一档前端渲染时会拿到空 src）。 */
function assertImageSet(
  value: unknown,
  traceId: string,
): asserts value is { thumb: string; card: string; detail: string } {
  const o = value as Record<string, unknown> | null;
  for (const k of ['thumb', 'card', 'detail'] as const) {
    if (typeof o?.[k] !== 'string' || (o[k] as string) === '') {
      throw new ApiError(NETWORK_ERROR_CODE, `上传响应缺 ${k}（ImageSet 三档不全）`, traceId);
    }
  }
}
