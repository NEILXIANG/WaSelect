/**
 * 职责：金额的**展示**格式化（JPY 整数円 + USD/CNY 整数分）。
 *
 * @why 项目口径是「JPY 为唯一定价锚＝结算币＝记账币」，所以展示层**不做任何汇率运算**——
 *      USD/CNY 展示价由后端按当日汇率算成**整数分**（契约 Display schema），
 *      前端只负责把整数分拼成文案（I1-U7b）。前端做乘法=两个系统各算一遍，迟早对不上。
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

/**
 * 把 USD 展示价（整数分，契约 Display schema）格式化成展示文案。
 *
 * @param {number} cents 美分（整数；非整数/非有限数按 @limitation 一抛错）
 * @returns {string} 形如 `$1,234.56` / `-$1,234.56`
 * @throws {Error} 非整数 / 非有限数 / 非数字
 *
 * @why 小数**恒两位**（`$24.50` 不是 `$24.5`）：少一位小数在价格语境里会被读成另一个金额，
 *      而"有时候一位有时候两位"正是"不同页面长得不一样"的又一种形态。
 * @why 符号用 `$`：D-36 三币并列、符号不共用——円 给 JPY，`¥` 给人民币，`$` 给美元。
 */
export function formatUsdCents(cents) {
  return formatMinor(cents, '$', 'formatUsdCents');
}

/**
 * 把 CNY 展示价（整数分，契约 Display schema）格式化成展示文案。
 *
 * @param {number} fen 分（整数；非整数/非有限数按 @limitation 一抛错）
 * @returns {string} 形如 `¥1,234.56` / `-¥1,234.56`
 * @throws {Error} 非整数 / 非有限数 / 非数字
 *
 * @why `¥` 是 D-36 分配给**人民币**的符号（目标用户是美国华人，`¥` 在他们眼里就是人民币）；
 *      两位小数与 USD 同口径——D-36 示例里的 `¥176` 写于"整数分"契约之前，以契约为准。
 */
export function formatCnyFen(fen) {
  return formatMinor(fen, '¥', 'formatCnyFen');
}

/**
 * 整数分 → `符号 + 千分位整数部分 + 两位小数`（USD/CNY 共用的唯一实现，见文件头 @why）。
 * @param {number} minor 整数分
 * @param {string} symbol 货币符号（D-36 分配的专属符号）
 * @param {string} name 调用方函数名（错误文案要指回真正的入口，否则用户看到的是内部名）
 */
function formatMinor(minor, symbol, name) {
  if (typeof minor !== 'number' || !Number.isInteger(minor)) {
    throw new Error(`${name}：金额必须是整数分，收到 ${String(minor)}`);
  }
  const magnitude = Math.abs(minor);
  // ⚠️ 与 formatJpy 同口径：0（含 -0）不带负号——0 没有方向
  const sign = minor < 0 && magnitude !== 0 ? '-' : '';
  const units = Math.floor(magnitude / 100);
  const fraction = String(magnitude % 100).padStart(2, '0');
  return `${sign}${symbol}${group(units)}.${fraction}`;
}
