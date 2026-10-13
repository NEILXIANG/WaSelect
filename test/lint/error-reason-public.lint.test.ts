/**
 * 职责：钉住「**前端据以分支的成因必须进响应体**」这件事——`AppError` 的 `reason` 写错参数位置就红。
 *
 * @why `AppError(code, details, publicData)` 的第 2 个参数是 details，`toErrorResponse` **结构上不输出**
 *      它（`server/src/errors.ts` @limitation 一：details 常带 SQL / 上游返回体 / 内部 ID，属外泄面）。
 *      只有第 3 个参数（publicData）会变成响应体的 `data`。于是同一个 `reason: 'x'` 写在
 *      第 2 参还是第 3 参，决定它"只进日志"还是"前端看得到"——**而这两种写法在代码里长得几乎一样**。
 *      本轮规律排查（2026-10-13）在全仓数了 254 处带 reason 的 `AppError`，其中 **252 处写在第 2 参**；
 *      逐个核对"前端有没有读这个码的 reason"之后，真实坏掉的是下面两处（都在本文件的 TAB 里）：
 *
 *      - `server/src/app/auth.ts` 40301 `blocked` → 小程序 `utils/error-text.js` 的
 *        `isAccountBlocked(err)` 读 `err.data.reason`。写在 details 上 ⇒ 判据**恒为 false** ⇒
 *        真被拉黑的买家被告知"服务暂时不可用"、还留着重试按钮（而客服查不出任何问题）。
 *      - `server/src/app/admin-auth-routes.ts` 42901 `admin_account_locked` →
 *        管理端 `auth-view.ts:92` 靠它把"口令错太多次被锁"与"同一来源抽水被限流"分开说
 *        （42901 两种成因共用一个码，后者由 `rate-limit.ts` 抛裸 `AppError(42901)`、**不带 data**）。
 *        写在 details 上 ⇒ 判据恒为 false ⇒ 被锁的管理员被明确告知"**这不是密码问题**"——
 *        而它恰恰就是密码问题，且指示他去查一个不存在的 IP 抽水。
 *
 * @why 这两处的共同失效方式是"**静默说错话**"：不报错、不崩溃、测试全绿（单测里前端喂的是
 *      手搓的 `{code, data:{reason}}`，形状比真实服务端**多**了一个字段，规律⑤的典型形态）。
 *      所以只靠"行为用例"不够，这里再加一道**源码形状**检查：那个 reason 必须在 publicData 里。
 *
 * @why 登记范围定为"**契约明确承诺 / 前端明确在读**的对外成因"，不只"曾经写错的"：
 *      2026-10-13 那次核对还查出第三处——契约 `/admin/orders/{id}/shipment/revert` 的说明里
 *      早就写了 `409 / 40902 data.reason = status_<状态> / revert_window_passed / after_sale_open`，
 *      而实现把 reason 放在 details 上（连 `data` 都没有）。**契约承诺了、实现没兑现**这一类
 *      最容易被"契约已经写了"这句话骗过去：写的人以为在描述现状，读的人以为已经实现。
 *      所以表里同时收"契约承诺对外"与"前端在读"两种，它们的共同点是：**这个字段一旦回到
 *      details，就是一处静默的功能缺失**。
 *
 * @limitation 一：这是一张**登记表**，不是穷举扫描。为什么不做成"凡是前端读 reason 就必须有 publicData"
 *              的自动判定：本仓的 reason 大量经 `conflict()` / `deny()` / `loginLocked()` 这类
 *              小助手转手（字面量在调用点、publicData 在助手体里），文本扫描跟不上这个数据流；
 *              而**只**扫"前端有没有读"又拿不到可靠结论。登记表至少保证：**表里这几处不会再退回去**。
 *              （真正的根治不是加检查，是让 `publicData` 不能靠"数第几个参数"来写——见
 *               `docs/规律总结与全仓排查` 的建议一节。）
 * @limitation 二：只校验"第 3 个参数里出现了这个**字面形状**"。`reasons: {...}` 包一层、
 *              或把 reason 放进变量再传（`const d = { reason: x }; AppError(c, d, d)`），
 *              本文件判不出来（但那种写法**是对**的，属于漏保不是误红）。
 *              已知不在表里的两种安全形状：`domain/address-input.ts` 的 `AppError(40002, data, data)`
 *              （第 3 参 = 第 2 参，`field` / `reason` 一起出去）与 `domain/quote.ts` 40901 的显式
 *              publicData——两者都有 db 用例断言响应体，故不重复登记。
 * @limitation 三：不校验前端侧——"前端到底该不该读这个字段"是产品判断，机器判不了。
 *
 * @see server/src/errors.ts（details vs publicData 的取舍原文）；server/src/app/auth.ts:224 起；
 *      server/src/app/admin-auth-routes.ts 的 `loginLocked()`；contracts/api-contract.yaml
 *      （/admin/orders/{id}/shipment/revert 的 409、40902 的 data.reason、42901 / 40301）；
 *      docs/自主决策记录.md AJ-519
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

interface Entry {
  /** 承载它的文件（相对仓库根）。 */
  file: string;
  /** 该文件里必须出现在某个 `AppError` **第 3 个参数**里的片段。 */
  publicDataNeedle: string;
  /** 谁在读它（报错信息里指给人看）。 */
  who: string;
}

/**
 * 契约承诺对外 / 前端在读的成因（每条都能指到"谁在等这个字段"）。
 * @why 不登记那些**已经安全、且无人读**的（例如 40001 参数校验的一大批 reason：它们刻意只进日志，
 *      契约里也写明"reason 只进日志"）。本表每加一条都要能回答"读不到会说什么错话"。
 */
const ENTRIES: Entry[] = [
  {
    file: 'server/src/app/auth.ts',
    publicDataNeedle: "reason: 'blocked'",
    who: 'miniprogram/utils/error-text.js::isAccountBlocked（读 err.data.reason；读不到会把"被拉黑"说成"服务不可用"）',
  },
  {
    file: 'server/src/app/admin-auth-routes.ts',
    publicDataNeedle: "reason: 'admin_account_locked'",
    who: 'admin-web/src/auth-view.ts:92（读 err.data?.[reason] 分辨锁定与限流；读不到会说"这不是密码问题"）',
  },
  {
    file: 'server/src/app/admin-order-fix-routes.ts',
    publicDataNeedle: 'reason: gate.reason',
    who: '契约 /admin/orders/{id}/shipment/revert 的 409/40902（data.reason 是契约承诺；读不到只余"状态不允许"）',
  },
  {
    file: 'server/src/app/admin-order-fix-routes.ts',
    publicDataNeedle: "reason: 'status_raced'",
    who: '同上路由的第二道（与上一条要**同形状**：一个有 data 一个没有，调用方就没法判）',
  },
  {
    file: 'server/src/app/admin-order-routes.ts',
    publicDataNeedle: "reason: 'partial_refund_in_flight'",
    who: 'admin-web/src/orders/view.ts::refundFailureNotice（契约 0.6.79 ③ / AJ-456 承诺 data.reason）',
  },
  {
    file: 'server/src/app/admin-order-routes.ts',
    publicDataNeedle: "reason: 'fully_refunded_by_partials'",
    who: '同上（读不到就只剩"状态不允许"，运营不知道该去查在途退款还是没额度了）',
  },
  {
    file: 'server/src/app/admin-order-routes.ts',
    publicDataNeedle: 'reason: lostGate.reason',
    who: '契约 0.6.90（AJ-516）：整单退款 40907 的 data.reason = dispute_lost；admin-web `refundFailureNotice` 在读',
  },
  {
    file: 'server/src/app/after-sale-routes.ts',
    publicDataNeedle: '{ reason }',
    who: '契约 0.6.56 ②：售后处理 40902 的 data.reason（conflict() 转手；小程序 + 管理端都在读）',
  },
];

/** 括号配对的取参（与 batch-2 那条门禁同一套做法：不看注释里的示例，只看真实代码）。 */
function callArgs(src: string, openIdx: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (quote !== '') {
      if (c === '\\') {
        cur += c + (src[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(cur);
        return args;
      }
    }
    if (c === ',' && depth === 1) {
      args.push(cur);
      cur = '';
      continue;
    }
    if (depth >= 1) cur += c;
  }
  args.push(cur);
  return args;
}

describe('错误成因（reason）必须进响应体才可能被前端读到', () => {
  it(`🔴 ${String(ENTRIES.length)} 处的 reason 写在 publicData（第 3 参）里，不是 details（第 2 参）`, () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      const src = readFileSync(resolve(root, e.file), 'utf8');
      const found = src
        .split('new AppError')
        .slice(1)
        .some((chunk) => {
          const open = chunk.indexOf('(');
          if (open < 0) return false;
          const args = callArgs(chunk, open);
          const publicData = args[2] ?? '';
          return publicData.includes(e.publicDataNeedle);
        });
      if (!found)
        bad.push(
          `${e.file}：没有一处 AppError 的第 3 个参数含 \`${e.publicDataNeedle}\`` +
            `（${e.who} 要读它，写在第 2 参上时响应体里没有 data，那个分支会静默失效）`,
        );
    }
    expect(
      bad,
      `这些原因写进了"只进日志"的参数，前端永远读不到：\n${bad.join('\n')}\n` +
        `改法：\`new AppError(码, { …只进日志的细节… }, { reason: '…' })\`——第三个参数才是响应体的 data`,
    ).toEqual([]);
  });
});
