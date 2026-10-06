/** 职责：客服联系方式视图（剩余清单 4-2）。 */
import { describe, expect, it } from 'vitest';
import { supportRows } from './support.js';

describe('supportRows', () => {
  it('🔴 固定顺序（微信 → 邮箱 → 时间）、中文标签；微信与邮箱可复制，时间不可复制', () => {
    expect(
      supportRows({
        hours: '工作日 10:00–18:00（JST）',
        email: 'support@example.com',
        wechat: 'waselect_cs',
      }),
    ).toEqual([
      { key: 'wechat', label: '客服微信', value: 'waselect_cs', copyable: true },
      { key: 'email', label: '客服邮箱', value: 'support@example.com', copyable: true },
      { key: 'hours', label: '服务时间', value: '工作日 10:00–18:00（JST）', copyable: false },
    ]);
  });

  it('只出服务端给了且非空白的字段；全空 / 脏输入 → 空数组（页面不显示客服卡）', () => {
    expect(supportRows({ email: '  ' })).toEqual([]);
    expect(supportRows({})).toEqual([]);
    expect(supportRows(null)).toEqual([]);
    expect(supportRows(['x'])).toEqual([]);
  });
});
