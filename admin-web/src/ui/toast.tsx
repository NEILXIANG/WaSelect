/**
 * 职责：管理端的**统一操作反馈**（Toast）——右下角浮层，成功自动消失、错误停留且带报障码。
 *
 * @why 附件《管理后台对标分析-成熟电商平台》§5 与 §8-1①。此前每个页面各写一份
 *      `<p className="error">` / `<p className="ok">`，三类后果是**实测**出来的，不是审美问题：
 *      ① 提示出现在页面**顶部**，而触发按钮在下方（订单详情有五段表单，退款按钮在第四段），
 *         运营点完往下看，压根不知道成了还是没成；
 *      ② 成功提示**不会消失**，切到别的页签再切回来可能还在——AJ-388 / 389 逐页修过几处残留，
 *         但那是"修页面"，不是"修机制"，新页面照样会漏；
 *      ③ 失败只说一句人话、**不带报障码**：N8 已经在 `ApiError.traceId` 上备好了链路 ID，
 *         只是从来没露给运营，报障时只能靠"大概几点几分"去对日志。
 *
 * @why **错误不自动消失**，成功 / 信息 3 秒后消失：
 *      错误文案里往往带着"下一步怎么办"（50300 的"约 N 秒后可重试"、退款失败的四种分支），
 *      让它自己消失等于逼运营手抄；而成功提示一直留着会变成"上一次操作的残留"，
 *      反而让人分不清**这一次**成没成。
 *
 * @limitation 一：报障码用 **`user-select: all` 供选中复制**，不引 `navigator.clipboard`——
 *              后者在非 HTTPS / 非用户手势下会静默失败（且失败时没有可观测信号），
 *              jsdom 里也测不到；选中复制与既有 `.selectable`（扫描 A-03）同一手法，零新增依赖。
 * @limitation 二：堆叠规则——**同一 kind 只留最新一条**；**成功另会清空全部旧提示**；总数不超过 `TOAST_MAX`。
 *      @why "同一 kind 只留最新"是三端联动模拟里撞出来的：错误提示恒停留（要复制报障码），
 *           于是"上一次失败的红字"会一直挂在右下角——这正是附件 §5 说的"部分页面会残留"换个地方复发。
 *      @why **成功清屏**：运营重试成功后看见"红+绿"两条，分不清这次成没成
 *           （风控页那条"已拉黑 and 请求超时同屏"的用例就是这样红的）。
 *           成功是"这一步做完了"的最强信号，在此之前的"待处理 / 失败"提示都已过期。
 *           不做成"每次动作前手动 clear"——靠调用方记得清的闸门等于没有闸门（F12 同款教训）。
 *      @limitation 跨 kind **其它组合刻意并存**：退款失败时 `error`（服务端的话 + 报障码）与
 *                 `info`（"结果未知，不要重复提交"）是**同一件事的两半**，
 *                 挤掉任何一半都会让运营只拿到半句（B41 / AJ-215）。
 *                 ⚠️ 所以"成功清屏"不能推广成"任何提示都清屏"。
 * @limitation 三：**只管"告诉用户发生了什么"**，不承载业务分支：
 *              退款的三种 outcome、发货的运单号形状警告仍由 `orders/view.ts` 出文案，这里只负责摆。
 *
 * @see ../../docs/管理后台对标分析-成熟电商平台-2026-10-08.md §8-1①；./confirm.tsx（危险操作确认）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { TraceLine } from './trace.js';
import { ERROR_CODES } from '@waselect/shared';
import { onRelogin } from './session-events.js';

/** 会话过期的提示原文（shared 注册表 40101）。 */
const AUTH_EXPIRED_TEXT: string = ERROR_CODES[40101].message;

/** 成功 / 信息类提示的自动消失时长（毫秒）。 */
export const TOAST_AUTO_DISMISS_MS = 3000;

/** 同时最多显示几条（超出丢最旧的，@see @limitation 二）。 */
export const TOAST_MAX = 3;

/** @why 三类不是"三种颜色"，是**三种处置**：成功=不用管；信息=要读但会过去；错误=必须读完且要能报障。 */
export type ToastKind = 'success' | 'info' | 'error';

/** 附加信息：报障码与"是否强制停留"。 */
export interface ToastOptions {
  /** 报障码（`ApiError.traceId`）；空串按"没有"处理。 */
  traceId?: string | undefined;
  /**
   * 强制停留（不自动消失）。
   * @why 有些**成功 / 信息**文案同样必须读完——退款提交后被机构挂起（`pending`）那一档
   *      写着"订单保持在退款中，不要重复提交"，让它 3 秒消失等于没说（B41 / AJ-215）。
   *      所以"停不停留"不能只看 kind：它由**写这段业务的人**声明一次。
   * @limitation `error` 恒停留，传了也是同义反复——不留一个"错误也可以自动消失"的旋钮。
   */
  sticky?: boolean | undefined;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  /** 报障码（`ApiError.traceId`）；只有错误态才有，空串按"没有"处理。 */
  traceId?: string | undefined;
  /** 强制停留（@see ToastOptions.sticky）。 */
  sticky?: boolean | undefined;
}

/** 反馈出口：页面拿它替换自己那份 `error` / `ok` state。 */
export interface ToastSink {
  toasts: readonly Toast[];
  success(text: string, opts?: ToastOptions): void;
  info(text: string, opts?: ToastOptions): void;
  error(text: string, opts?: ToastOptions): void;
  dismiss(id: number): void;
}

/**
 * 把抛出来的东西转成 Toast 的错误态。
 * @why 单独导出：每个页面的 catch 里都要写一遍 `e instanceof ApiError ? e.message : String(e)`，
 *      而**漏掉 traceId** 是这类复制的默认结果（N8 的链路 ID 就此丢掉）。
 */
/**
 * 40902（订单状态不允许此操作）在**已经自动刷新了详情**的地方的说法（联动走查·两位运营同时处理同一单 2026-10-10）。
 * @why 服务端原文"订单状态不允许此操作"说不出原因——改址 / 发货撞上它，最常见的是别人刚发了货，页面还停在旧状态。
 *      只给真的刷新了详情的两处用（OrderAddressForm 经 OrderActions / ShipForm），且等刷新结果回来再选文案；通用的 toastError 不改：
 *      其它动作（如解除拒付锁定）的 40902 有各自的含义，测试钉着"显示服务端原话"。
 */
export const STATE_CHANGED_REFRESHED_TEXT =
  '这张单的状态刚变了（可能有人刚处理过），页面已刷新为最新状态，请看清后再操作';
/** 同上，但刷新没成功（严格检查 2026-10-10：没刷新成功时不能说"已刷新"）。 */
export const STATE_CHANGED_TEXT =
  '这张单的状态刚变了（可能有人刚处理过），请刷新页面看最新状态后再操作';

/** 40902 之后刷新详情的结果 → 提示文案（刷新成功才说"已刷新"）。 */
export function staleNotice(refreshed: boolean): string {
  return refreshed ? STATE_CHANGED_REFRESHED_TEXT : STATE_CHANGED_TEXT;
}

export function toastError(
  e: unknown,
  fallback = '操作失败',
): { text: string; traceId: string | undefined } {
  if (e instanceof ApiError) {
    return { text: e.message === '' ? fallback : e.message, traceId: e.traceId };
  }
  const text = e instanceof Error ? e.message : String(e);
  return { text: text === '' ? fallback : text, traceId: undefined };
}

export function useToasts(): ToastSink {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: ToastKind, text: string, opts?: ToastOptions) => {
    // 空文本 = "清掉这一类的旧提示"（订单修正 / 部分退款提交前会 onNotice('')），不新增一个只有 × 的空白气泡
    //   （审查 2026-10-09 #4：新手会把它当成"出了个没内容的错误"）
    if (text.trim() === '') {
      setToasts((list) => list.filter((t) => t.kind !== kind));
      return;
    }
    seq.current += 1;
    const id = seq.current;
    setToasts((list) => {
      const next = { id, kind, text, traceId: opts?.traceId, sticky: opts?.sticky };
      // 成功 = 这一步做完了，清屏；其余挤掉同 kind 的旧提示（@see @limitation 二）
      const kept = kind === 'success' ? [] : list.filter((t) => t.kind !== kind);
      return [...kept, next].slice(-TOAST_MAX);
    });
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  // 第 24 项（2026-10-10）：浮层里重新登录成功 → 清掉残留的"未登录或登录已过期"（已经登录了还挂着它会误导）；
  // 只清这一句，别的错误不动——重新登录不等于那件事办成了。文案取 shared 错误码注册表，与服务端同源
  useEffect(
    () =>
      onRelogin(() => {
        setToasts((list) =>
          list.filter((t) => !(t.kind === 'error' && t.text === AUTH_EXPIRED_TEXT)),
        );
      }),
    [],
  );

  return {
    toasts,
    success: useCallback(
      (text: string, opts?: ToastOptions) => push('success', text, opts),
      [push],
    ),
    info: useCallback((text: string, opts?: ToastOptions) => push('info', text, opts), [push]),
    error: useCallback((text: string, opts?: ToastOptions) => push('error', text, opts), [push]),
    dismiss,
  };
}

/**
 * 一条提示。
 *
 * @why 定时器回调走 **ref** 而不是把 `onDismiss` 放进依赖数组：
 *      调用方几乎必然写成 `onDismiss={(id) => sink.dismiss(id)}` 这样的内联箭头函数，
 *      一旦进了依赖数组，父组件每次重渲染都会 `clearTimeout` 再重设——
 *      而"父组件恰好在 3 秒内又渲染了一次"是常态（比如列表自己在轮询），
 *      结果就是**成功提示永远不消失**，退化成和行内 `<p className="ok">` 一样的残留。
 *      这条不是理论风险：它正是 @why 里第 ② 条要消灭的那个毛病换个地方复发。
 */
function ToastRow({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}): React.JSX.Element {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    // 错误恒停留（要读完、要复制报障码）；其余按 sticky 声明
    if (toast.kind === 'error' || toast.sticky === true) return undefined;
    const timer = setTimeout(() => dismiss.current(toast.id), TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.kind, toast.id, toast.sticky]);

  const hasTrace = typeof toast.traceId === 'string' && toast.traceId !== '';

  return (
    <div className={`toast toast-${toast.kind}`} data-kind={toast.kind}>
      <span className="toast-text">{toast.text}</span>
      {/* 报障码单独一行小灰字、说清用途（AJ-410 / N5：混在句子里新手会以为那串编号就是错误本身） */}
      {hasTrace && <TraceLine traceId={toast.traceId} />}
      <button
        type="button"
        className="toast-close"
        aria-label="关闭提示"
        onClick={() => dismiss.current(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/** 提示浮层（右下角）。没有提示时不渲染任何节点，避免空浮层挡住页面右下角的按钮。 */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
}): React.JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
