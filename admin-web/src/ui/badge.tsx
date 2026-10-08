/**
 * 职责：统一的状态徽章（彩色胶囊）——对标 §5「状态徽章」P1（AJ-400）。
 *
 * @why 一个组件、六个色调，颜色只走 design token（`--ws-color-*`，约束五）：
 *      各页自己写 `<span className="error">` 的结果是同一个"拒付"在三个页面三种样子。
 * @why 徽章里**一定有字**：颜色不是唯一信号（对标 §5 可访问性一行；色弱运营分不清黄与棕）。
 * @limitation 只管样子，不管"什么状态用什么色"——那是业务口径，放在调用方的纯函数里
 *             （订单见 ../orders/badges.ts），这里改不动业务含义。
 */
import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'warn' | 'info' | 'success' | 'muted' | 'danger';

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
