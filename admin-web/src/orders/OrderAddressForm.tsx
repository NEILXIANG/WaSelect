/**
 * 职责：管理端「发货前改址」表单（仅 `paid` 可用，闸门在 `view.addressGate`）。
 *
 * @why 单独成组件而不是塞进 `OrderDetail`：它七个字段 + 七条字段级错误，
 *      塞进去会把详情挤到两屏之外，而改址是**低频但高后果**的动作——
 *      它需要自己的错误区，不能和发货/退款共用一个 error 文案。
 *
 * @limitation 一：**不做地址标准化**（不调 USPS 校验真实 existence）——
 *              MVP 不引这条路，格式对就提交；真地址错了只能靠客户反馈。
 * @limitation 二：提交成功后由父组件刷新详情，**本地不改显示**——
 *              服务端会重写 `address_snapshot`，前端猜的结果可能与库里不一致。
 *
 * @see ./address-view.ts（校验与请求体）；./api.ts（updateOrderAddress）
 */
import { useState } from 'react';
import { useFormDirty } from '../ui/unsaved.js';
import { ApiError } from '../api/errors.js';
import { updateOrderAddress, type AdminApi, type AdminOrderLike } from './api.js';
import {
  ADDRESS_FIELDS,
  addressFormErrors,
  addressFormModel,
  toAddressInput,
  type AddressField,
} from './address-view.js';
import { addressGate } from './view.js';

/** 字段展示名（顺序沿用 ADDRESS_FIELDS）。 */
const LABELS: Readonly<Record<AddressField, string>> = {
  recipient: '收件人',
  phone: '电话（+1 开头）',
  line1: '地址第一行',
  line2: '地址第二行（可空）',
  city: '城市',
  state: '州（两位大写）',
  postal_code: '邮编（5 位或 ZIP+4）',
};

export interface OrderAddressFormProps {
  api: AdminApi;
  id: string;
  order: AdminOrderLike;
  /** 保存成功后（父组件刷新详情并显示 `message`）。 */
  onDone: (message: string) => void;
}

export function OrderAddressForm({ api, id, order, onDone }: OrderAddressFormProps) {
  const [form, setForm] = useState(() => addressFormModel(order));
  // 基线就是当前订单地址：保存成功后父组件按新地址换 key 重挂，脏态随卸载清掉
  useFormDirty(form, addressFormModel(order));
  const [errors, setErrors] = useState<Partial<Record<AddressField, string>>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * 两步确认（三端联动 UI 模拟 2026-10-08）：改址一点即生效、也没有成功提示——
   * 而它改的是"货寄到哪"，写错就是寄丢。先核对一遍新地址再提交，与发货 / 退款同口径。
   */
  const [confirming, setConfirming] = useState(false);

  const gate = addressGate(order);

  const ask = (): void => {
    const check = addressFormErrors(form);
    setErrors(check.errors);
    if (!check.ok) {
      setError(check.first);
      return;
    }
    setError('');
    setConfirming(true);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await updateOrderAddress(api, id, toAddressInput(form));
      setError('');
      setConfirming(false);
      onDone('收货地址已更新（改前地址已归档，可在事件里查）');
    } catch (e) {
      // ⚠️ 失败保留已填内容：清了表单等于让运营把七个字段重新输一遍
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form">
      <span className="label">发货前改址</span>
      {ADDRESS_FIELDS.map((f) => (
        <div className="field" key={f}>
          <span className="label">{LABELS[f]}</span>
          <input
            className="input"
            value={form[f]}
            onChange={(e) => {
              setConfirming(false);
              setForm((s) => ({ ...s, [f]: e.target.value }));
            }}
          />
          {errors[f] !== undefined && <span className="error">{errors[f]}</span>}
        </div>
      ))}
      {confirming ? (
        <div className="row2">
          <span className="muted">
            核对新地址：
            {ADDRESS_FIELDS.map((k) => form[k])
              .filter((v) => v.trim() !== '')
              .join('，')}
          </span>
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '确认改址'}
          </button>
          <button type="button" className="link" onClick={() => setConfirming(false)}>
            取消
          </button>
        </div>
      ) : (
        <button type="button" className="btn" disabled={!gate.ok || busy} onClick={ask}>
          保存新地址
        </button>
      )}
      {!gate.ok && <p className="muted">{gate.reason}</p>}
      {error !== '' && <p className="error">{error}</p>}
    </div>
  );
}
