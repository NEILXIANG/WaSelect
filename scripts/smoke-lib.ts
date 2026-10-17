/**
 * 职责：对一个**已部署**的环境（staging / 生产）做冒烟检查的纯逻辑——检查清单、结果判定、报告格式。
 * 入口 `scripts/smoke.ts` 只负责读参数、发请求、打印与退出码。
 *
 * @why 上线前自动化方案（2026-10-16）：本机的 gate 验的是"代码对不对"，验不了"部署对不对"——
 *      环境变量漏填、域名没登记、迁移没跑、每日作业停了、汇率过期，这些只有打到真环境才看得见。
 *      冒烟不求全，求**每天自动跑一次、坏了有人知道**：GitHub Actions 定时跑（.github/workflows/smoke.yml）。
 * @why 检查分两层：**公开层**不需要任何凭据（健康、就绪、条款、首页、商品），staging 一搭好就能跑；
 *      **管理层**需要管理员邮箱 / 口令 / TOTP 密钥（CI Secrets），验登录、每日对账的异常计数。
 *      买家层（登录 → 下单 → 付款）**刻意不在这里**：staging 禁用开发登录（config 规则），真实登录要 AppID；
 *      有 AppID 后由 `scripts/stripe-rehearsal.ts` 覆盖那条链。
 * @why 对账异常**只对"该为 0"的类目判红**：`stalled_heartbeats`（作业停跑）、`unfinished_callbacks`、
 *      `paid_without_succeeded_payment` 这类是系统故障；`late_paid_unrefunded`、`after_sales_waiting` 是运营待办，
 *      有数是正常的，冒烟不替运营判断。
 * @limitation 一：只看响应形状与状态码，不比对业务数值（商品价格对不对、汇率是多少）——那是对账与人工的事。
 * @limitation 二：管理员登录会消耗一次 TOTP 码（同一步内重放会被拒）：同一分钟内不要连跑两次管理层。
 * @see docs/真平台验收清单.md；.github/workflows/smoke.yml；server/src/app/daily-reconciliation.ts（异常类目）
 */

/** 一次 HTTP 调用的最小抽象（真实现是 fetch；单测用假的）。 */
export interface SmokeHttp {
  (
    method: 'GET' | 'POST',
    path: string,
    opts?: { body?: unknown; token?: string },
  ): Promise<{ status: number; json: unknown }>;
}

export interface SmokeCheck {
  name: string;
  run: (http: SmokeHttp) => Promise<string>;
}

export interface SmokeResult {
  name: string;
  ok: boolean;
  /** 通过时是一句摘要；失败时是原因 */
  detail: string;
}

/** 管理层凭据（全部给了才跑管理层）。 */
export interface SmokeAdminCreds {
  email: string;
  password: string;
  /** TOTP 的 base32 密钥（`npm run admin:totp` 打印的那个） */
  totpSecret: string;
}

/** 对账类目：有数即系统故障（@see 文件头 @why）。 */
export const RECONCILE_MUST_BE_ZERO = [
  'stalled_heartbeats',
  'unfinished_callbacks',
  'paid_without_succeeded_payment',
  'dangling_initiated_payments',
  'provider_refund_unrecorded',
  'launch_not_ready',
] as const;

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function expectStatus(r: { status: number }, want: number, what: string): void {
  if (r.status !== want) throw new Error(`${what}：期望 ${String(want)}，实际 ${String(r.status)}`);
}

/** 公开层检查（不需要凭据）。 */
export function publicChecks(): SmokeCheck[] {
  return [
    {
      name: '进程存活 /healthz',
      run: async (http) => {
        expectStatus(await http('GET', '/healthz'), 200, '/healthz');
        return '200';
      },
    },
    {
      name: '就绪 /readyz（数据库可达、未在停机）',
      run: async (http) => {
        expectStatus(await http('GET', '/readyz'), 200, '/readyz');
        return '200';
      },
    },
    {
      name: '条款 GET /api/v1/terms 带版本号',
      run: async (http) => {
        const r = await http('GET', '/api/v1/terms');
        expectStatus(r, 200, '/terms');
        const v = obj(r.json)['version'];
        if (typeof v !== 'string' || v === '') throw new Error('响应里没有 version');
        return `version=${v}`;
      },
    },
    {
      name: '首页 GET /api/v1/home（轮播与分类）',
      run: async (http) => {
        const r = await http('GET', '/api/v1/home');
        expectStatus(r, 200, '/home');
        const tabs = obj(r.json)['category_tabs'];
        if (!Array.isArray(tabs)) throw new Error('响应里没有 category_tabs 数组');
        return `${String(tabs.length)} 个分类`;
      },
    },
    {
      name: '商品列表 GET /api/v1/products 至少一件在售',
      run: async (http) => {
        const r = await http('GET', '/api/v1/products?page=1&size=5');
        expectStatus(r, 200, '/products');
        const items = obj(r.json)['items'];
        if (!Array.isArray(items) || items.length === 0) throw new Error('列表为空：没有在售商品');
        const first = obj(items[0]);
        if (!Number.isInteger(first['price_jpy'])) throw new Error('首件没有整数 price_jpy');
        return `首件 ${String(first['title'] ?? '')}`;
      },
    },
    {
      name: '商品详情 GET /api/v1/products/{id}',
      run: async (http) => {
        const list = await http('GET', '/api/v1/products?page=1&size=1');
        const items = obj(list.json)['items'];
        const id = Array.isArray(items) ? obj(items[0])['id'] : undefined;
        if (typeof id !== 'string') throw new Error('列表首件没有 id');
        const r = await http('GET', `/api/v1/products/${encodeURIComponent(id)}`);
        expectStatus(r, 200, '/products/{id}');
        return id;
      },
    },
    {
      name: '未登录访问受保护接口 → 401（鉴权没被配丢）',
      run: async (http) => {
        expectStatus(await http('GET', '/api/v1/orders'), 401, '/orders 无 token');
        return '401';
      },
    },
  ];
}

/**
 * 管理层检查。`totp` 由调用方按当前时刻算（纯函数不读时钟）。
 * @param totpNow 返回当前 6 位码的函数（入口用 server/src/adapters/totp.ts 的 totpAt(secret, Date.now())）
 */
export function adminChecks(creds: SmokeAdminCreds, totpNow: () => string): SmokeCheck[] {
  let token = '';
  return [
    {
      name: '管理员登录（口令 + TOTP）',
      run: async (http) => {
        const r = await http('POST', '/api/v1/auth/admin/login', {
          body: { email: creds.email, password: creds.password, totp: totpNow() },
        });
        expectStatus(r, 200, '管理员登录');
        const t = obj(r.json)['token'];
        if (typeof t !== 'string' || t === '') throw new Error('登录响应没有 token');
        token = t;
        return '已登录';
      },
    },
    {
      name: '订单列表 GET /api/v1/admin/orders',
      run: async (http) => {
        const r = await http('GET', '/api/v1/admin/orders?size=1', { token });
        expectStatus(r, 200, '/admin/orders');
        return `total=${String(obj(r.json)['total'] ?? '?')}`;
      },
    },
    {
      name: '每日对账：最近一次存在且系统类异常为 0',
      run: async (http) => {
        const r = await http('GET', '/api/v1/admin/reconciliation/latest', { token });
        expectStatus(r, 200, '/admin/reconciliation/latest');
        const run = obj(r.json)['run'];
        if (run === null || run === undefined)
          throw new Error('还没有任何一次对账记录：每日作业没跑过');
        const ranAt = String(obj(run)['ran_at']);
        const counts = obj(obj(run)['counts']);
        const bad = RECONCILE_MUST_BE_ZERO.filter((k) => Number(counts[k] ?? 0) > 0).map(
          (k) => `${k}=${String(counts[k])}`,
        );
        if (bad.length > 0)
          throw new Error(`对账有系统类异常：${bad.join(', ')}（ran_at ${ranAt}）`);
        return `ran_at ${ranAt}`;
      },
    },
  ];
}

/** 顺序执行；某一条失败不中断后面的（一次跑完能看到全貌）。 */
export async function runChecks(
  checks: readonly SmokeCheck[],
  http: SmokeHttp,
): Promise<SmokeResult[]> {
  const out: SmokeResult[] = [];
  for (const c of checks) {
    try {
      out.push({ name: c.name, ok: true, detail: await c.run(http) });
    } catch (e) {
      out.push({ name: c.name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** 终端 / CI 日志用的报告；最后一行是结论，便于 `tail -1`。 */
export function formatReport(baseUrl: string, results: readonly SmokeResult[]): string {
  const lines = results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  lines.push(
    failed === 0
      ? `smoke ok: ${String(results.length)} passed (${baseUrl})`
      : `smoke FAILED: ${String(failed)} of ${String(results.length)} failed (${baseUrl})`,
  );
  return lines.join('\n');
}
