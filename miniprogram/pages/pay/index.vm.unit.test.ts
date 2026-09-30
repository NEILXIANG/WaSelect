/**
 * 职责：支付页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是两个"点了之后看起来成功、实际是坏的"分支：
 *      ① 在途连点（B6 / AJ-201）——多打一次发起支付，白占连接与订单行锁；
 *      ② 换通道不换键 —— 拿到**上一个通道**的支付凭据（付错入口）。
 *      两条都不会报错，所以只能靠纯函数单测逐分支钉住。
 */
import { describe, expect, it } from 'vitest';
import { payStartDecision } from './index.vm.js';

const BASE = { paying: false, channel: 'stripe', lastChannel: '', hasKey: true };

describe('payStartDecision（点一下该做什么）', () => {
  it('正常：发起，且首次不换键', () => {
    expect(payStartDecision(BASE)).toEqual({
      kind: 'start',
      channel: 'stripe',
      retireKey: false,
    });
  });

  it('换通道 → retireKey（沿用旧键会被服务端重放成上一个通道的 intent）', () => {
    expect(payStartDecision({ ...BASE, lastChannel: 'wechat' })).toEqual({
      kind: 'start',
      channel: 'stripe',
      retireKey: true,
    });
  });

  it('同一通道再来一次 → 不换键（重试必须还是同一个键，否则同一张单发起两次）', () => {
    expect(payStartDecision({ ...BASE, lastChannel: 'stripe' })).toEqual({
      kind: 'start',
      channel: 'stripe',
      retireKey: false,
    });
  });

  /**
   * B6 / AJ-201：在途守卫。
   * @why 只断言"不发起"是不够的——`ignore` 也可能来自脏输入；
   *      所以同时钉"同样的输入把 paying 换成 false 就能发起"，
   *      证明挡住它的**确实是在途状态**这一条，而不是别的分支顺手拦下。
   */
  it('上一次发起还在途中 → ignore；放掉 paying 就能发起（B6 / AJ-201）', () => {
    expect(payStartDecision({ ...BASE, paying: true })).toEqual({ kind: 'ignore' });
    expect(payStartDecision({ ...BASE, paying: true, channel: 'wechat' }).kind).toBe('ignore');
    expect(payStartDecision({ ...BASE, paying: false }).kind).toBe('start');
  });

  it('脏输入：channel 不是字符串 / 空串 / 键没就绪 → ignore', () => {
    expect(payStartDecision({ ...BASE, channel: undefined }).kind).toBe('ignore');
    expect(payStartDecision({ ...BASE, channel: 42 }).kind).toBe('ignore');
    expect(payStartDecision({ ...BASE, channel: '' }).kind).toBe('ignore');
    expect(payStartDecision({ ...BASE, hasKey: false }).kind).toBe('ignore');
    // 参数整体不是对象也不能炸（wxml 传错形态时页面只是不动）
    expect(payStartDecision(null).kind).toBe('ignore');
    expect(payStartDecision(undefined).kind).toBe('ignore');
  });
});
