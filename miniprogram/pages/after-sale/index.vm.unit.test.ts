/**
 * 售后申请页 vm（AJ-420）：原因必选、描述 1–500 字（按字符）、两种 40902 的买家说法。
 */
import { describe, expect, it } from 'vitest';
import { REASON_LABELS, conflictText, formView, initialForm, submitBody } from './index.vm.js';

describe('formView / submitBody', () => {
  it('🔴 空表单：不能提交，提示先选问题类型', () => {
    expect(formView(initialForm())).toEqual({
      reasonText: '',
      countText: '0/500',
      overLimit: false,
      canSubmit: false,
    });
    expect(submitBody(initialForm())).toEqual({ ok: false, error: '请选择问题类型' });
  });

  it('🔴 选了原因、描述只有空白 → 不能提交；写了 → 请求体是原因值 + 去首尾空白的描述', () => {
    expect(submitBody({ reasonIndex: 1, description: ' \n ' })).toEqual({
      ok: false,
      error: '请描述一下遇到的问题',
    });
    expect(REASON_LABELS[1]).toBe('商品破损');
    expect(submitBody({ reasonIndex: 1, description: '  外箱压扁，罐子凹了  ' })).toEqual({
      ok: true,
      body: { reason: 'damaged', description: '外箱压扁，罐子凹了' },
    });
    expect(formView({ reasonIndex: 1, description: '外箱压扁' })).toMatchObject({
      reasonText: '商品破损',
      countText: '4/500',
      canSubmit: true,
    });
  });

  it('边界：恰好 500 字可交；501 字不可；emoji 按 1 字计（与服务端同口径）', () => {
    expect(submitBody({ reasonIndex: 0, description: 'あ'.repeat(500) }).ok).toBe(true);
    expect(submitBody({ reasonIndex: 0, description: 'あ'.repeat(501) })).toEqual({
      ok: false,
      error: '问题描述最多 500 字',
    });
    expect(formView({ reasonIndex: 0, description: '😀'.repeat(500) })).toMatchObject({
      countText: '500/500',
      canSubmit: true,
    });
    expect(formView({ reasonIndex: 0, description: 'あ'.repeat(501) }).overLimit).toBe(true);
  });

  it('越界的原因下标当未选', () => {
    expect(submitBody({ reasonIndex: 9, description: 'x' }).ok).toBe(false);
  });
});

describe('conflictText', () => {
  it('🔴 40902 两种原因给具体说法；其它码 / 其它原因 → null', () => {
    expect(conflictText({ code: 40902, data: { reason: 'after_sale_open' } })).toContain('进行中');
    expect(conflictText({ code: 40902, data: { reason: 'status_not_allowed' } })).toContain(
      '不能申请',
    );
    expect(conflictText({ code: 40902, data: { reason: 'other' } })).toBeNull();
    expect(conflictText({ code: 40001, data: { reason: 'after_sale_open' } })).toBeNull();
    expect(conflictText(null)).toBeNull();
  });
});
