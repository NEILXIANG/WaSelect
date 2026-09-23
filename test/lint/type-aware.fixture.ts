/**
 * 职责：类型感知 lint 规则（A5）的**待测夹具**——故意违反那三条规则。
 *
 * @why 光看 `npm run lint` 全绿证明不了规则在起作用：把整个 A5 block 删掉，
 *      它也是全绿。所以需要一份"必然触发三条规则"的样本，让机器去断言
 *      "规则确实报了"，而不是靠人记得去注回缺陷。
 *
 * @how 每条违规都带**内联 `eslint-disable-next-line`**：
 *      - 于是 `npm run lint` 对全仓仍然 0 错（这些错被压住了，不进 `messages`）；
 *      - 但 ESLint 会把它们记进结果的 `suppressedMessages`，测试就能读到。
 *      副作用反而是双保险：一旦有人删掉 A5 block，这些 disable 指令变成"未被使用"，
 *      `suppressedMessages` 变空 → 测试立刻红。
 *
 * @limitation 一：这个文件**不会被任何业务代码引用**，是纯样本。
 *              若将来某条规则的报错形态变了，这里要跟着改——那时测试红是**正确信号**，不是噪音。
 * @limitation 二：⚠️ `no-misused-promises` 的样本**不能**写成 `if (somePromise())`。
 *              那个形态 TypeScript 自己就报 TS2801（"Promise 恒为真"），
 *              `npm run typecheck` 会先红，轮不到 ESLint。所以这里用
 *              `forEach(async …)`——TS 允许、而 ESLint 必须报的那一种。
 */
import express from 'express';

async function fetchThing(): Promise<number> {
  return 1;
}

export async function floatingProbe(): Promise<void> {
  // 忘了 await：Promise 被丢弃，错误永远不会浮上来。
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  fetchThing();
}

/**
 * `forEach` 传 async 回调：错误被静默吞掉，而且**根本不会串行等待**。
 * @why 这一条正是"为了 Express 去关 `checksVoidReturn.arguments` 就会放过"的形态——
 *      放在这里是防止有人做那个取舍（见 eslint.config.mjs A5 block 的实测注释）。
 */
export function misusedProbe(): void {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  [1, 2, 3].forEach(async (n) => {
    await fetchThing();
    void n;
  });
}

type OrderState = 'created' | 'paid' | 'shipped' | 'cancelled';

export function switchProbe(state: OrderState): string | undefined {
  // 少处理 'cancelled'：状态机加状态时，这里是典型漏改点。
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (state) {
    case 'created':
      return 'new';
    case 'paid':
      return 'done';
    case 'shipped':
      return 'gone';
  }
}

export const app = express();

/**
 * 反向边界：Express 5 的 async handler **不该**被 `no-misused-promises` 报红。
 * @why @types/express 5 的 `RequestHandler` 返回 `void | Promise<void>`，
 *      async handler 在类型上本来就合法（实测确认，见 eslint.config.mjs A5 block 的 ⚠️ 注释）。
 *      这条样本的作用是钉住"别为了 Express 去关 `checksVoidReturn.arguments`"——
 *      关了会连带放过 `arr.forEach(async …)` 那种真正会吞错误的写法。
 */
app.get('/async-handler', async (_req, res) => {
  res.json(await fetchThing());
});
