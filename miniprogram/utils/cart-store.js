/**
 * 职责：购物车本地状态的**唯一入口**（I2；PRD §3.1：前端本地状态 + D-52 持久化）。
 *
 * @why 购物车是**本地**的：PRD 明确"前端本地状态"（不建购物车表）——
 *      服务端只认 `POST /orders/quote`（不落库、不扣库存）与建单。
 *      本地的代价是"换设备购物车消失"（已接受的 MVP 取舍），换来的是
 *      不登录也能加购、不做购物车同步这一整摊子事。
 *
 * @why 独立成模块而不是散在页面：加购动作发生在**详情页**，展示发生在**购物车页**，
 *      合计发生在**确认订单页**——三个页面读写同一份状态，
 *      各写一遍的结果是"详情页加的购物车在购物车页看不到"，且不报错。
 *      读写必须经过这里（就像 storage 必须经过 storage.js 一样）。
 *
 * @limitation 一：条目缓存了 `title / image / priceJpy`（加购那一刻的快照）。
 *              **价格会过期**——过期价格的防线**不在本地**：报价/建单时服务端
 *              按真实价算（建单的 `expected_total_jpy` 不等会 40905），
 *              本地快照只负责"离线也能看到购物车长什么样"。
 *              ⚠️ 因此页面**不许**拿缓存价算合计——合计永远走 quote。
 * @limitation 二：**库存**不在本地判（服务端建单会按库存拒）：客户端限了等于在两个地方各定一次规则，
 *              漂移时表现为"客户端说能买 99 件、服务端说库存只有 3"。
 *              但单行**件数**有封顶 `MAX_LINE_QTY`（AJ-448，与服务端契约 `qty.maximum` 同值）：
 *              超过它服务端一律 40001，本地不封顶的表现是"加到 100 件后结算报'参数错误'"——那不是库存问题。
 * @limitation 四：**品种数**有上限 `MAX_CART_LINES`（P2-31），与 @limitation 二的"件数不限"不矛盾：
 *              报价 / 建单端对 >50 个**不同**商品一律 40001（server/src/domain/quote.ts `MAX_QUOTE_ITEMS`），
 *              客户端不拦的表现是第 51 种照常加进来，到购物车页才撞 40001，提示还是"请稍后重试"——永远重试不好。
 *              ⚠️ 只拦**新增品种**；已存在的商品加数量照常（那受库存约束，归服务端）。
 *              ⚠️ 旧版本已攒下 >50 种的购物车**不截断**（截掉哪些都是替用户做决定），由购物车页说清"请移除一些"。
 * @limitation 五：**勾选结算**（A3，AJ-416）：每条带 `selected`，报价 / 建单的 items（`toOrderItems`）只取勾选的；
 *              角标（`count`）仍按全部件数——没勾的也还在车里。旧版本存下的条目没有这个字段，按**已勾选**读
 *              （升级后购物车不会突然一件都没选、"去结算"变灰却不知为何）。
 * @limitation 三：持久化走 `storage` 封装（`ws:` 前缀、JSON、损坏兜底），
 *              **不直接碰宿主 storage**（storage-guard 会扫）。
 *
 * @see ./storage.js（持久化真源）；../app.js（装配：globalData.cart）；
 *      PRD §3.1 购物车行；contracts/api-contract.yaml（/orders/quote 的 items 形状）
 */

/** 持久化键（`ws:` 前缀由 storage.js 加）。 */
const CART_KEY = 'cart';

/**
 * 购物车最多放多少种**不同**商品（P2-31）。
 * @why 与服务端 `MAX_QUOTE_ITEMS`（server/src/domain/quote.ts）同值：小程序 js 引不了服务端 / shared 的 ts，
 *      所以这里是第二份真值，由 `cart-store.unit.test.ts` 直接 import 服务端常量比对，漂移即红。
 */
export const MAX_CART_LINES = 50;
/** 单行件数上限（AJ-448）：与 `packages/shared/src/limits.ts` 的 `MAX_LINE_QTY` 同值（小程序进不了 shared，由单测钉住相等）。 */
export const MAX_LINE_QTY = 99;

/**
 * 购物车条目。
 * @typedef {object} CartItem
 * @property {string} productId 商品 id（服务端 slug）
 * @property {number} [qty] 数量（>= 1；缺省 1）
 * @property {string} [title] 加购时的标题快照（见文件头局限一）
 * @property {string} [image] 加购时的主图快照（可为占位图路径）
 * @property {number} [priceJpy] 加购时的日元价快照（**不许用它算合计**，见文件头局限一）
 * @property {boolean} [selected] 是否勾选去结算（A3，AJ-416；缺省 = 勾选）
 */
// ⚠️ 上面这个 typedef 的属性说明里不要写"at 符号 + 标签名"：TypeScript 读 JSDoc 时把行内的 see 标签当成新标签，
//    typedef 在那里截断、其后的属性全部丢失。实测（2026-10-09，tsc）：title 的说明带 see 标签时报
//    "Property 'priceJpy' does not exist on type '{ selected: boolean; productId: string; qty?: number; title?: string; }'"。

/**
 * 造一个购物车。
 * @param {object} deps
 * @param {import('./storage.js').Storage} deps.storage 持久化出口（测试注入内存版）
 * @param {Array} [deps.initial] 初始条目（**测试专用**；生产从 storage 读）
 */
export function createCartStore(deps) {
  const storage = deps.storage;
  /** @type {CartItem[]} */
  let items = deps.initial ?? normalize(storage.getJson(CART_KEY));

  /** 落盘。⚠️ 不吞 storage 异常：存不下要让人知道（storage.js @limitation 一 同口径）。 */
  function persist() {
    storage.setJson(CART_KEY, items);
  }

  return {
    /** 读全部条目（**返回副本**：调用方改返回数组不该悄悄改到购物车）。 */
    items() {
      // 缺勾选字段 = 已勾选（@see @limitation 五）；统一在出口补齐，调用方只认布尔
      return items.map((i) => ({ ...i, selected: i.selected !== false }));
    },

    /** 件数合计（角标用）。 */
    count() {
      return items.reduce((sum, i) => sum + i.qty, 0);
    },

    /**
     * 加入购物车；已有同商品则**合并数量**（不加第二行）。
     * @param {CartItem} item 快照信息由调用方（详情页 vm）备好——这里不取数
     * @returns {{added: true} | {added: false, reason: 'full'}}
     *          `full` = 已有 `MAX_CART_LINES` 种商品、这是第 N+1 种（@see @limitation 四）；
     *          调用方据此给用户说清楚，**不抛**：这是用户能理解并自己处理的状态，不是编程错误。
     * @why 数量不进位阶校验（负数/0 直接拒）：加购入口只允许 >= 1，
     *      放进来 0 或负数的表现是"加了但购物车是空的"，离根因隔一层。
     */
    add(item) {
      if (!item || typeof item.productId !== 'string' || item.productId === '') {
        throw new Error('cart.add：productId 必须是非空字符串');
      }
      const qty = item.qty === undefined ? 1 : item.qty;
      if (!Number.isInteger(qty) || qty < 1) {
        throw new Error(`cart.add：qty 必须是 >= 1 的整数，收到 ${String(item.qty)}`);
      }
      const found = items.find((i) => i.productId === item.productId);
      if (found !== undefined) {
        found.qty = Math.min(found.qty + qty, MAX_LINE_QTY);
        found.selected = true; // 再次加购 = 用户刚表示要它（A3）
      } else {
        if (items.length >= MAX_CART_LINES) return { added: false, reason: 'full' };
        items.push({
          productId: item.productId,
          qty: Math.min(qty, MAX_LINE_QTY),
          title: typeof item.title === 'string' ? item.title : '',
          image: typeof item.image === 'string' ? item.image : '',
          priceJpy: item.priceJpy,
          selected: true,
        });
      }
      persist();
      return { added: true };
    },

    /**
     * 改数量；`qty <= 0` 等价于移除。
     * @why 0 和删除是**同一个动作**：购物车页"-到 0"的语义就是移掉，
     *      留一条 qty=0 的僵尸行只会出现在每一个"遍历购物车"的地方。
     */
    setQty(productId, qty) {
      if (!Number.isInteger(qty))
        throw new Error(`cart.setQty：qty 必须是整数，收到 ${String(qty)}`);
      if (qty <= 0) {
        items = items.filter((i) => i.productId !== productId);
      } else {
        const found = items.find((i) => i.productId === productId);
        if (found === undefined) return; // 改一个不存在的条目 = 空操作，不是错误
        found.qty = Math.min(qty, MAX_LINE_QTY);
      }
      persist();
    },

    /** 移除一个商品（不存在 = 空操作）。 */
    remove(productId) {
      items = items.filter((i) => i.productId !== productId);
      persist();
    },

    /**
     * 撤销删除：把刚删掉的条目**放回原位置**（M-14，AJ-406）。
     * @param {CartItem} item 删除前的那一行（含快照）
     * @param {number} index 删除前的下标（越界按末尾）
     * @returns {boolean} 是否放回了
     * @why 用 `add` 会把它放到末尾——用户眼里"撤销"就是那一行回到原处，换了位置会被读成"加了一件新的"。
     * @why 同商品已经在车里（撤销窗口内又从别处加了）→ 合并数量，不出第二行（与 `add` 同口径）。
     * @limitation 品种已满（`MAX_CART_LINES`）时放不回，返回 false——正常路径到不了（删一件才有撤销）。
     */
    restore(item, index) {
      if (!item || typeof item.productId !== 'string' || item.productId === '') return false;
      if (!Number.isInteger(item.qty) || item.qty < 1) return false;
      const found = items.find((i) => i.productId === item.productId);
      if (found !== undefined) {
        found.qty = Math.min(found.qty + item.qty, MAX_LINE_QTY);
      } else {
        if (items.length >= MAX_CART_LINES) return false;
        const at =
          Number.isInteger(index) && index >= 0 ? Math.min(index, items.length) : items.length;
        items.splice(at, 0, {
          productId: item.productId,
          qty: Math.min(item.qty, MAX_LINE_QTY),
          title: typeof item.title === 'string' ? item.title : '',
          image: typeof item.image === 'string' ? item.image : '',
          priceJpy: item.priceJpy,
          selected: item.selected !== false,
        });
      }
      persist();
      return true;
    },

    /** 清空。 */
    clear() {
      items = [];
      persist();
    },

    /**
     * 移除一批商品（A3：建单成功后只移除买走的那几件，没勾的留在车里）。
     * @param {string[]} productIds
     */
    removeMany(productIds) {
      const gone = new Set(Array.isArray(productIds) ? productIds : []);
      items = items.filter((i) => !gone.has(i.productId));
      persist();
    },

    /** 勾选 / 取消勾选一件（不存在 = 空操作）。A3 */
    setSelected(productId, selected) {
      const found = items.find((i) => i.productId === productId);
      if (found === undefined) return;
      found.selected = selected === true;
      persist();
    },

    /** 全选 / 全不选。A3 */
    setAllSelected(selected) {
      for (const i of items) i.selected = selected === true;
      persist();
    },

    /** 勾选了几**种**商品（底栏"去结算 (N)"用）。A3 */
    selectedCount() {
      return items.filter((i) => i.selected !== false).length;
    },

    /**
     * 用报价返回的**当前单价**刷新快照价（契约 0.6.39 `Quote.lines`；三端联动模拟 2026-10-08）。
     * @why 快照价是加购那一刻的：店家改价后购物车同一屏"行价 1,400 円 / 商品合计 1,600 円"对不上，
     *      买家会以为算错了钱。报价是钱的唯一来源，行价跟着它走。
     * @returns {boolean} 有任何一行变了（调用方据此重画行）
     * @limitation 只改已有条目的价格；`lines` 缺失 / 形状不对 = 什么都不做（旧服务端兼容）。
     */
    syncPrices(lines) {
      if (!Array.isArray(lines)) return false;
      let changed = false;
      for (const l of lines) {
        const id = l?.product_id;
        const price = l?.unit_price_jpy;
        if (typeof id !== 'string' || !Number.isInteger(price) || price <= 0) continue;
        const found = items.find((i) => i.productId === id);
        if (found !== undefined && found.priceJpy !== price) {
          found.priceJpy = price;
          changed = true;
        }
      }
      if (changed) persist();
      return changed;
    },

    /** 组装 quote / 建单的 items 形状（契约 OrderItemsInput）——**只取勾选的**（A3，@see @limitation 五）。 */
    toOrderItems() {
      return items
        .filter((i) => i.selected !== false)
        .map((i) => ({ product_id: i.productId, qty: i.qty }));
    },
  };
}

/**
 * 从 storage 读出来的东西 → 合法条目数组。
 * @why 持久化数据是**最脏**的输入源（手改、版本升级、损坏兜底），
 *      每条都过一遍形状校验，坏条目**丢弃**而不是让整个购物车打不开——
 *      一条坏数据让整个购物车白屏，等于把局部损坏放大成全部丢失。
 */
function normalize(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = raw
    .filter((i) => i && typeof i === 'object')
    .filter((i) => typeof i.productId === 'string' && i.productId !== '')
    .filter((i) => Number.isInteger(i.qty) && i.qty >= 1)
    .map((i) => ({
      productId: i.productId,
      qty: i.qty,
      title: typeof i.title === 'string' ? i.title : '',
      image: typeof i.image === 'string' ? i.image : '',
      priceJpy: i.priceJpy,
      selected: i.selected !== false,
    }));
  // 同一商品出现两行（旧版本写入 / 损坏）→ 合并、数量相加（审查 2026-10-09）：
  //   不合并的话 toOrderItems 带重复 product_id，报价永远 40001，购物车卡在"合计未能获取"，重试也没用
  const merged = [];
  for (const r of rows) {
    const found = merged.find((m) => m.productId === r.productId);
    if (found === undefined) merged.push(r);
    else found.qty += r.qty;
  }
  return merged;
}
