/**
 * 职责：表单字段容器（S4 从设计原型迁入）——标签 + 控件（slot）。
 *
 * @why 用 **slot** 装控件而不是把 `<input>` 写死在组件里：表单控件有
 *      `<input>` / `<textarea>` / `<picker>` / 开关 好几种，写死一种就等于
 *      "field 只能用于文本框"，于是表单里剩下的控件各写各的容器，
 *      最后"这一页有两种字段间距"（与组件要解决的问题正好相反）。
 *
 * @limitation 一：`options.multipleSlots` 显式给 **false**（与原型一致）。
 *              只有一个默认 slot 时开多槽会让 `slot="..."` 的拼写错误**静默**
 *              ——写错名字的控件直接不渲染，且不报错（最难查的一类）。
 * @limitation 二：**不带错误文案槽位**：字段级错误由页面在 slot 里自己放。
 *              @why 错误文案的位置（输入框下方 / 右侧 / 顶部汇总）在不同表单里不同，
 *              而"错误长什么样"是**页面**该统一的口径，不是 field 该决定的。
 * @limitation 三：底部分隔线由 `:last-child` 去掉，**不是**由页面传参控制。
 *              @why 传一个 `last: Boolean` 让页面判断，等于把"是不是最后一个"
 *              这件组件自己看得到的事交给页面去记——漏传就多一条悬空的线。
 *
 * @see ../../pages/address-edit/index.wxml（S4 后用它装七个字段）
 * @see ../../../waselect-design/components/field（S4 迁移源）
 */
Component({
  options: { multipleSlots: false },
  properties: {
    /** 字段标签（小字，弱化——它服务于控件，不与控件争注意力）。 */
    label: { type: String, value: '' },
  },
});
