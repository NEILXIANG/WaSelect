/**
 * 职责：管理端 token 的本地存放（F15 单元②）——localStorage 为真值，隐私模式降级内存。
 * 边界：只管"存/取/清"三件事；token 的签发与校验在服务端，刷新语义在 client.ts（40101 → 登出）。
 *
 * @why localStorage 而不是 sessionStorage / cookie：
 *      ① cookie 会被同域所有请求自动携带——管理端 API 在**另一个域**（D21 独立 Web + CORS），
 *         cookie 方案要服务端改 Set-Cookie + CORS credentials，复杂度换一个不需要的特性；
 *      ② sessionStorage 关页签即失效——管理员每天开工重新登录一次是摩擦不是安全
 *         （token 本身 12 小时过期，技术文档 §5 已划定风险窗口）；
 *      ③ XSS 持久化风险：管理后台不渲染任何用户生成内容（商品图文是运营自己录入的），
 *         攻击面远小于 C 端。⚠️ D-52 规划的 Cloudflare Access **尚未部署**——它是上线前的部署前提
 *         （docs/地基搭建清单.md ⑦-0），不是现状；在它落地之前，这一层没有额外的网关挡在前面。
 *
 * @limitation 一：隐私模式 / 存储被禁用时 `localStorage` 的读写会**抛异常**（Safari 老版本、
 *              企业策略禁用）。不兜的表现是"登录页一打开就白屏"——崩溃点在 storage 而不是登录逻辑，
 *              排查方向全错。所以任何一步抛错都降级为**内存存储**：刷新页面后需重新登录，
 *              功能可用，代价可接受。
 * @limitation 二：token 是**明文**存 localStorage 的——XSS 一旦发生即可被读走。
 *              这是上面 @why ③ 的已知代价；缓解靠"不渲染 UGC + 12h 过期 + 改密/封禁即时失效（D25）"，
 *              不靠前端存储层加密（密钥也在前端，等于没加）。
 *
 * @see client.ts（getToken 的唯一消费方）；docs/地基搭建清单.md F15
 */

/** 存储键：带项目前缀，与同域其它工具（本地起多个项目时）隔离。 */
export const TOKEN_STORAGE_KEY = 'waselect.admin.token';

/** 最小存储形状（lib.dom 的 Storage 满足它；测试可用 Map 式假实现注入）。 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TokenStore {
  /** 取当前 token；无 token 返回空串（与 client.ts getToken 的口径一致）。 */
  get(): string;
  set(token: string): void;
  clear(): void;
}

/**
 * 创建 token 存储。
 * @param storage 默认全局 localStorage；**任何读写抛错都降级内存**（@limitation 一）。
 *                注入假实现可测降级路径。
 */
export function createTokenStore(storage?: KeyValueStorage): TokenStore {
  const fallback = new Map<string, string>();
  // 内存降级存储：恒为 Map 实现，**绝不绑定到注入的 storage**——
  // 否则注入一个"会抛错的 storage"时，降级目标自己也在抛，等于没有降级（单元测试当场抓到过）。
  const inner: KeyValueStorage = {
    getItem: (k) => fallback.get(k) ?? null,
    setItem: (k, v) => void fallback.set(k, v),
    removeItem: (k) => void fallback.delete(k),
  };
  const real: KeyValueStorage | undefined = storage ?? safeLocalStorage();

  return {
    get: () => {
      try {
        return (real ?? inner).getItem(TOKEN_STORAGE_KEY) ?? '';
      } catch {
        return inner.getItem(TOKEN_STORAGE_KEY) ?? '';
      }
    },
    set: (token) => {
      try {
        (real ?? inner).setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        inner.setItem(TOKEN_STORAGE_KEY, token);
      }
    },
    clear: () => {
      try {
        (real ?? inner).removeItem(TOKEN_STORAGE_KEY);
      } catch {
        inner.removeItem(TOKEN_STORAGE_KEY);
      }
    },
  };
}

/**
 * 取全局 localStorage；不可用（抛错或不存在）返回 undefined → 全程走内存。
 * @why 某些环境**访问** `localStorage` 这个属性本身就抛（不是调方法才抛），所以取值也要 try。
 */
function safeLocalStorage(): KeyValueStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
