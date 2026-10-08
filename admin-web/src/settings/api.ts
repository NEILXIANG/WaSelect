/**
 * 职责：设置页接口层（AJ-404，契约 0.6.47）——`GET /admin/settings`。
 *
 * @limitation 形状不符按网络层异常抛（与 dashboard/api.ts @limitation 一同口径）：
 *             "契约变了"不能显示成"什么都没配置"。
 * @see ./view.ts；../../../server/src/app/admin-settings-routes.ts
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import type { SettingItemLike } from './view.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

export interface SettingsLike {
  generated_at?: string;
  groups: Array<{ key: string; items: SettingItemLike[] }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function getSettings(api: AdminApi): Promise<SettingsLike> {
  const resp = await api({ path: '/api/v1/admin/settings' });
  const groups = isRecord(resp) ? resp['groups'] : undefined;
  if (
    !Array.isArray(groups) ||
    !groups.every((g) => isRecord(g) && typeof g['key'] === 'string' && Array.isArray(g['items']))
  ) {
    throw new ApiError(NETWORK_ERROR_CODE, '设置响应形状与契约不符', '');
  }
  return resp as unknown as SettingsLike;
}
