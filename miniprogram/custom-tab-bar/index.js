/**
 * 职责：自定义底部 tabBar（S5，2026-10-02 从设计原型迁入）。
 *
 * @why 目录名**必须**是 `custom-tab-bar` 且**必须**放在小程序根下：
 *      这是微信的约定（`app.json` 里 `tabBar.custom: true` 时宿主按这个名字找组件），
 *      改名或挪位置的表现是"底部栏不出现"，且不报任何错——
 *      编译通过、页面正常，只有真机上看得到缺了什么。
 *
 * @why 四个 tab 是 **首页 / 购物车 / 订单 / 我的**，不是原型的"首页 / 发现 / 购物车 / 我的"：
 *      生产没有「发现」页（那是原型为"编辑精选 + 生活场景"造的入口，而这两块
 *      在本项目里都还没有数据）。换上**订单**是替换不是新增——
 *      订单页此前只能从「我的」二级菜单进，而"付完款回到首页之后订单就找不到了"
 *      正是 `pages/user/index.vm.js` 文件头记下的那条欠账。
 *
 * @why **纯文字**，没有图标槽位（沿用原型口径）：
 *      图标要额外引入 8 个图片资源（2 态 × 4 项），既占主包又逼着做一套"日式线性图标"；
 *      而纯文字 tab 本身就是杂志目录栏的形态，与品牌调性一致。
 * @why 选中态用**一条下划线**而不是"变色 + 加粗"：
 *      下划线是"目录里你翻到这一页"，加粗变色是"App 导航栏"——前者才是我们要的语气。
 *
 * @limitation 一：`active` **由每个 tab 页在 `onShow` 里注入**（`getTabBar().setData({active})`），
 *              组件自己**不推导**当前页。
 *              @why 组件拿不到"现在显示的是哪个 tab 页"——`getCurrentPages()` 能拿到，
 *              但那是在组件里放第二份"路径 → 序号"的映射，与本组件的 `list` 重复；
 *              两份映射漂移的表现是"人在购物车、高亮却在首页"，且不报错。
 *              ⚠️ 因此 **S5 的三个产物必须同一次提交**：本组件 + `tabBar.custom` +
 *                  四个 tab 页的 `onShow`。缺任何一个的表现都是"高亮不动"。
 * @limitation 二：切换用 **`wx.switchTab`**（经 `utils/wx-api.ts` 登记），不能用 `navigateTo`：
 *              后者跳 tab 页会被宿主直接拒绝（`can not navigate to tabBar page`），
 *              表现是"点了没反应"。同理，tab 页**不能带 query**——
 *              页面间传状态只能走全局。
 * @limitation 三：点**当前** tab 直接 return（不重复切）：
 *              重复 switchTab 的表现是页面重建一次（滚动位置丢、列表重新取数），
 *              而用户只是手指抖了一下。
 *
 * @see ../../waselect-design/custom-tab-bar（S5 迁移源）；../app.json（tabBar.list）
 */
import { createWxApi } from '../utils/wx-api.js';

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

Component({
  /**
   * ⚠️ `styleIsolation: 'apply-shared'`：**必须**给。
   * @why 自定义组件默认 `isolated`：`app.wxss` 的样式对组件内部无效。
   *      本组件的 wxml 用了 `.ws-press`（全站统一的按下反馈），默认隔离下它不生效——
   *      表现是"点 tab 没有任何反馈，用户以为没点到"，且编译不报错。
   * @see ../components/ws-pick-card/index.js（同一处说明，含为什么不用 `shared`）
   */
  options: { styleIsolation: 'apply-shared' },

  data: {
    /**
     * 当前选中的 tab 序号；由 tab 页的 `onShow` 注入（@see @limitation 一）。
     * @why 初值 0（首页）只是"还没注入时的兜底"，不是"默认首页"——
     *      真正的高亮永远来自页面注入。
     */
    active: 0,
    /**
     * tab 清单。**顺序必须与 `app.json` 的 `tabBar.list` 一致**。
     * @why 它是第三份"路径 → 序号"映射（另两份是 app.json 的 list 与四个页面的
     *      `onShow` 常量），三份必须同步；由本目录的守卫测试断言一致性，
     *      不靠 review 记得。
     */
    list: [
      { pagePath: '/pages/home/index', text: '首页' },
      { pagePath: '/pages/cart/index', text: '购物车' },
      { pagePath: '/pages/order/index', text: '订单' },
      { pagePath: '/pages/user/index', text: '我的' },
    ],
  },

  methods: {
    /** @param {WechatMiniprogram.TouchEvent} e `data-path` / `data-index` 来自 wxml */
    onSwitch(e) {
      const ds = e?.currentTarget?.dataset ?? {};
      const path = typeof ds.path === 'string' ? ds.path : '';
      const index = Number(ds.index);
      if (path === '') return;
      if (index === this.data.active) return; // @see @limitation 三
      wxApi.switchTab({ url: path });
    },
  },
});
