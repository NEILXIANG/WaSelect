/**
 * 职责：本地存储封装的单测（F14）。
 *
 * @why 这一层薄，但钉的是**三个"不报错但结果不对"**的点：
 *      ① **key 前缀**：不前缀会与同 appid 内的其它键互撞，表现为"数据突然不对"且毫无线索；
 *      ② **损坏的 JSON 不能让 App 崩**：`JSON.parse` 抛异常发生在**启动阶段**时是启动崩溃；
 *      ③ **remove 必须是真删**：写回空串只是"看起来没了"，且会把"没存过"与"存了空串"
 *         两种成因混成一种——排障时要多猜一层。
 *
 * @how 注入一个**内存版 WxApi**（不是 mock 函数）：storage 走的是宿主那两个字符串接口，
 *      用内存 Map 实现它们，等于用"一个不同的宿主"来测——比 mock 单个函数更接近真实。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWxApi } from './wx-api.js';
import { createStorage, KEY_PREFIX } from './storage.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 一个内存版的 storage（按宿主口径：只存字符串，读不到返回空串）。
 *
 * @why **额外暴露 `store` 这个 Map**：只读回字符串是分不清"真删了"和"写回了空串"的
 *      ——两种都读回 `''`。要看的是**键还在不在**（见 `删除` 那一组）。
 *      只断言"读不到"的测试是个假测试：写回空串的实现也能让它绿。
 */
function memWxApi(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const wx = createWxApi({
    getStorageSync: (key) => {
      const v = store.get(key);
      return typeof v === 'string' ? v : '';
    },
    setStorageSync: (key, value) => {
      store.set(key, value);
    },
    removeStorageSync: (key) => {
      store.delete(key);
    },
  });
  return { wx, store };
}

function harness(initial: Record<string, unknown> = {}) {
  const { wx, store } = memWxApi(initial);
  return { storage: createStorage({ wx }), store };
}

describe('key 前缀（防止与同 appid 内的其它键互撞）', () => {
  it('读写的都是带前缀的键（裸 `token` 不会被看到）', () => {
    const { storage } = harness({ token: '裸键的值' });
    // 不前缀的话这里会读到 '裸键的值'——那正是互撞的形态
    expect(storage.getString('token')).toBe('');
  });

  it('写进去的键确实带前缀（前缀是硬编码的，不是可选项）', () => {
    const { wx, store } = memWxApi();
    createStorage({ wx }).setString('token', 'tk-1');
    expect(wx.getStorageSync(`${KEY_PREFIX}token`)).toBe('tk-1');
    expect(wx.getStorageSync('token')).toBe('');
    // 顺带钉住"只写了一个键"：前缀若漏了，这里会多出一条裸键
    expect([...store.keys()]).toEqual([`${KEY_PREFIX}token`]);
  });
});

describe('字符串读写', () => {
  it('写了就能读回来（往返）', () => {
    const { storage } = harness();
    storage.setString('token', 'tk-1');
    expect(storage.getString('token')).toBe('tk-1');
  });

  it('不存在 → 用传入的 fallback（不是空串）', () => {
    const { storage } = harness();
    expect(storage.getString('nope')).toBe('');
    expect(storage.getString('nope', 'default')).toBe('default');
  });
});

describe('JSON 读写', () => {
  it('对象往返（含嵌套与数组）', () => {
    const { storage } = harness();
    storage.setJson('draft', { items: [{ sku: 'a', qty: 2 }], note: '' });
    expect(storage.getJson<{ items: unknown[] }>('draft')).toEqual({
      items: [{ sku: 'a', qty: 2 }],
      note: '',
    });
  });

  it('不存在 → undefined（不是抛、也不是 null）', () => {
    const { storage } = harness();
    expect(storage.getJson('nope')).toBeUndefined();
  });

  it('⚠️ 数据**损坏**时返回 undefined，不抛（否则 App 启动阶段会崩）', () => {
    // @why 这是 @limitation 二 的落地：损坏数据（旧版本写的格式 / 被别的 key 覆盖了一半）
    //      不该让 App 起不来。抛异常的代价是**启动崩溃**，而返回 undefined 的代价只是
    //      "这一次用默认值"——两个代价不在一个量级。
    const { storage } = harness({ [`${KEY_PREFIX}draft`]: '{不是合法 JSON' });
    expect(() => storage.getJson('draft')).not.toThrow();
    expect(storage.getJson('draft')).toBeUndefined();
  });

  it('损坏的数据**不会被自动删**（删用户数据是调用方的决定）', () => {
    const { wx } = memWxApi({ [`${KEY_PREFIX}draft`]: '{{{' });
    const storage = createStorage({ wx });
    expect(storage.getJson('draft')).toBeUndefined();
    // 原值还在——本模块没有替调用方做删除这个决定
    expect(wx.getStorageSync(`${KEY_PREFIX}draft`)).toBe('{{{');
  });
});

describe('删除', () => {
  it('remove 之后读不到', () => {
    const { wx } = memWxApi({ [`${KEY_PREFIX}token`]: 'tk-1' });
    const storage = createStorage({ wx });
    storage.remove('token');
    expect(storage.getString('token')).toBe('');
  });

  it('⚠️ remove 是**真删**，不是写回空串（键必须真的消失）', () => {
    // @why 只断言"读不到"是**假绿灯**：写回空串的实现也能让它通过
    //      （`getString` 本来就把空串当"没存过"）。
    //      必须看**键还在不在**：写回空串会让这条 key 继续占配额，
    //      而且"没存过"与"存了空串"两种成因被混成一种，排障时要多猜一层。
    const { storage, store } = harness({ [`${KEY_PREFIX}token`]: 'tk-1' });
    storage.remove('token');
    expect(store.has(`${KEY_PREFIX}token`)).toBe(false);
  });
});

describe('异常不吞（存不下 / 存不了必须被知道）', () => {
  it('宿主写失败 → 原样抛出（静默放过会表现为"数据莫名其妙没了"）', () => {
    const wx = createWxApi({
      setStorageSync: () => {
        throw new Error('storage 满了');
      },
    });
    const storage = createStorage({ wx });
    expect(() => storage.setString('token', 'tk-1')).toThrow(/storage 满了/);
  });

  it('`JSON.stringify` 失败（循环引用）→ 抛出，不静默存一半', () => {
    const { storage } = harness();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => storage.setJson('bad', cyclic)).toThrow();
  });
});

describe('生产路径：不注入时走真实宿主', () => {
  it('`createStorage()` 不传依赖 → 读写落在 `globalThis.wx` 上', () => {
    // @why 这条用例存在的理由是**覆盖率之外**的：上面十来条用例全部走注入，
    //      于是"不注入时连的是真实宿主"这条**生产上唯一在跑的路径**没人验过。
    //      它坏掉的形态很隐蔽——默认值写成空实现会让所有数据静默消失且不报错。
    const seen: string[] = [];
    const backing = new Map<string, unknown>();
    vi.stubGlobal('wx', {
      request: () => {},
      getStorageSync: (k: string) => {
        seen.push(`get:${k}`);
        const v = backing.get(k);
        return typeof v === 'string' ? v : '';
      },
      setStorageSync: (k: string, v: unknown) => {
        seen.push(`set:${k}`);
        backing.set(k, v);
      },
      removeStorageSync: (k: string) => {
        seen.push(`remove:${k}`);
        backing.delete(k);
      },
    });

    const storage = createStorage();
    storage.setString('token', 'tk-1');
    expect(storage.getString('token')).toBe('tk-1');
    storage.remove('token');
    // 三个动作都带前缀地落到了宿主上——若默认值是一个空实现，seen 会是空的
    expect(seen).toEqual([
      `set:${KEY_PREFIX}token`,
      `get:${KEY_PREFIX}token`,
      `remove:${KEY_PREFIX}token`,
    ]);
  });

  it('宿主缺失 → 响亮失败（不是静默拿到一个"什么都存不住"的空实现）', () => {
    // 与 wx-api 同口径：宿主不存在只可能是编程错误（跑在 Node 里），越早炸越好
    vi.stubGlobal('wx', undefined);
    const storage = createStorage();
    expect(() => storage.setString('token', 'tk-1')).toThrow(/wx 宿主不存在/);
  });
});
