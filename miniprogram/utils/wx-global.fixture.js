/**
 * 职责：**夹具**——故意直接引用宿主全局 `wx`，用来验证 ESLint 那条 `no-restricted-globals` 真的生效。
 *
 * @why 规则被删 / 被改坏时，`npm run lint` 会**全绿**——因为全仓已经没有直接引用 `wx` 的代码了
 *      （这恰恰是规则生效的证据，却也让规则失去守卫）。这类失效只能靠夹具发现：
 *      它永远在那里违规，规则一没它就"不红了"。
 *      与 `test/lint/layering` 同一套路（AJ-3 / AJ-19 / AJ-43 的"门禁的门禁"）。
 *
 * @how 违规用**内联 `eslint-disable`** 压住：于是 `npm run lint` 保持 0 错，
 *      但 `suppressedMessages` 里会出现这条——测试断言的是"规则报了"，不是"CLI 输出 0 行"。
 *      ⚠️ 注意断言必须看 `suppressedMessages`：只看 CLI 退出码分不清"规则生效"与"规则被删"。
 *
 * ⚠️ 本文件**不是业务代码**，不要被任何模块 import；它只在单元测试里被 ESLint 读。
 *    已加入 `project.config.json` 的 packOptions.ignore，不会被打进小程序包。
 *
 * @limitation 它只能证明"规则会对 `wx` 这个全局名报错"，证明不了规则**覆盖的文件范围**对不对
 *             ——若哪天 ESLint 里那条 `files` 的 glob（miniprogram 下的 js 与 ts）被改窄，
 *             而夹具恰好还在范围内，
 *             本夹具照样红。范围这件事靠的是**业务文件真的在范围内**（`request.js` 就是活的证明）：
 *             有人绕开封装时，`npm run lint` 自己会红，不需要夹具。
 * @see ../../test/lint/wx-global.lint.test.ts（读本夹具并断言规则报了）；../../../eslint.config.mjs 的
 *      no-restricted-globals block；docs/自主决策记录.md AJ-65
 */

// eslint-disable-next-line no-restricted-globals -- 夹具：就是要违规，用来证明规则会报
export const bad = wx.getStorageSync('token');

// eslint-disable-next-line no-restricted-globals -- 同上
export const alsoBad = wx.request;
