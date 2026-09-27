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
  /** 保存成功后（父组件刷新详情）。 */
  onDone: () => void;
}

export function OrderAddressForm({ api, id, order, onDone }: OrderAddressFormProps) {
  const [form, setForm] = useState(() => addressFormModel(order));
  const [errors, setErrors] = useState<Partial<Record<AddressField, string>>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const gate = addressGate(order);

  const save = async (): Promise<void> => {
    const check = addressFormErrors(form);
    setErrors(check.errors);
    if (!check.ok) {
      setError(check.first);
      return;
    }
    setBusy(true);
    try {
      await updateOrderAddress(api, id, toAddressInput(form));
      setError('');
      onDone();
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
            onChange={(e) => setForm((s) => ({ ...s, [f]: e.target.value }))}
          />
          {errors[f] !== undefined && <span className="error">{errors[f]}</span>}
        </div>
      ))}
      <button type="button" className="btn" disabled={!gate.ok || busy} onClick={() => void save()}>
        {busy ? '保存中…' : '保存新地址'}
      </button>
      {!gate.ok && <p className="muted">{gate.reason}</p>}
      {error !== '' && <p className="error">{error}</p>}
    </div>
  );
}
