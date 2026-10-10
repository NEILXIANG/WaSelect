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
 * @limitation 三：整次提交的失败（含"第一处不合格"的汇总）走 `ui/Toast`（审查 2026-10-09，ui/adoption 欠账清单），
 *              七条字段级错误仍在各自输入框下方行内显示。
 *      @why 用父页（订单详情）传进来的 `sink`：本组件住在抽屉里，再挂一摞浮层会和详情页那摞叠在同一个角落。
 *      @why 只清**自己报过的**错误（`posted`）：共用出口时，改一格就 `sink.error('')` 会顺手抹掉
 *           详情页别处报的错误；原先行内红字只属于这张表单，清除范围要与之相同。
 *
 * @see ./address-view.ts（校验与请求体）；./api.ts（updateOrderAddress）
 */
import { useRef, useState } from 'react';
import { useFormDirty } from '../ui/unsaved.js';
import { useDrawerBusy } from '../ui/drawer.js';
import { ApiError } from '../api/errors.js';
import {
  STATE_CHANGED_REFRESHED_TEXT,
  ToastStack,
  toastError,
  useToasts,
  type ToastSink,
} from '../ui/toast.js';
import { updateOrderAddress, type AdminApi, type AdminOrderLike } from './api.js';
import {
  ADDRESS_FIELDS,
  addressFormErrors,
  addressFormModel,
  toAddressInput,
  type AddressField,
} from './address-view.js';
import { addressGate } from './view.js';
import { blockEnter, enterClicksPrimary } from '../ui/keys.js';
import { mouseOnlyHint } from '../ui/confirm.js';

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
  /** 父页的 Toast 出口；不传（组件单独挂载，如组件测试）时用自己的并自渲染浮层。 */
  sink?: ToastSink | undefined;
  /**
   * 这单状态已变（40902，常见是别人刚发了货）：父页刷新详情、收起抽屉（联动走查 2026-10-10）。
   * 不传 = 只提示不刷新（组件单独挂载时）。
   */
  onStale?: (() => void) | undefined;
}

export function OrderAddressForm({
  api,
  id,
  order,
  onDone,
  sink: parentSink,
  onStale,
}: OrderAddressFormProps) {
  const [form, setForm] = useState(() => addressFormModel(order));
  // 基线就是当前订单地址：保存成功后父组件按新地址换 key 重挂，脏态随卸载清掉
  useFormDirty(form, addressFormModel(order));
  const [errors, setErrors] = useState<Partial<Record<AddressField, string>>>({});
  const ownSink = useToasts();
  const sink = parentSink ?? ownSink;
  /** 当前挂着的错误提示是不是本表单报的（@limitation 三：只清自己的）。 */
  const posted = useRef(false);
  const fail = (text: string, traceId?: string): void => {
    posted.current = true;
    sink.error(text, { traceId });
  };
  const clearMine = (): void => {
    if (!posted.current) return;
    posted.current = false;
    sink.error('');
  };
  const [busy, setBusy] = useState(false);
  useDrawerBusy(busy); // 提交中锁住所在抽屉的关闭出口
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
      fail(check.first);
      return;
    }
    clearMine();
    setConfirming(true);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await updateOrderAddress(api, id, toAddressInput(form));
      clearMine();
      setConfirming(false);
      onDone('收货地址已更新（改前地址已归档，可在事件里查）');
    } catch (e) {
      // 别人刚发了货 / 关了单（40902）：核对态收起，交给父页刷新——停在旧页面上运营会一直点「确认改址」
      if (e instanceof ApiError && e.code === 40902 && onStale !== undefined) {
        setConfirming(false);
        fail(STATE_CHANGED_REFRESHED_TEXT, e.traceId);
        onStale();
        return;
      }
      // ⚠️ 失败保留已填内容：清了表单等于让运营把七个字段重新输一遍
      const { text, traceId } = toastError(e, '改址失败');
      fail(text, traceId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form" onKeyDown={enterClicksPrimary}>
      <span className="label">发货前改址</span>
      {ADDRESS_FIELDS.map((f, i) => (
        <div className="field" key={f}>
          <label className="label" htmlFor={`addr-${f}`}>
            {LABELS[f]}
          </label>
          <input
            id={`addr-${f}`}
            className="input"
            autoFocus={i === 0}
            value={form[f]}
            onChange={(e) => {
              setConfirming(false);
              setForm((s) => ({ ...s, [f]: e.target.value }));
              // N30：改了这一格就清掉它的旧错误（原先改对了红字还挂着）
              setErrors((old) => {
                const rest = { ...old };
                delete rest[f];
                return rest;
              });
              clearMine();
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
          <button
            type="button"
            className="btn"
            disabled={busy}
            onKeyDown={blockEnter}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '确认改址'}
          </button>
          <button type="button" className="link" onClick={() => setConfirming(false)}>
            取消
          </button>
          <span className="muted">{mouseOnlyHint('确认改址')}</span>
        </div>
      ) : (
        <button
          type="button"
          className="btn"
          data-primary-action
          disabled={!gate.ok || busy}
          onClick={ask}
        >
          保存新地址
        </button>
      )}
      {!gate.ok && <p className="muted">{gate.reason}</p>}
      {parentSink === undefined && <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />}
    </div>
  );
}
