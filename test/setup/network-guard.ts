/**
 * 职责：**测试环境的外网闸门**——任何未被显式放行的出站请求直接抛错。
 *
 * @why 这条闸门存在的理由不是"测试要快"，是**防止测试偷偷依赖真实世界**：
 *      一个没被拦住的外网请求会让用例在 CI 上随机红（网络抖动）、在有网的机器上绿，
 *      而它验证的东西往往只是"Stripe 今天活着"。更糟的一种是它**真的**发出去了：
 *      测试跑一次就产生一笔真实请求，谁也不会去看。
 *      《地基搭建清单》F12 的验收标准原文就是"测试环境任何未被拦截的外网请求直接报错"。
 *
 * @why 放行**本机**（localhost / 127.0.0.1 / ::1）：闸门只拦**第三方**，
 *      不拦我们自己的服务——端到端测试必须真起端口、真发请求，那是它存在的意义。
 *
 * @why 状态挂在 `globalThis` 的 Symbol 上而不是模块变量：
 *      setup 文件与测试文件可能拿到不同的模块实例（取决于 runner 的隔离方式），
 *      挂在全局才能两边看到同一份放行表。这个代价换来的是"放行"这个动作在任何地方都生效。
 *
 * @limitation 一：**只拦 `fetch`**。通过其它方式出网（net 模块直连、子进程 curl）不在本闸门范围内。
 *              当前项目只有 `adapters/http/fetch-client.ts` 一条出网路径，够用；
 *              将来出现第二条时要在**这里**补，不要在每个测试里各写一份。
 * @limitation 二：`vi.stubGlobal('fetch', …)` 会**整体替换**掉闸门——
 *              那些用例本来就在用假 fetch，不需要闸门；但这意味着闸门对"已经 stub 了的用例"无效，
 *              它的真实覆盖范围是"忘了 stub 的用例"（正是最需要被抓住的那一类）。
 */
const STATE_KEY = Symbol.for('waselect.network-guard');

interface GuardState {
  /** 放行的 URL 前缀（`allowOutbound` 写入）。 */
  allowed: string[];
  installed: boolean;
}

function state(): GuardState {
  const g = globalThis as unknown as Record<symbol, GuardState | undefined>;
  const existing = g[STATE_KEY];
  if (existing !== undefined) return existing;
  const created: GuardState = { allowed: [], installed: false };
  g[STATE_KEY] = created;
  return created;
}

/**
 * 放行某个前缀（通常是 host，如 `https://api.stripe.com`）。
 *
 * @param reason **必填**：写清为什么这条用例必须真出网。
 * @why 强制写理由：没有理由的放行过两周就没人敢删，而闸门的价值恰恰是"默认不放行"。
 */
export function allowOutbound(prefix: string, reason: string): void {
  if (reason.trim().length === 0) {
    throw new Error('allowOutbound 必须写明理由（否则放行会变成"随手加白名单"）');
  }
  const s = state();
  if (!s.allowed.includes(prefix)) s.allowed.push(prefix);
}

/** 闸门自己用：判断这个 URL 能不能放行。 */
export function isOutboundAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    // 本机 = 我们自己的服务（e2e 真起端口），不是第三方
    if (LOCAL_HOSTS.has(parsed.hostname)) return true;
  } catch {
    // 解析不了 URL：交给下面的前缀判断（相对路径之类不会走到这里）
  }
  return state().allowed.some((p) => url.startsWith(p));
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 装闸门（幂等）。**由 `test/setup/install-network-guard.ts` 调用**，本模块不带副作用。
 *
 * @why 刻意不在模块底部自安装：那样的话，任何 import 了本文件的测试都会"看起来闸门生效"，
 *      而**其它**测试文件其实没装——闸门的价值恰恰在于"每个文件都装"。
 *      分成两个文件之后，setupFiles 是否生效才是真的被测到（见 network-guard.unit.test.ts 第一条）。
 */
export function installNetworkGuard(): void {
  const s = state();
  if (s.installed) return;
  const original = globalThis.fetch;
  /**
   * ⚠️ 必须 **async**（返回 rejected promise），不能同步 throw。
   * @why `fetch` 的契约是"返回 Promise"。同步抛会破坏两类调用方：
   *      `Promise.all([fetch(a), fetch(b)])`（还没进数组就炸了）与
   *      `expect(fetch(x)).rejects`（拿到的不是 promise 而是异常）。
   *      对 `await fetch(...)` 两种写法效果一样，但上面那两类会莫名其妙地红。
   */
  // ⚠️ 不能用 `RequestInfo`：本项目不引 DOM lib，那个类型不存在。
  //    从 `fetch` 自己的签名里取，既准确又跟着运行时走。
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input.url);
    if (isOutboundAllowed(url)) return original(input, init);
    throw new Error(
      `测试环境禁止真实外网请求：${url}\n` +
        `若这条用例确实需要出网，先调用 allowOutbound('<前缀>', '<理由>')；\n` +
        `否则说明被测代码漏了注入（HttpClient 应走端口，测试里用替身）。`,
    );
  }) as typeof fetch;
  s.installed = true;
}
