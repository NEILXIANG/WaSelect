/**
 * 职责：小程序本地存储的**唯一入口**（F14）——在 `wx-api` 之上补三件宿主没给的事。
 *
 * @why 宿主只给了 `getStorageSync` / `setStorageSync` 两个**字符串**接口，
 *      直接用会有三个真实的坑：
 *      ① **key 会撞**：storage 是同一 appid 内共享的，我们的 `token` 与将来任何
 *         第三方 SDK 的 `token` 是同一个键——互相覆盖时没有任何报错，只是数据突然不对；
 *      ② **JSON 要自己编解码**：每个存草稿/缓存的地方各写一遍 `JSON.parse`，
 *         而 `JSON.parse` 对损坏数据**抛异常**，会让 App 在启动阶段就崩；
 *      ③ **"损坏了怎么办"没有统一答案**：有的地方抛、有的地方给默认值，
 *         两种都合理但混在一起就没有答案了。
 *      这里给一个统一答案，而且它是**可测的**（注入 `wxApi`）。
 *
 * @limitation 一：**只存字符串与 JSON**，不做二进制 / 大数据。
 *              小程序单个 key 上限 1MB、单小程序上限 10MB，超了宿主会抛——
 *              这里**不吞**那个异常（存不下必须被知道，否则表现为"草稿莫名其妙没了"）。
 * @limitation 二：`getJson` 读到**损坏的 JSON 时返回 undefined**，不抛也不自动删。
 *              理由：损坏数据不该让 App 起不来（那是启动崩溃级别的故障）；
 *              而不自动删是因为"删掉用户的数据"这件事必须由调用方决定。
 *              ⚠️ 代价：损坏数据每次读取都会再解析失败一次，直到被覆盖；
 *              若哪天要告警，就在这里加一条日志出口（当前没有注入 logger，不为它预留接口）。
 * @limitation 三：key 前缀**默认固定**为 `ws:`，不提供关闭选项。
 *              能关的前缀等于没有前缀——那正是本模块存在的原因。
 * @limitation 四：**同步 API**（与宿主一致）。不做异步封装：
 *              异步版只会让调用方多写一层 await，而 storage 的量级（token / 草稿）
 *              不值得为它引入并发读写问题。
 *
 * @see ./wx-api.js（宿主能力入口）；docs/地基搭建清单.md F14
 */
import { createWxApi, type WxApi } from './wx-api.js';

/**
 * 我们的键前缀。
 * @why 硬编码而不做成参数：见 @limitation 三。
 */
export const KEY_PREFIX = 'ws:';

export interface StorageDeps {
  /** 宿主能力入口（测试注入；生产不传）。 */
  wx?: WxApi;
}

export interface Storage {
  /** 读字符串。不存在 → `fallback`（默认空串）。 */
  getString(key: string, fallback?: string): string;
  setString(key: string, value: string): void;
  /** 读 JSON。不存在 / 解析失败 → `undefined`（@see @limitation 二）。 */
  getJson<T>(key: string): T | undefined;
  setJson(key: string, value: unknown): void;
  remove(key: string): void;
}

export function createStorage(deps: StorageDeps = {}): Storage {
  const wxApi = deps.wx ?? createWxApi();
  const full = (key: string): string => `${KEY_PREFIX}${key}`;

  return {
    getString(key, fallback = '') {
      const value = wxApi.getStorageSync(full(key));
      // ⚠️ 空串按"没存过"处理：storage 里存一个空串没有意义。
      //    写成显式判断而不是 `value || fallback`，是为了让人一眼看出这是**刻意的**，
      //    而不是顺手的短路（顺手的短路会把合法空串也吞掉，且没人会发现）。
      return value.length === 0 ? fallback : value;
    },

    setString(key, value) {
      wxApi.setStorageSync(full(key), value);
    },

    getJson<T>(key: string): T | undefined {
      const raw = wxApi.getStorageSync(full(key));
      if (raw.length === 0) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        // 损坏的数据：按 @limitation 二，返回 undefined（不抛、不删）
        return undefined;
      }
    },

    setJson(key, value) {
      // ⚠️ 不吞 `JSON.stringify` 的异常（循环引用会抛）：
      //    "存不进去"必须被知道，静默放过会表现为"草稿莫名其妙没了"。
      wxApi.setStorageSync(full(key), JSON.stringify(value));
    },

    remove(key) {
      // ⚠️ 用宿主真正的删除，而不是写回空串：写回空串只是"看起来没了"，
      //    那条 key 仍然占着配额，而且 `getJson` 会走"空串 = 不存在"这条分支——
      //    两个"不存在"的成因被混成一种，排障时又要多猜一层。
      wxApi.removeStorageSync(full(key));
    },
  };
}
