/**
 * 职责：用户行为埋点（流 C，M-21 / AJ-409）——内存队列 + 按批冲刷到 `POST /api/v1/beacon`。
 * 边界：只管"排队、整形、成批交给 send"；**何时**冲刷（15 秒定时 / 切后台）与**怎么发**（wx.request）由 app.js 装配。
 *
 * @why 白名单在客户端**再过一遍**、多余键直接剥掉：服务端对多键是整批 40001，
 *      一个页面传多了一个字段就会把同批其他页面的事件一起拖下水；在入队处剥掉，坏的只是那一条。
 *      三张表与 shared（服务端用的同一份）由单测逐字绑定——小程序不引 npm 包，只能抄一份再绑回去。
 * @why **失败即丢，不重试、不落盘**：埋点有损是可接受的，而重试/落盘会让"网络差的用户"
 *      在恢复时一次冲出几百条、或在本地存储里越攒越多。队列封顶 50，超出的新事件丢弃并计数。
 * @why `send` 抛错**不向调用方抛**、交给 `onError`（记实时日志）：这是本项目"不吞异常"口径下的明确例外——
 *      埋点的任何失败都不能打断用户正在做的事（加购、付款）；异常没有被吞，它换到实时日志里继续响。
 * @why 匿名 id 存本地（`ws:anon_id`）：登录前的浏览与登录后的付款靠它连成一条漏斗；
 *      随机串、不含设备信息，清除存储即换新。存储写失败照样给出 id（只是下次冷启动换一个）。
 * @limitation 一：一批只在**一个**时刻有一次发送机会；切后台时 `flushAll` 发出的请求宿主可能来不及送完——丢就丢了。
 * @limitation 二：`ts` 是本机时钟（可能偏）；服务端以自己的 created_at 为准，ts 只排同批先后。
 * @see packages/shared/src/enums.ts（BEACON_*）；server/src/domain/beacon-input.ts（服务端同口径校验）；../app.js（装配）
 */
import { randomId } from './random-id.js';

export const BEACON_EVENTS = [
  'page_view',
  'add_to_cart',
  'checkout_enter',
  'pay_start',
  'pay_abandon',
];
export const BEACON_PAGES = [
  'home',
  'detail',
  'cart',
  'checkout',
  'pay',
  'order',
  'order_detail',
  'user',
];
export const BEACON_ABANDON_REASONS = ['back', 'cancel', 'fail'];
export const MAX_BATCH = 20;
export const MAX_QUEUE = 50;
export const FLUSH_INTERVAL_MS = 15_000;

const ANON_KEY = 'anon_id';
const ANON_RE = /^an-[0-9A-HJKMNP-TV-Z]{20}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const oneOf = (list) => (v) => typeof v === 'string' && list.includes(v);
/** 每种事件的 props 键与校验（与服务端精确键集一致）。 */
const PROPS = {
  page_view: { page: oneOf(BEACON_PAGES) },
  add_to_cart: { product_id: isId },
  checkout_enter: {},
  pay_start: {
    order_id: isId,
    channel: (v) => typeof v === 'string' && /^[a-z0-9_]{1,32}$/.test(v),
  },
  pay_abandon: { order_id: isId, reason: oneOf(BEACON_ABANDON_REASONS) },
};

/**
 * 整形一条事件；不在白名单或缺必填 → null（不入队）。
 * @returns {{name: string, ts: number, props?: Record<string, string>} | null}
 */
export function toEvent(name, props, ts) {
  const spec = Object.prototype.hasOwnProperty.call(PROPS, name) ? PROPS[name] : null;
  if (spec === null) return null;
  const keys = Object.keys(spec);
  if (keys.length === 0) return { name, ts };
  const src = props !== null && typeof props === 'object' ? props : {};
  const out = {};
  for (const k of keys) {
    if (!spec[k](src[k])) return null;
    out[k] = src[k];
  }
  return { name, ts, props: out };
}

/**
 * @param {{anonId: string, now: () => number,
 *          send: (payload: {anon_id: string, events: Array<{name: string, ts: number, props?: Record<string, string>}>}) => unknown,
 *          onError?: (e: unknown) => void, maxBatch?: number, maxQueue?: number}} deps
 */
export function createBeacon(deps) {
  const maxBatch = deps.maxBatch ?? MAX_BATCH;
  const maxQueue = deps.maxQueue ?? MAX_QUEUE;
  const queue = [];
  let dropped = 0;
  const api = {
    track(name, props) {
      const ev = toEvent(name, props, deps.now());
      if (ev === null) return false;
      if (queue.length >= maxQueue) {
        dropped += 1;
        return false;
      }
      queue.push(ev);
      if (queue.length >= maxBatch) api.flush();
      return true;
    },
    /** 发一批（≤ 20）；返回本批条数。 */
    flush() {
      if (queue.length === 0) return 0;
      const events = queue.splice(0, MAX_BATCH);
      try {
        deps.send({ anon_id: deps.anonId, events });
      } catch (e) {
        deps.onError?.(e);
      }
      return events.length;
    },
    /** 切后台时把队列分批发完。 */
    flushAll() {
      while (api.flush() > 0);
    },
    size: () => queue.length,
    dropped: () => dropped,
  };
  return api;
}

/** 取（或新建并保存）匿名 id。`storage` 是 utils/storage 的实例（测试注入假实现）。 */
export function ensureAnonId(storage, gen = () => randomId('an-', 20)) {
  const cur = storage.getString(ANON_KEY);
  if (ANON_RE.test(cur)) return cur;
  const id = gen();
  try {
    storage.setString(ANON_KEY, id);
  } catch {
    // 存不上只影响"下次冷启动换新 id"，不影响本次埋点（见文件头 @why）
  }
  return id;
}

/** beacon 请求头：trace 必带；有 token 才带 Bearer（服务端鉴权可选）。 */
export function beaconHeaders(token, traceId) {
  return {
    'content-type': 'application/json',
    'x-trace-id': traceId,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** 页面薄壳的统一入口：没装 beacon（地址未配置 / 测试宿主）时什么也不做。 */
export function track(app, name, props) {
  app?.globalData?.beacon?.track(name, props);
}
