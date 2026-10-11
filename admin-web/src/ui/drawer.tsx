/**
 * 职责：管理端的**操作抽屉**——写操作的表单从页面里收进右侧滑出的面板（对标 §4.2 / §8-1④，AJ-398）。
 *
 * @why 订单详情右栏此前常驻六块表单（发货 / 全额退款 / 部分退款 / 解除拒付 / 改址 / 修正），
 *      一屏里能同时看见"发货"和"取消"两颗按钮，误触面大，右栏也比主区还长。
 *      收进抽屉后右栏只剩"按钮 + 只读信息"，每次只展开一种动作。
 *
 * @why 抽屉**自带一份脏态登记簿**并向外层转发：
 *      ① 外层（App）仍能感知"有没填完的内容"——离开页面的二次确认照旧生效；
 *      ② 抽屉自己也要知道"里面脏不脏"，才能在关闭时问一句"放弃修改？"。
 *      两份登记用同一个 key（表单的 `useId`），表单卸载时各自清掉，抽屉不必知道里面挂了几份表单。
 *
 * @why 关闭行为与 `ConfirmDialog` 一致：ESC / 点遮罩 / 「关闭」三个出口，`busy` 时全部失效。
 *      内部还开着一个确认弹层（`.dialog`）时，ESC 交给那个弹层处理，抽屉不跟着关——
 *      否则在发货确认里按一次 ESC，弹层和抽屉一起消失，填好的运单号也没了。
 *
 * @why `busy` 两个来源取或：调用方传入（发货 / 全额退款，状态在父组件），或抽屉里的表单用 `useDrawerBusy` 上报
 *      （改址 / 部分退款 / 订单修正，提交中状态在组件内部）。此前后者锁不住：提交中关抽屉会卸载表单，
 *      请求照样完成，运营却看不到结果（AJ-398 @limitation 一，本条解除）。
 * @limitation 一：只锁"关抽屉"；离开整页（侧栏 / 后退）仍由脏态提醒管，不看 busy。
 * @limitation 二：不做焦点陷阱（Tab 能移出抽屉）：管理端是内部工具，键盘用户极少；
 *              真正要防的"误关丢内容"已由二次确认兜住。
 *
 * @see ./confirm.tsx（关闭出口同口径）；./unsaved.tsx（脏态登记）
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ConfirmDialog } from './confirm.js';
import { trapTab } from './keys.js';
import { UnsavedProvider, useDirtyRegistry, useUnsaved } from './unsaved.js';

/** 抽屉内表单上报"提交中"（没有抽屉时是空操作）。 */
const BusyCtx = createContext<(key: string, busy: boolean) => void>(() => undefined);

/** 表单用：提交中时锁住所在抽屉的全部关闭出口。 */
export function useDrawerBusy(busy: boolean): void {
  const mark = useContext(BusyCtx);
  const key = useId();
  useEffect(() => {
    mark(key, busy);
    return () => mark(key, false);
  }, [key, busy, mark]);
}

export interface ActionDrawerProps {
  title: string;
  /** 提交中：锁住全部关闭出口（与 ConfirmDialog @limitation 一同口径）。 */
  busy?: boolean;
  /** 宽版（AJ-401 批量发货：一行四列的可编辑表格放不进默认宽度）。 */
  wide?: boolean;
  onClose: () => void;
  children?: ReactNode;
}

export function ActionDrawer({
  title,
  busy: outerBusy = false,
  wide = false,
  onClose,
  children,
}: ActionDrawerProps): React.JSX.Element {
  // 与脏态同一种按 key 的登记簿：复用实现，语义是"哪几份表单在提交中"
  const inner = useDirtyRegistry();
  const busy = outerBusy || inner.dirty;
  const outer = useUnsaved();
  const local = useDirtyRegistry();
  const outerMark = outer.markDirty;
  const localMark = local.markDirty;
  const markDirty = useCallback(
    (key: string, dirty: boolean) => {
      localMark(key, dirty);
      outerMark(key, dirty);
    },
    [localMark, outerMark],
  );
  const [asking, setAsking] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);

  /** 关闭请求：脏着先问一句；干净直接关。 */
  const requestClose = useRef<() => void>(() => undefined);
  requestClose.current = () => {
    if (busy) return;
    if (local.dirty) setAsking(true);
    else onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 里面还有一个确认弹层（动作自己的 / 放弃修改的）：这一下 ESC 归它
      if (panel.current?.querySelector('.dialog') != null) return;
      requestClose.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="modal drawer-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-backdrop" onClick={() => requestClose.current()} />
      {/* S9（第二轮审计）：Tab 关在抽屉里；抽屉里的确认框自己关自己的（trapTab 会停止冒泡） */}
      <div className={wide ? 'drawer drawer-wide' : 'drawer'} ref={panel} onKeyDown={trapTab}>
        <header className="panel-head">
          <h2 className="dialog-title">{title}</h2>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => requestClose.current()}
          >
            关闭
          </button>
        </header>
        <UnsavedProvider dirty={local.dirty} markDirty={markDirty}>
          <BusyCtx.Provider value={inner.markDirty}>{children}</BusyCtx.Provider>
        </UnsavedProvider>
        {asking && (
          <ConfirmDialog
            spec={{
              title: '关闭会丢掉这里未提交的内容',
              body: '填了但没提交的内容不会保存（不做本地草稿）。',
              confirmText: '放弃修改',
              danger: true,
            }}
            onConfirm={() => {
              setAsking(false);
              onClose();
            }}
            onCancel={() => setAsking(false)}
          />
        )}
      </div>
    </div>
  );
}
