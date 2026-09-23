/**
 * 职责：样本工厂 ↔ 契约的一致性（L2）——**契约里列出的 Stripe 事件，样本必须造得出来**。
 *
 * @why 假数据的形状一旦与契约脱节，就会造出"契约里根本不会出现的报文"，
 *      于是解析代码按错误的事件类型设计，而所有测试都是绿的。
 *      这条测试的判定依据**完全在本仓库内**：`contracts/api-contract.yaml` 的
 *      `/pay/callback/stripe` 一条 summary 里就列着全部事件名（标注 D-49/D-50）。
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
 * 从契约的 `/pay/callback/stripe` 条目里抽出全部 `xxx.yyy` 形态的事件名。
 * @limitation 事件名写在**路径行的下一行**（`post:` 的 summary 里），
 *             所以取"路径行 + 后续若干行"这一块再匹配，只扫路径行会扫到空。
 */
function eventsInContract(): string[] {
  const lines = YAML.split('\n');
  const at = lines.findIndex((l) => l.includes('/pay/callback/stripe'));
  if (at < 0) throw new Error('契约里找不到 /pay/callback/stripe —— 这条断言失去意义');
  const block = lines.slice(at, at + 8).join('\n');
  // 允许多段：charge.dispute.created 有 2 个点，只吃两段会得到 charge.dispute
  const found = block.match(/\b[a-z][a-z_0-9]*(?:\.[a-z_0-9]+)+\b/g) ?? [];
  const events = [...new Set(found)].filter(
    // checkout.session 单独出现是"对象名"不是事件名，事件名至少 3 段
    (t) => !(t.startsWith('checkout.') && t.split('.').length < 3),
  );
  if (events.length === 0)
    throw new Error(`在 /pay/callback/stripe 区块里没抽到任何事件名，正则可能失效：\n${block}`);
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
