/**
 * 职责：订单详情「发货」抽屉里的表单——承运商 + 运单号，两步确认（重打运单号）后发货（AJ-398 从 OrderDetail 拆出）。
 *
 * @why 拆出来是**搬家，不改逻辑**：校验（`shipErrors`）、确认弹层文案、`typeToConfirm`、
 *      成功 / 失败的 Toast 与刷新顺序都与拆分前逐字一致；变化只有"住在抽屉里、成功后关抽屉"。
 * @why 两步确认、重打运单号：运单号是从承运商邮件里复制来的，看一遍看不出首尾错字（第一批①）。
 * @why 行内错误只在点过「发货」之后才显示：空表单是初始状态，不是错误状态。
 *
 * @why 新手可用性（AJ-410 / N16～N19）：输入框上方是真标签（原先只有占位灰字，一打字就看不见在填什么）；
 *      打开即聚焦第一格；承运商是下拉，默认「Japan Post EMS（日本邮政）」，其余选「其他（手动填写）」；
 *      运单号下方写明"在邮局给的单据上"；在输入框里按回车 = 点「发货」（只打开确认，不会直接发货）。
 *      同一张表单也用在订单列表每行的「发货」抽屉（RowShipDrawer）。
 * @limitation 成功后由父组件刷新整页详情（状态以服务端为准），本组件只负责请求与提示。
 * @see ./view.ts（shipGate / shipErrors / toShipBody）；../ui/confirm.tsx
 */
import { useState } from 'react';
import { normalizeTrackingNo, SHIP_MAX_CHARS, trackingNoRecognized } from '@waselect/shared';
import { enterClicksPrimary } from '../ui/keys.js';
import { DEFAULT_CARRIER } from './carrier.js';
import { CarrierPicker } from './CarrierPicker.js';
import { useFormDirty } from '../ui/unsaved.js';
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { toastError, type ToastSink } from '../ui/toast.js';
import { shipOrder, type AdminApi, type AdminOrderLike } from './api.js';
import { TRACKING_SHAPE_WARNING, trackingWarning } from './fix-view.js';
import { emptyShipForm, shipErrors, shipGate, toShipBody } from './view.js';

export interface OrderActionFormProps {
  api: AdminApi;
  id: string;
  order: AdminOrderLike;
  sink: ToastSink;
  /** 刷新详情（返回刷新后的订单，失败为 null）。 */
  reload: () => Promise<AdminOrderLike | null>;
  /** 通知列表刷新。 */
  onChanged: () => void;
  /** 动作成功：父组件关抽屉。 */
  onDone: () => void;
  /** 提交中（父组件据此锁住抽屉的关闭出口）。 */
  onBusy: (busy: boolean) => void;
}

export function ShipForm({
  api,
  id,
  order,
  sink,
  reload,
  onChanged,
  onDone,
  onBusy,
}: OrderActionFormProps) {
  // 承运商默认 EMS（N18）：基线也是它，只打开不填不算"未保存"
  const initial = (): ReturnType<typeof emptyShipForm> => ({
    ...emptyShipForm(),
    carrier: DEFAULT_CARRIER,
  });
  const [ship, setShip] = useState(initial);
  useFormDirty(ship, initial());
  const [touched, setTouched] = useState(false);
  const [dialog, setDialog] = useState<ConfirmSpec | null>(null);
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean): void => {
    setBusyState(b);
    onBusy(b);
  };

  const gate = shipGate(order);
  const check = shipErrors(ship);

  const doShip = async (): Promise<void> => {
    if (!check.ok) {
      sink.error(check.summary);
      setDialog(null);
      return;
    }
    setBusy(true);
    try {
      const resp = await shipOrder(api, id, toShipBody(ship));
      setShip(initial());
      setDialog(null);
      await reload();
      onChanged();
      // P1-10：服务端认不出运单号形状时提醒核对（已保存；录错可在「订单修正」里改）
      const warn = trackingWarning(resp);
      if (warn !== '') sink.info(warn, { sticky: true });
      else sink.success('已发货，运单号已随发货邮件发给买家');
      setBusy(false);
      onDone();
    } catch (e) {
      setDialog(null);
      setBusy(false);
      const { text, traceId } = toastError(e, '发货失败');
      sink.error(text, { traceId });
    }
  };

  const ask = (): void => {
    setTouched(true);
    if (!check.ok) {
      // ⚠️ 用 summary（全部缺失项），不用 first：一次说完，不让运营走"改一个、再点、再改一个"
      sink.error(check.summary);
      return;
    }
    setDialog({
      title: '发货后不能再改址，运单号录错只能走「订单修正」',
      // 显示**落库后的样子**（服务端去空白、转大写，AJ-410）：买家邮件里看到的就是这一串
      body: `承运商 ${ship.carrier.trim()} / 运单号 ${normalizeTrackingNo(ship.trackingNo)}。确认后发货邮件立即发给买家。`,
      confirmText: '确认发货',
      danger: true,
      typeToConfirm: normalizeTrackingNo(ship.trackingNo),
      // 与服务端同一口径比对：再输一次时大小写、空格不同不算"不一致"
      normalize: normalizeTrackingNo,
      typeLabel: '请再输入一次运单号（复制来的单号最容易错在首尾字符）',
    });
  };

  const bad = (k: string): boolean => touched && check.errors[k] !== undefined;

  return (
    <div className="form" onKeyDown={enterClicksPrimary}>
      {/* maxLength 引 shared 常量（AJ-315）：与服务端同一个上限 */}
      <div className="field">
        <label className="label" htmlFor={`ship-carrier-${id}`}>
          承运商（快递公司）
        </label>
        <CarrierPicker
          id={`ship-carrier-${id}`}
          value={ship.carrier}
          invalid={bad('carrier')}
          autoFocus
          onChange={(carrier) => setShip((s) => ({ ...s, carrier }))}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`ship-tracking-${id}`}>
          运单号
        </label>
        <input
          id={`ship-tracking-${id}`}
          name="tracking_no"
          className={`input${bad('trackingNo') ? ' input-error' : ''}`}
          placeholder="例：EM123456789JP"
          maxLength={SHIP_MAX_CHARS.tracking_no}
          value={ship.trackingNo}
          aria-invalid={bad('trackingNo')}
          onChange={(e) => setShip((s) => ({ ...s, trackingNo: e.target.value }))}
        />
        <span className="muted">在邮局给的单据上，例：EM123456789JP（字母大小写、空格不用管）</span>
      </div>
      {/* 行内错误：缺哪项就红在哪一项下面（三端联动模拟 2026-10-08） */}
      {touched && (
        <div className="field-errors" role="alert">
          {Object.entries(check.errors).map(([k, msg]) => (
            <span key={k} className="error">
              {msg}
            </span>
          ))}
        </div>
      )}
      {/* 确认**之前**就提示：发货邮件随确认一起发出，事后提示已晚 */}
      {ship.trackingNo.trim() !== '' && !trackingNoRecognized(ship.carrier, ship.trackingNo) && (
        <span className="error">{TRACKING_SHAPE_WARNING}</span>
      )}
      <button
        type="button"
        className="btn"
        data-primary-action
        disabled={!gate.ok || busy}
        onClick={ask}
      >
        发货
      </button>
      {!gate.ok && <p className="muted">{gate.reason}</p>}
      {dialog !== null && (
        <ConfirmDialog
          spec={dialog}
          busy={busy}
          onConfirm={() => void doShip()}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
