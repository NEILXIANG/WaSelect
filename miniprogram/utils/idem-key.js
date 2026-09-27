/**
 * 职责：建单 / 发起支付的**幂等键**生成（`Idempotency-Key` 请求头，契约上限 128 字符）。
 *
 * @why 独立成共享模块：确认订单页（建单）与支付页（发起支付）都要用，
 *      从其中一个页面 `import` 过去会成为"页面依赖页面"——
 *      与 `quote-view.js` 下沉同一条理由。
 *
 * @why 幂等键必须**一次提交一个、重试复用同一个**：每次重试都换键，
 *      服务端幂等就形同虚设——网络一抖建出两张单，而用户只点了一次。
 *      所以本模块只负责"造一个不可能撞的串"，**持有与复用是调用方的责任**
 *      （两处都写在页面的 `this.idemKey` 上）。
 *
 * @limitation 一：不用 `Date.now()`——约束十禁业务侧取时间（时间走注入时钟），
 *              且时间戳在高并发下不够随机；两段 base36 随机串拼接对本量级足够。
 * @limitation 二：`rand` 默认 `Math.random` 但**可注入**：测试要能钉住格式，
 *              不能靠真随机（靠真随机的断言等于没有断言）。
 *
 * @see ../../contracts/api-contract.yaml（parameters/IdemKey）
 */
/**
 * @param {() => number} [rand] 随机源（0..1）
 * @returns {string} `idem-<base36><base36>`
 */
export function newIdemKey(rand = Math.random) {
  const a = rand().toString(36).slice(2);
  const b = rand().toString(36).slice(2);
  return `idem-${a}${b}`;
}
