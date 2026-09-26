/**
 * 职责：金额的**展示**格式化（当前只有 JPY）。
 *
 * @why 项目口径是「JPY 为唯一定价锚＝结算币＝记账币」，所以展示层**只认日元整数**——
 *      USD 是派生展示价，等真有汇率来源再加，不预先铺（本项目多次踩过"提前做是猜"）。
 *      格式化必须集中在一处：价格会同时出现在列表、详情、购物车、订单、退款若干个位置，
 *      各写一遍的结果是"同一个金额在不同页面长得不一样"——这类不一致**没有任何报错**，
 *      只会让人觉得"这个页面好像怪怪的"。
 *
 * @why **自己实现千分位而不用 `toLocaleString('ja-JP')`**：它依赖运行时的 ICU 数据，
 *      Node 的小 ICU 构建与真机基础库给出的结果可能不同（用不用分隔符、用哪个符号），
 *      那样单测就成了"在测运行环境的 locale"——绿了也不代表真机上对。
 *      确定性优先于省几行代码。
 *
 * @limitation 一：**非有限数一律抛错**，不给默认值、不显示占位符。
 *              理由：价格显示不出来（组件那一片渲染失败，控制台有明确报错）
 *              远好过显示错的——`¥0` 会被用户读成"免费"，`¥NaN` 会被读成"系统坏了"，
 *              两者都比空白贵得多。与 `wx-api` / `storage` 的"边界层不吞异常"同一口径。
 * @limitation 二：**非整数一律抛错**（三审 P3-4 / A5）。旧实现以"含税价 ×1.1 会算出小数"为由
 *              做四舍五入，但出口件免消费税、`price_jpy` 是整数锚（D-14），契约规定 JPY 全链路整数、
 *              前端不做任何乘法（D-36）。API 若真返回小数，那是服务端 bug，静默入整会把它藏起来。
 * @limitation 三：只做**展示**，不参与任何金额运算。金额在系统内一律以整数 JPY 流动。
 * @limitation 四：**必须是 `.js` 而不是 `.ts`**——这是被测试方式倒逼的：
 *              组件用 `miniprogram-simulate` 加载时，组件 js 由 Node 的 `require` 执行，
 *              解析不到 `.ts`（vite 的 `.js → .ts` 映射只存在于测试侧）。
 *              代价是本文件没有类型检查（根 tsconfig `checkJs: false`），靠 JSDoc + 单测兜。
 *
 * @see ../components/ws-price/index.js（唯一调用方）；docs/地基搭建清单.md F14
 */

/**
 * 把日元金额格式化成展示文案。
 *
 * @param {number} amountJpy 日元金额（整数円；非整数按 @limitation 二 抛错）
 * @returns {string} 形如 `1,234 円` / `-1,234 円`
 * @throws {Error} 非整数 / 非有限数 / 非数字——@see @limitation 一、二
 *
 * @why 单位写 **`円`**、不用 `¥`（D-36 三审 A1）：口径是"三币并列、符号不共用"——
 *      主行 `3,600 円`，副行 `≈ $24.50 · ≈ 人民币 ¥176`。`¥` 是分配给**人民币**的符号，
 *      目标用户是美国华人，`¥1,234` 会被读成人民币 1,234 元（与 1,234 円 ≈ 60 元差 20 倍），
 *      同一页再出现 `人民币 ¥176` 就是两个 `¥` 两种币——正是 D-36 立项时要防的混淆。
 */
export function formatJpy(amountJpy) {
  if (typeof amountJpy !== 'number' || !Number.isInteger(amountJpy)) {
    throw new Error(`formatJpy：金额必须是整数円，收到 ${String(amountJpy)}`);
  }
  const magnitude = Math.abs(amountJpy);
  // ⚠️ 金额为 0（含 -0）时不带负号：`-0 円` 是"看起来像出错了"的文案，而 0 没有方向
  const sign = amountJpy < 0 && magnitude !== 0 ? '-' : '';
  return `${sign}${group(magnitude)} 円`;
}

/**
 * 千分位。
 * @param {number} value 非负整数
 * @returns {string}
 */
function group(value) {
  // `\B` 匹配非单词边界，`(?=(\d{3})+(?!\d))` 断言后面是"3 的倍数个数字且到此为止"
  return String(value).replace(/\B(?=(?:\d{3})+(?!\d))/g, ',');
}
