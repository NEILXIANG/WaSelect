/**
 * 职责：管理端的**统一确认弹层**（危险操作）——标题说清后果、主按钮红色、必要时要求逐字输入。
 *
 * @why 附件 §5 与 §8-1①。此前"二次确认"是页面内的行内「确认 / 取消」文字按钮，三类问题是**实测**出来的：
 *      ① **看不出后果**：按钮旁边那句说明和表单的其它辅助文字一个样式（都是 `.muted`），
 *         订单详情里"全额退款（原币退，不可撤销）"与"发货提示"在视觉上完全同级；
 *      ② **主按钮不区分危险度**：拉黑、解除拒付限制、整表替换运费用的都是同一个 `.btn`
 *         （深灰实心），与"保存商品"长得一样，肌肉记忆会连点；
 *      ③ **没有防呆**：运单号是从邮件里复制来的，复制错了一样能提交，
 *         而"改运单号"契约里没有——错了只能让服务端改库。
 *
 * @why 危险度用 **`danger` 显式声明**而不是让调用方自己挑样式类：
 *      "这个动作危不危险"是**业务判断**，必须由写这段业务的人回答一次；
 *      让它变成 `className` 的字符串选择，等于把判断降级成排版偏好，
 *      下一个加动作的人会顺手用默认（不危险）的那个。
 *
 * @limitation 一：**提交中不允许关闭**（ESC / 点遮罩 / 取消按钮全部失效）。
 *              动作已在飞，界面却退回"什么都没发生"，运营会再点一次——
 *              退款走这条路径就是同一笔钱退两次。btw 这与订单详情 @limitation 二同源：
 *              服务端先落 `refunding` 再调机构，前端"看起来没发生"是最危险的显示。
 * @limitation 二：**主按钮一次性**（点过即锁）。父组件的 `busy` 是在 `onConfirm` 里异步设置的，
 *              两次点击之间那一个 tick 内 `disabled` 还没生效；没有这把锁就是双击退两笔。
 *              失败时父组件**必须关闭弹层**（与既有 `setConfirming(false)` 同形），
 *              需要重试就重新打开——所以这把锁不会把人卡死。
 * @limitation 三：它**不做**业务校验（金额上限、状态闸门仍在 `orders/view.ts` 与服务端）；
 *              弹层只回答"你确定吗"，不回答"能这样做吗"。
 *
 * @see ../../docs/管理后台对标分析-成熟电商平台-2026-10-08.md §8-1①；./toast.tsx（操作反馈）
 */
import { useEffect, useRef, useState } from 'react';

export interface ConfirmSpec {
  /** 标题：说清**后果**，不是动作名（「退款后不可撤销」而不是「退款」）。 */
  title: string;
  /** 后果细节（会进审计 / 不可逆 / 影响范围）。 */
  body?: string | undefined;
  /** 主按钮文字。 */
  confirmText: string;
  /** 危险动作：主按钮转为错误色。@see 文件头 @why 第二段（业务判断，不是排版偏好） */
  danger?: boolean;
  /**
   * 要求**逐字输入**这段文字才放行（如运单号）。
   * @why 复制来的运单号最容易错在首尾字符上，看一遍看不出来；手打一遍会。
   * @limitation 空串 / 空白按"不要求输入"处理——要求输入空串等于任何人都能过。
   */
  typeToConfirm?: string | undefined;
  /** 输入框上方的说明（默认给一句通用的）。 */
  typeLabel?: string | undefined;
}

/**
 * 输入是否达标。
 *
 * @why 空串（含纯空白）判为"不要求输入"：给了一个空串却当成"必须输入空串"，
 *      会把输入框变成一颗只能空着才能点的怪按钮——而"要求输入"这件事
 *      在 UI 上由 `needsType` 表达，两者的判断必须**同一个口径**，否则互相说谎。
 *
 * @why 这一条**在组件里走不到**（`needsType` 先把空串滤掉了），但**不能删**：
 *      它是本模块导出契约的一部分，调用方可以只用这个函数做自己的判断。
 *      它的红灯证据在 `confirm.dom.unit.test.ts` 里对 `typedOk` 的**直接**断言
 *      （注入"删掉早退"后那条必红）——护栏必须真能变红，不能只是写着好看。
 */
export function typedOk(spec: ConfirmSpec, typed: string): boolean {
  const want = spec.typeToConfirm;
  if (typeof want !== 'string' || want.trim() === '') return true;
  return typed.trim() === want.trim();
}

export interface ConfirmDialogProps {
  spec: ConfirmSpec;
  /** 提交中：锁住所有关闭出口与主按钮（@see @limitation 一）。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  spec,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState('');
  /** 主按钮一次性锁（@see @limitation 二）。 */
  const [sent, setSent] = useState(false);

  /**
   * 关闭出口统一走 ref：**不进任何依赖数组**。
   * @why 与 `toast.tsx` 同一条理由——内联箭头函数一旦进依赖，父组件每次重渲染都会
   *      重新绑一次 ESC 监听；这里更糟：重绑的瞬间若正赶上按键，会漏掉这一次 ESC。
   */
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  // 空串不渲染输入框（避免一个"只能空着才能点"的怪框）；与 typedOk 同一口径
  const needsType = typeof spec.typeToConfirm === 'string' && spec.typeToConfirm.trim() !== '';
  const ok = typedOk(spec, typed);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) cancel.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (needsType) inputRef.current?.focus();
  }, [needsType]);

  const danger = spec.danger === true;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={spec.title}>
      <div
        className="modal-backdrop"
        onClick={() => {
          if (!busy) cancel.current();
        }}
      />
      <div className="modal-body dialog">
        <h2 className={`dialog-title${danger ? ' error' : ''}`}>{spec.title}</h2>
        {typeof spec.body === 'string' && spec.body !== '' && <p className="muted">{spec.body}</p>}

        {needsType && (
          <div className="field">
            <span className="label">
              {spec.typeLabel ?? `请再输入一次「${spec.typeToConfirm}」以确认`}
            </span>
            <input
              ref={inputRef}
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={spec.typeToConfirm}
            />
            {/* 只在"填了但不对"时提示：刚打开就报红会让人以为这一格有默认值 */}
            {typed.trim() !== '' && !ok && <span className="error">与上面不一致</span>}
          </div>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn'}
            disabled={busy || sent || !ok}
            onClick={() => {
              setSent(true);
              onConfirm();
            }}
          >
            {busy ? '处理中…' : spec.confirmText}
          </button>
          <button type="button" className="link" disabled={busy} onClick={() => cancel.current()}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
