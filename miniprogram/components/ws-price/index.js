/**
 * 职责：价格展示组件（F14 六个基础组件之一）——把「JPY 唯一锚」这条口径落到 UI 上。
 *
 * @why 它是唯一一个"口径级"的基础组件：项目规定 **JPY 是唯一定价锚＝结算币＝记账币**，
 *      USD 只是派生展示价。若每个页面各自拼 `¥` + 数字，这条口径就会在 UI 层悄悄松动——
 *      表现为"某个页面显示了另一种货币"，而没有任何东西报错。
 *      收敛成一个组件之后，"价格长什么样"只有一处答案。
 *
 * @why 格式化放在 `utils/price-format.js` 而不是写在组件里：
 *      组件只负责"把格式化结果渲染出来"，于是格式化既能被单测直接钉住（17 条），
 *      将来购物车合计之类的非组件场景也能复用。这里是**组合**，不是实现。
 *
 * @limitation 一：`jpy` **不设默认值、也不声明 `type: Number`**——漏传 / 传了坏数据时
 *              `formatJpy` 会抛，于是这个组件渲染**空白**并在控制台留下一条明确报错。
 *              ⚠️ 刻意不用 `type: Number`：实测（simulate）漏传时框架会把数字属性**补成 0**，
 *              于是静默显示 `¥0`——而 `¥0` 会被用户读成"免费"，那是价格组件最贵的失败形态。
 *              用 `type: null`（不做类型转换）之后漏传是 `null` / `undefined`，直接落到抛错分支。
 *              ⚠️ 另需知道：生命周期里的异常会被框架的 `safeCallback` **捕获并打到控制台**，
 *              **不会**冒泡给调用方——所以"响亮"的意思是"空白 + 控制台报错"，不是"抛给页面"。
 * @limitation 二：只有 `sm / md / lg` 三档尺寸，且**只影响字号**（走 design token）。
 *              刻意不提供"任意字号"属性：能传任意值的组件等于把版式决定权交回给调用方，
 *              最后又是"每页一个尺寸"。
 * @limitation 三：本组件的 `.js` 里 **import 的模块必须是 `.js`**，不能是 `.ts`。
 *              @why 它是被 `miniprogram-simulate` 用 Node 的 `require` 加载的，
 *              解析不到 `.ts`（vite 的 `.js → .ts` 映射只在测试侧有效）。
 *              实测过：import 一个 `.ts` 会直接 `Cannot find module … .js`。
 *
 * @see ../../utils/price-format.js（格式化真源）；docs/地基搭建清单.md F14
 */
import { formatJpy } from '../../utils/price-format.js';

Component({
  properties: {
    /**
     * 日元金额（整数；含税价可带小数，由格式化函数四舍五入）。
     * ⚠️ `type: null` 是刻意的：换成 `type: Number` 会在漏传时被补成 0 → 显示 `¥0`。
     * @see @limitation 一
     */
    jpy: { type: null },
    /** 尺寸档位：`sm` / `md` / `lg`。@see @limitation 二 */
    size: { type: String, value: 'md' },
  },

  data: {
    /** 渲染用的文案。**只在 `update()` 里被赋值**，wxml 不做任何字符串拼接。 */
    text: '',
  },

  // ⚠️ `attached` 与 `observers` 都要调：
  //    `observers` 只在**属性变化**时触发，若页面一次都没传（初始值缺失），
  //    只剩 `attached` 能让它响亮失败——那正是 @limitation 一 要的行为。
  attached() {
    this.update();
  },
  observers: {
    jpy() {
      this.update();
    },
  },

  methods: {
    /** 重算展示文案。@throws 金额不是有限数时原样抛出（不吞、不兜底） */
    update() {
      this.setData({ text: formatJpy(this.data.jpy) });
    },
  },
});
