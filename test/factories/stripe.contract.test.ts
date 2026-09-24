/**
 * 职责：样本工厂 ↔ 契约的一致性（L2）——**契约里列出的 Stripe 事件，样本必须造得出来**。
 *
 * @why 假数据的形状一旦与契约脱节，就会造出"契约里根本不会出现的报文"，
 *      于是解析代码按错误的事件类型设计，而所有测试都是绿的。
 *      这条测试的判定依据**完全在本仓库内**：`contracts/api-contract.yaml` 的
 *      `/pay/callback/{channel}` 下 `x-provider-events.stripe` 一行就列着全部事件名（标注 D-49/D-50）。
 *      这就把"该听谁的口径"从争论变成一次 `git diff`。
 *
 * @limitation 用正则从 summary 里抽事件名，**不是**真正的 YAML 解析：
 *             契约改成结构化枚举后，这里应当改为读结构化字段（更强的保证）。
 *             在改之前，正则能覆盖当前写法，且写错会让"覆盖数"归零从而立刻变红。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STRIPE_EVENTS_NOT_SAMPLED,
  STRIPE_EVENT_TYPES,
  objectForEvent,
  stripeEvent,
} from './stripe.js';

const YAML = readFileSync(new URL('../../contracts/api-contract.yaml', import.meta.url), 'utf8');

/**
 * 从契约的**统一回调入口**条目里抽出 stripe 通道登记的全部 `xxx.yyy` 形态事件名。
 *
 * @why 定位方式改成"先锚定 `/pay/callback/{channel}`，再往下找以 `stripe:` 开头的行"：
 *      F11 把 `/pay/callback/{channel}` 两条路由合并成一条之后，事件清单不再挂在
 *      某个专属路径上，而是挂在 `x-provider-events.stripe` 上（见契约该处注释）。
 *      硬找 `/pay/callback/stripe` 会永远找不到而抛错——那是**契约演进**导致的，
 *      不是缺陷；但它也不能靠"放宽成找 `stripe` 这个词"来修：
 *      统一入口的 summary 里本来就有 "mock / wechat / stripe" 字样，
 *      一放宽就会把说明文字当成事件清单，测出**假绿**。
 *      所以锚点必须精确到"路径行 + 以 stripe: 开头的清单行"两层，缺任一层都抛错。
 *
 * @limitation 仍然是正则刮文本，不是真 YAML 解析；契约改成结构化枚举后这里应改读字段。
 *             现在靠"抽不到就抛错"兜底（@see 文件头 @limitation）。
 */
function eventsInContract(): string[] {
  const lines = YAML.split('\n');
  // ⚠️ 必须是**路径行**（缩进两级 + 结尾冒号），不能只 `includes`：
  //    `info.description` 里也提到了这个路径，含糊匹配会锚到文件开头，
  //    然后在那里找到一个碰巧以 `stripe:` 开头的行（或找不到）→ 假绿 / 假红。
  const anchor = lines.findIndex((l) => /^\s{2}\/pay\/callback\/\{channel\}:$/.test(l));
  if (anchor < 0) throw new Error('契约里找不到 /pay/callback/{channel} —— 这条断言失去意义');
  const at = lines.findIndex((l, i) => i > anchor && /^\s*stripe:/.test(l));
  if (at < 0) throw new Error('契约的统一回调入口里找不到 stripe: 事件清单行 —— 这条断言失去意义');
  // `?? ''` 只为类型（`noUncheckedIndexedAccess`）：at 已经校验过，取不到就会走到下面的"没抽到任何事件名"
  const block = lines[at] ?? '';
  // 允许多段：charge.dispute.created 有 2 个点，只吃两段会得到 charge.dispute
  const found = block.match(/\b[a-z][a-z_0-9]*(?:\.[a-z_0-9]+)+\b/g) ?? [];
  const events = [...new Set(found)].filter(
    // checkout.session 单独出现是"对象名"不是事件名，事件名至少 3 段
    (t) => !(t.startsWith('checkout.') && t.split('.').length < 3),
  );
  if (events.length === 0)
    throw new Error(`在 stripe 事件清单行里没抽到任何事件名，正则可能失效：\n${block}`);
  return events;
}

describe('样本工厂覆盖契约声明的 Stripe 事件', () => {
  it('契约里列出的事件都能造出样本（豁免名单除外）', () => {
    const declared = eventsInContract();
    expect(declared.length).toBeGreaterThan(0);
    const sampled = Object.values(STRIPE_EVENT_TYPES) as readonly string[];
    const missing = declared.filter(
      (e) => !sampled.includes(e) && !STRIPE_EVENTS_NOT_SAMPLED.includes(e),
    );
    expect(missing, `这些事件契约里声明了却没有样本：${missing.join(', ')}`).toEqual([]);
  });

  it('主事件是 checkout.session.completed（D-49 的口径，不是 payment_intent）', () => {
    expect(STRIPE_EVENT_TYPES.checkoutCompleted).toBe('checkout.session.completed');
    expect(Object.values(STRIPE_EVENT_TYPES)).toContain('checkout.session.completed');
    expect(Object.values(STRIPE_EVENT_TYPES)).toContain('checkout.session.expired');
  });

  it('每个有样本的事件都能配上正确的 data.object 形状', () => {
    for (const type of Object.values(STRIPE_EVENT_TYPES)) {
      const obj = objectForEvent(type);
      expect(typeof obj.object, `${type} 的 object 字段缺失`).toBe('string');
      const e = stripeEvent(type, obj);
      expect(e.data.object.object).toBe(obj.object);
      expect(e.type).toBe(type);
    }
  });

  it('豁免名单里的事件确实还没造样本（有人补了样本却忘了移出名单，立刻暴露）', () => {
    const sampled = Object.values(STRIPE_EVENT_TYPES) as readonly string[];
    for (const e of STRIPE_EVENTS_NOT_SAMPLED) {
      expect(sampled.includes(e), `${e} 已有样本，应从 STRIPE_EVENTS_NOT_SAMPLED 移除`).toBe(false);
    }
  });
});
