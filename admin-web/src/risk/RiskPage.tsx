/**
 * 职责：风控页（拒付列表 + 拉黑用户）。
 *
 * @why 拉黑做成**两步：先取订单详情拿 user_id，再二次确认拉黑**——
 *      契约的 `Dispute` 里没有 user_id（@see ./view.ts @limitation 一），
 *      而契约**只有拉黑、没有解除**（@limitation 二），
 *      所以点下去之前必须让运营看见"要拉黑的是谁"，以及"这一步没有回头路"。
 *
 * @limitation 一：证据提交**不在后台做**（契约明文：证据在 Stripe Dashboard 提交），
 *              后台只标红、锁退款、拉黑——所以这里刻意**不放**"提交证据"按钮，
 *              避免运营以为在这里传了材料就算完成举证。
 * @limitation 二：复用订单模块的 `getOrder` 拿 user_id（不为它另起一份封装）；
 *              跨模块只引用**接口层**函数，不引用页面。
 * @limitation 三：第一批①（2026-10-08）起反馈走 `ui/Toast`、拉黑确认走 `ui/ConfirmDialog`
 *              ——与订单详情同一套，不再各写一份行内红字。
 *
 * @see ./view.ts；./api.ts；../orders/api.ts（getOrder）；契约 D-50
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ADMIN_NOTE_MAX_LENGTH } from '@waselect/shared';
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { getOrder } from '../orders/api.js';
import { blockUser, listDisputes, type AdminApi } from './api.js';
import { BlockedUsers } from './BlockedUsers.js';
import {
  blockDoneText,
  BLOCK_CONFIRM_TEXT,
  DISPUTE_STATUS,
  DISPUTE_STATUS_LABELS,
  disputeRows,
  orderUserId,
  type DisputeRow,
} from './view.js';

/** 订单详情里的买家：收件人 · 联系邮箱（缺哪个省哪个）。 */
function buyerLabel(order: unknown): string {
  const o = (order ?? {}) as { contact_email?: unknown; address?: { recipient?: unknown } };
  const name = typeof o.address?.recipient === 'string' ? o.address.recipient.trim() : '';
  const email = typeof o.contact_email === 'string' ? o.contact_email.trim() : '';
  return [name, email].filter((x) => x !== '').join(' · ');
}

export interface RiskPageProps {
  api: AdminApi;
}

export function RiskPage({ api }: RiskPageProps) {
  const [rows, setRows] = useState<ReturnType<typeof disputeRows>>([]);
  const [status, setStatus] = useState<'all' | (typeof DISPUTE_STATUS)[number]>('all');
  const [loading, setLoading] = useState(false);
  /** 统一反馈出口（第一批①）。 */
  const sink = useToasts();
  /** 拉黑确认弹层（null = 没开）。 */
  const [dialog, setDialog] = useState<ConfirmSpec | null>(null);
  /** 正在处理的订单（先取详情拿 user_id）。 */
  const [orderId, setOrderId] = useState('');
  /** 面板上显示的订单号（`order_no`），不是 UUID——运营是按订单号认单的（ADM3-01）。 */
  const [orderNo, setOrderNo] = useState('');
  const [userId, setUserId] = useState('');
  /** 面板上写的买家（姓名 · 邮箱），不写内部编号（两端逐页走查第三轮 2026-10-12）。 */
  const [buyerText, setBuyerText] = useState('');
  /** 拉黑原因（AJ-449）：必填，进审计与连带取消的订单事件；面板收起时清空。 */
  const [blockReason, setBlockReason] = useState('');
  const [busy, setBusy] = useState(false);
  /** 拉黑成功后递增，让下方「已拉黑用户」重新取数（P2-47）。 */
  const [blockedTick, setBlockedTick] = useState(0);

  /** 请求序号（A-05）：晚到的旧响应不得覆盖新列表，只有最后一次发起的请求能写。 */
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const list = await listDisputes(api, status === 'all' ? undefined : status);
      if (seq !== reqSeq.current) return;
      setRows(disputeRows(list));
    } catch (e) {
      if (seq !== reqSeq.current) return;
      const { text, traceId } = toastError(e, '取拒付列表失败');
      sink.error(text, { traceId });
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [api, status]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 第一步：取订单详情 → 拿到 user_id。
   *
   * @why **进来第一件事是清空上一次的待确认状态**（ADM3-01）：
   *      拉黑不可逆、契约没有解除接口，而取详情是会失败的（超时 / 5xx 都可能）。
   *      不清空的后果是——对 A 单取详情成功、再对 B 单取详情失败时，
   *      页面顶部出现红字、底部确认面板却**仍是 A 的**，
   *      运营以为面板是刚点的那一单，点下去拉黑的是 A 的用户。
   *      这不是"显示错误"，是**对一个不相干的人执行不可逆操作**。
   * @why 收整行 `r` 而不是只收 `id`：面板要显示 `order_no`（运营认单用的是订单号），
   *      而列表行里本来就有，不必再从详情里找、也不必另存一份映射。
   */
  const prepare = async (r: DisputeRow): Promise<void> => {
    setBusy(true);
    setOrderId('');
    setOrderNo('');
    setUserId('');
    // ⚠️ 不写"响应属于哪一单"的乱序核对：`busy` 已经把"处理"按钮禁用，
    //    同一时刻只可能有一个 `prepare` 在飞，乱序**不会发生**。
    //    加了就是一段永远走不到、也因此永远测不到的分支（约束护栏必须有红灯证据）。
    try {
      const order = await getOrder(api, r.orderId);
      const uid = orderUserId(order);
      setOrderId(r.orderId);
      setOrderNo(r.orderNo);
      setUserId(uid);
      setBuyerText(buyerLabel(order));
      if (uid === '') sink.error('该订单详情里没有 user_id（拉黑需要它）');
    } catch (e) {
      const { text, traceId } = toastError(e, '取订单详情失败');
      sink.error(text, { traceId });
    } finally {
      setBusy(false);
    }
  };

  const confirmBlock = async (): Promise<void> => {
    setBusy(true);
    try {
      // 带上 order_id 让服务端核对"这张单属于这个人"（ADM3-01 纵深防御 / AJ-290）：
      // 拉黑不可逆、没有解除接口，多一道凭据核对的成本是请求体里多一个字段。
      // ⚠️ 它**不是**"防手滑"——防手滑靠的是 prepare 清空待确认态（AJ-256）；
      //    这里防的是"order_id 与 user_id 配错"这类请求级错误。
      await blockUser(api, { userId, orderId, reason: blockReason });
      sink.success(blockDoneText(orderNo));
      setBlockedTick((t) => t + 1);
      setOrderId('');
      setOrderNo('');
      setUserId('');
      setBlockReason('');
      setDialog(null);
    } catch (e) {
      setDialog(null);
      const { text, traceId } = toastError(e, '拉黑失败');
      sink.error(text, { traceId });
    } finally {
      setBusy(false);
    }
  };

  /** 打开拉黑确认弹层（第一批①：拉黑此前是行内「确认拉黑 / 取消」，与"保存"同款按钮）。 */
  const askBlock = (): void => {
    if (blockReason.trim() === '') {
      sink.error('请填写拉黑原因（会记录下来）');
      return;
    }
    setDialog({
      title: '拉黑后用户无法再下单（这次操作会记录下来）',
      // ⚠️ 正文直接引 view.ts 的常量，不在这里重写一遍：
      //    它连"未付款订单会被取消、库存回补"都写全了，重写的必然是缩水版，
      //    而后果清单缩水正是这类弹层最危险的失效方式。
      body: `${BLOCK_CONFIRM_TEXT}\n\n订单 ${orderNo !== '' ? orderNo : orderId} · 用户 ${userId}\n原因：${blockReason.trim()}`,
      confirmText: '确认拉黑',
      danger: true,
    });
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">风控：拒付与拉黑</h1>
        {loading && <span className="muted">加载中…</span>}
      </header>

      <p className="muted">
        证据在 Stripe Dashboard 提交——后台只标红、锁退款、拉黑，不在此处举证。
      </p>

      {/* 筛选片（全入口点击测试 2026-10-12：原为通栏下拉框，与商品页筛选片 / 订单页页签不一致，五个选项也要多点一下） */}
      <div className="filters">
        {(['all', ...DISPUTE_STATUS] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={s === status ? 'chip chip-on' : 'chip'}
            aria-pressed={s === status}
            onClick={() => setStatus(s)}
          >
            {s === 'all' ? '全部' : DISPUTE_STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>订单号</th>
            <th>状态</th>
            <th>争议金额（原币）</th>
            <th>开案（日本时间）</th>
            <th>结案（日本时间）</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.disputeId}-${i}`}>
              <td>{r.orderNo}</td>
              <td className={r.urgent ? 'error' : 'muted'}>{r.statusText}</td>
              <td>{r.amountText}</td>
              <td className="muted">{r.openedText}</td>
              <td className="muted">{r.closedText}</td>
              <td>
                <button
                  type="button"
                  className="link"
                  disabled={busy || r.orderId === ''}
                  onClick={() => void prepare(r)}
                >
                  {/* 写实：点开就是拉黑面板（两端逐页走查第三轮：原写"处理"，已结案的拒付也写"处理"） */}
                  拉黑买家…
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td className="muted" colSpan={6}>
                没有拒付记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {orderId !== '' && userId !== '' && (
        <div className="form">
          <span className="label">拉黑用户</span>
          <span className="muted">
            {/* 显示 order_no：列表行给运营看的是订单号，而 order_id 是 UUID——两个对不上，
                运营没法把面板上这一行和列表里的哪一行对起来（ADM3-01）。
                order_no 缺失时退化到 UUID：宁可显示一个看不懂的串，也不要显示一个空档。 */}
            订单 {orderNo !== '' ? orderNo : orderId} · 买家{' '}
            {buyerText !== '' ? buyerText : '（未留姓名与邮箱）'}
          </span>
          {/* AJ-404：拉黑前先看这个人的全貌（历史单数、地址簿、其它拒付）——客户页是新的主入口 */}
          <a className="link" href={`#/customers/${encodeURIComponent(userId)}`}>
            查看客户
          </a>
          <input
            className="input"
            name="block-reason"
            placeholder="拉黑原因（必填，会记录下来），例：同一张卡 30 天内 3 次拒付"
            maxLength={ADMIN_NOTE_MAX_LENGTH}
            value={blockReason}
            onChange={(e) => setBlockReason(e.target.value)}
          />
          <button type="button" className="btn btn-danger" disabled={busy} onClick={askBlock}>
            拉黑用户
          </button>
          <button
            type="button"
            className="link"
            onClick={() => {
              setOrderId('');
              setUserId('');
            }}
          >
            取消
          </button>
        </div>
      )}

      {/* 解除拉黑（AJ-384）：误拉黑的唯一出口，走审计 */}
      <BlockedUsers api={api} refreshKey={blockedTick} sink={sink} />

      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
      {dialog !== null && (
        <ConfirmDialog
          spec={dialog}
          busy={busy}
          onConfirm={() => void confirmBlock()}
          onCancel={() => setDialog(null)}
        />
      )}
    </section>
  );
}
