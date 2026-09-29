/**
 * 职责：`app/admin-order-routes.ts` 的**源码层**断言（B8 / AJ-192）。
 *
 * @why 只占一件小事：**退款的通道解析必须早于"落 refunding"**。
 *      这条顺序的**后果**由 `admin-order-routes.db.test.ts` 的两条 B8 用例守（真库：
 *      通道没了的时候订单必须仍是 paid、且没有 refunding 事件），
 *      但那个行为断言挡不住一种形态——把解析留在事务**内**、只是挪到 `markRefunding` 之后。
 *      那种写法今天行为等价（事务照样回滚），可它把"先确认通道可用、再动状态"这个
 *      论证从代码里拿掉了：哪天 `getForRefund` 改成返回 `undefined` 而不是抛错，
 *      订单就会先迁 refunding 再发现没有 provider——正是 B8 修掉的那个现场。
 *
 * @how 读源码文本做位置断言，且**先剥注释行**：注释里出现同款字符串会让这类断言假绿
 *      （§2 第 54 条——本文件自己的头注释里就写满了 `getForRefund`，不剥就是自证）。
 *
 * @limitation 是**形态**检查，不是架构审查：它挡得住"搬回事务外"和"挪到落库之后"，
 *              挡不住有人把整段逻辑抽到别的文件去（那时本文件的路径常量会先红）。
 *
 * @measured 注入「把解析搬回事务外」→ db 的 B8 用例红 1 条（订单进了 refunding）；
 *           注入「把解析留在事务内、挪到 markRefunding 之后」→ **db 全绿、本文件红 1 条**。
 *           第二个结果正是本文件存在的理由：那个形态在行为层看不出来。
 *
 * @see ./admin-order-routes.ts（被测）；./admin-order-routes.db.test.ts（行为层）；
 *      docs/自主决策记录.md AJ-192
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('./admin-order-routes.ts', import.meta.url), 'utf8');

/**
 * 剥掉注释行后的代码。
 * @why 见文件头 @how：不剥的话，本文件与被测文件的头注释里那些 `getForRefund`
 *      会让"位置早于 markRefunding"这条断言在**实现被改坏时照样绿**。
 */
const CODE = SRC.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/** 剥注释后某串出现的次数（0 = 根本没有）。 */
function countOf(needle: string): number {
  return CODE.split(needle).length - 1;
}

describe('B8（AJ-192）：退款的通道解析只有一处，且早于落 refunding', () => {
  it('剥注释后确实扫到了这段路由（防空跑：文件改名 / 路由搬走时这里先红）', () => {
    expect(countOf('markRefunding(')).toBeGreaterThan(0);
    expect(CODE).toContain('/refund');
  });

  // @why 两处解析 = 迟早只有一处被改：事务内外的两个"通道可用性"判定会漂成两套口径，
  //      而"哪一套生效"取决于调用顺序，不看代码回答不了。
  it('getForRefund( 在剥注释后的源码里只出现一次', () => {
    expect(countOf('getForRefund(')).toBe(1);
  });

  it('getForRefund( 的位置早于 markRefunding(（先确认通道可用，再动状态）', () => {
    const resolve = CODE.indexOf('getForRefund(');
    const write = CODE.indexOf('markRefunding(');
    expect(resolve, '源码里找不到 getForRefund(').toBeGreaterThan(-1);
    expect(write, '源码里找不到 markRefunding(').toBeGreaterThan(-1);
    expect(resolve).toBeLessThan(write);
  });
});
