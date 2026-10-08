/**
 * 职责：`POST /beacon` 请求体的准入判定（M-21 / AJ-409，流 C 用户行为）——纯函数，无 IO。
 *
 * @why **白名单 + 精确键集**，多一个键也整批 40001：这条入口是匿名可达的，
 *      它写进的 `user_events` 是长期保留的查询面。只要放过"未知键 / 自由文本"，
 *      客户端一个 bug（或恶意调用）就能把地址、电话、邮箱、openid 写进我们的库——
 *      约束七的脱敏红线在这里的唯一可靠形态是"根本不收自由文本"。
 * @why 错误 details **只带 reason 与下标**，不回显值、也不回显键名：40001 的 details 会进运行日志，
 *      而键名同样是客户端可控的（`{"jane@example.com": 1}`）。
 * @why id 只认 `[A-Za-z0-9_-]{1,64}`：邮箱（`@` `.`）、E.164 电话（`+`）、带空格的地址都过不了形状。
 *      ⚠️ 形状挡不住"纯字母数字的 PII"（如去掉 `+` 的电话号码、openid 本身就是 base64url）——
 *      第二层在路由：id 必须**真实存在**于 products / orders，否则该条丢弃（beacon-routes.ts @why）。
 * @why `ts`（客户端时间）只校验形状（整数、2020-01-01 ~ 2100-01-01），**不按服务端时钟卡窗口**：
 *      真机时钟偏几天很常见，按窗口拒会让这些用户的埋点永远 40001；分析一律用服务端 `created_at`，
 *      `client_ts` 只用来排同一批内的先后。
 * @limitation 批量上限 20：小程序端每 15 秒或攒满 20 条冲一次，正常不会超；超了整批拒（不截断——
 *      截断等于静默丢后半段，前端的 bug 永远发现不了）。
 * @see packages/shared/src/enums.ts（BEACON_*）；contracts/api-contract.yaml `/beacon`；docs/自主决策记录.md AJ-409
 */
import {
  BEACON_ABANDON_REASON,
  BEACON_EVENT,
  BEACON_PAGE,
  PAYMENT_CHANNEL,
  type BeaconEvent,
} from '@waselect/shared';
import { AppError } from '../errors.js';

export const BEACON_MAX_EVENTS = 20;
/** 小程序 `randomId('an-', 20)` 的形状（Crockford Base32，utils/random-id.js）。 */
const ANON_ID = /^an-[0-9A-HJKMNP-TV-Z]{20}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TS_MIN = Date.UTC(2020, 0, 1);
const TS_MAX = Date.UTC(2100, 0, 1);

type PropCheck = (v: unknown) => boolean;
const oneOf =
  (list: readonly string[]): PropCheck =>
  (v) =>
    typeof v === 'string' && list.includes(v);
const isId: PropCheck = (v) => typeof v === 'string' && ID.test(v);

/** 每种事件的 props **精确键集**（缺一个、多一个都拒）。 */
const PROPS: Readonly<Record<BeaconEvent, Readonly<Record<string, PropCheck>>>> = {
  page_view: { page: oneOf(BEACON_PAGE) },
  add_to_cart: { product_id: isId },
  checkout_enter: {},
  pay_start: { order_id: isId, channel: oneOf(PAYMENT_CHANNEL) },
  pay_abandon: { order_id: isId, reason: oneOf(BEACON_ABANDON_REASON) },
};

export interface BeaconEventInput {
  name: BeaconEvent;
  /** 要落库的 props：白名单键 + `client_ts`。 */
  props: Record<string, string | number>;
}
export interface BeaconBatch {
  anonId: string;
  events: BeaconEventInput[];
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(o).every((k) => allowed.includes(k));
const fail = (reason: string, index?: number): AppError =>
  new AppError(40001, index === undefined ? { reason } : { reason, index });

function parseEvent(raw: unknown, index: number): BeaconEventInput {
  if (!isPlain(raw) || !onlyKeys(raw, ['name', 'ts', 'props'])) throw fail('event_shape', index);
  if (!oneOf(BEACON_EVENT)(raw.name)) throw fail('event_name_invalid', index);
  const name = raw.name as BeaconEvent;
  const ts = raw.ts;
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < TS_MIN || ts > TS_MAX) {
    throw fail('event_ts_invalid', index);
  }
  const spec = PROPS[name];
  const props = raw.props ?? {};
  const keys = Object.keys(spec);
  if (!isPlain(props) || Object.keys(props).length !== keys.length || !onlyKeys(props, keys)) {
    throw fail('event_props_invalid', index);
  }
  const out: Record<string, string | number> = {};
  for (const k of keys) {
    if (!(spec[k] as PropCheck)(props[k])) throw fail('event_props_invalid', index);
    out[k] = props[k] as string;
  }
  out.client_ts = ts;
  return { name, props: out };
}

/** 校验整批；任何一处不合格整批 40001（见文件头）。 */
export function parseBeaconBatch(body: unknown): BeaconBatch {
  if (!isPlain(body) || !onlyKeys(body, ['anon_id', 'events'])) throw fail('beacon_shape');
  if (typeof body.anon_id !== 'string' || !ANON_ID.test(body.anon_id)) {
    throw fail('anon_id_invalid');
  }
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) throw fail('events_shape');
  if (events.length > BEACON_MAX_EVENTS) throw fail('events_too_many');
  return { anonId: body.anon_id, events: events.map((e: unknown, i) => parseEvent(e, i)) };
}
