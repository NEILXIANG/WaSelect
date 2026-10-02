/**
 * 职责：区块标题组件（S4 从设计原型迁入）——英文小标 + 中文衬线主标 + 右侧「全部」。
 *
 * @why 收进组件而不是每个页面各写一段 `<text class="ws-section-kicker">` + `<text class="ws-section-title">`：
 *      S3 结束时已经有 **4 个页面**（address / address-edit / legal / user）各写了一份页头，
 *      四份的层数、间距、类名各不相同。改一次版式要改四个地方，漏一个就是
 *      "同一个 App 里两种标题"——而这正是 S1 用别名桥接要消灭的那类分裂。
 *
 * @why 英文小标（kicker）**不是装饰**：它给中文标题一个"栏目感"，
 *      让用户意识到下面是**被编排过的内容**，不是无限下拉的商品流。
 *      所以它是组件的独立属性，不是页面自己拼的一段文案——
 *      拼在页面里的话，"这个区块到底有没有栏目感"就没人管了。
 *
 * @limitation 一：`more`（右侧"全部"）**只给文案，不自带跳转**。
 *              跳转目标每个区块都不同（分类页 / 专题页 / 暂无），
 *              组件一旦认识页面路径，它就不再是"可在任意页面复用的一块版式"。
 *              与首页 `intentForProduct` 同一口径：**组件不认识路径**。
 * @limitation 二：`title` 为空时**不报错**，渲染一个只有 kicker 的标题块。
 *              @why 它是纯展示组件，"没标题"的后果只是页面上少一行字，
 *              为它抛错会让一个排版问题变成一次白屏（走 safeCallback 的话）。
 *
 * @see ../../app.wxss（`.ws-section-kicker` / `.ws-section-title` 的真源）
 * @see ../../../waselect-design/components/section-head（S4 迁移源）
 */
Component({
  /**
   * ⚠️ `styleIsolation: 'apply-shared'`：**必须**给。
   * @why 自定义组件默认 `isolated`：`app.wxss` 的样式对组件内部无效。
   *      本组件的 wxml 用的 `.ws-section-kicker` / `.ws-section-title` / `.ws-section-more`
   *      全在 app.wxss 里，默认隔离下它们不生效——标题会变成无样式的默认字号，
   *      而编译不报错。
   * @see ../ws-pick-card/index.js（同一处说明，含为什么不用 `shared`）
   */
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 英文小标（全大写 + 字距），如 `Address Book`。空串 = 不渲染这一行。 */
    kicker: { type: String, value: '' },
    /** 中文主标（衬线）。 */
    title: { type: String, value: '' },
    /** 右侧「全部 / 更多」文案。空串 = 不渲染。@see @limitation 一 */
    more: { type: String, value: '' },
  },
});
