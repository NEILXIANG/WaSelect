/**
 * 职责：通用异常态组件（S4 从设计原型迁入）——**三段式**：发生什么 / 为什么 / 下一步怎么办。
 *
 * @why 三段缺一不可：
 *      · 只说"加载失败" → 用户不知道该等还是该走；
 *      · 只说"网络异常" → 用户以为是自己手机坏了；
 *      · 只给一个"重试"按钮 → 用户不知道重试会不会重复下单、重复扣款。
 *      第三段（怎么办）必须由**业务**回答，不能是通用的"请稍后再试"。
 *
 * @why `kind` 只给五种（loading / empty / offline / gone / fail），**刻意不给第六种**：
 *      每多一种状态就多一种"这个页面用错了状态"的可能，
 *      而"库存不足"应该归到 fail（有库存数字可说）而不是新开一类。
 *
 * @why 图标用**纯 CSS 画的极简符号**，不用图片：异常态最怕"图片加载不出来"，
 *      而它本身就是给异常场景用的——用图片会在"网络异常"时连图标都显示不出来。
 *
 * @limitation 一：动作按钮**走 `ws-button` 而不是原生 `<button>`**（与原型不同，这是刻意偏离）。
 *              生产有一条硬门禁（`page-button-guard`）：连点防线只在 `ws-button` 里有一份。
 *              原型用原生 button 是因为原型没有这条约束；生产里若照抄，
 *              "重试按钮连点两次 = 两条并发请求"这个洞就又开了一次。
 *              ⚠️ 也因此本组件**自己不做**连点守卫——那正是 ws-button 的职责，做第二份即漂移。
 * @limitation 二：`altText`（次要动作）必须写成 **view** 而不是 text：
 *              `hover-class` 只支持 view / button / navigator，写在 `<text>` 上不生效。
 *              原型这里就是 `<text>`，属于迁移时要修的一处（点了没有变淡反馈）。
 * @limitation 三：**不自带 `margin`**：离上下多远是页面的决定（同 ws-button 的口径）。
 * @limitation 四：`compact` 只是一档"更矮的内边距"，不是"第二种形态"。
 *              列表里的空态与整页的空态差的就是呼吸量，多开一档参数就会长出第三种组合。
 *
 * @see ../ws-button/index.js（动作按钮的连点防线在那边）
 * @see ../../../waselect-design/components/state-block（S4 迁移源）
 */
Component({
  /**
   * ⚠️ `styleIsolation: 'apply-shared'`：**必须**给。
   * @why 自定义组件默认 `isolated`：`app.wxss` 与页面样式对组件内部无效
   *      （除 font / color 这类继承属性）。本组件的 wxml 与内部按钮用了
   *      `.ws-press`（全站统一按下态）等基础类，默认隔离下它们不生效，
   *      表现是"点了没有变淡反馈"——编译不报错，只有真机看得出。
   * @see ../ws-pick-card/index.js（同一处说明，写得更细：为什么不用 `shared`）
   */
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** `loading` / `empty` / `offline` / `gone` / `fail`。越界值 → 不画符号（见 index.wxml）。 */
    kind: { type: String, value: 'empty' },
    /** 第一段：发生了什么。一句人话，**不写错误码**。 */
    title: { type: String, value: '' },
    /** 第二段：为什么（也可以是"影响范围"）。 */
    reason: { type: String, value: '' },
    /** 第三段主动作文案。空串 = 不渲染动作区。 */
    actionText: { type: String, value: '' },
    /** 次要动作文案（如"返回首页"）。空串 = 不渲染。 */
    altText: { type: String, value: '' },
    /** 更矮的内边距（列表内的空态用）。@see @limitation 四 */
    compact: { type: Boolean, value: false },
    /**
     * 报障小字（剩余清单 4-6）：`错误码 40002 · 链路 abcdef12`，由 utils/error-text.js `errorRef` 产出。
     * 空串 = 不渲染。主文案（title / reason）仍然**不写错误码**——码只在这一行小字里，给客服看。
     */
    refText: { type: String, value: '' },
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    },
    onAlt() {
      this.triggerEvent('alt');
    },
  },
});
