/**
 * 职责：**过时注释**的复发守卫（ADM3-07）。
 *
 * @why 第三轮审查发现同一句"理由"在三处文件头反复写着「vitest 的 unit 层是 node 环境，
 *      没有 jsdom / 没有组件测试 harness」，而 `admin-web/src/testing/dom.ts` 落地后它早已不是事实。
 *      注释与事实分离本身就是 bug（ADR-29）——它会让下一个人**照着错的理由做对的决定**，
 *      也会让"这条纪律还有没有必要"无法讨论（讨论的前提是理由是真的）。
 *      改完一次不设防，同一句会像上次一样被复制到第四处（这次就已经多了一处：覆盖率配置）。
 *
 * @why 用**黑名单短语**扫源码，而不是只盯那四个文件：
 *      漂移的传染方式就是"复制到新文件"，只盯原地的守卫挡不住它。
 *
 * @limitation 一：只扫 `ROOTS`（管理端源码 + 两个测试配置 + Stripe 样本工厂 + API 契约），
 *      **不做全仓扫描**。
 *      @why 全仓扫描实测 ~3s（2000+ 文件），会撞上 unit 层默认的 5s 测试超时——
 *      在机器忙的那一轮里它自己会变成**假红灯**（2026-10-01 实测：全仓版与另一条仓库扫描守卫
 *      `business-events.unit.test.ts` 在满载那一轮双双 timeout，单跑各自都绿）。
 *      而这句过时理由的复制路径恰恰就是这两处（文件头 → 邻近文件头 → 配置文件），
 *      扫它们已经覆盖了漂移的真实方向；真被复制到别处，靠评审兜。
 * @limitation 二：只拦这几条**已经证伪**的具体说法，不做通用"注释是否与实现一致"的判断——
 *              那是语义判断，脚本做不到。新增证伪的说法时把它加进 `STALE` 即可。
 * @limitation 三：明写"曾经写……"或"订正"的那一行放行（它在**记录**旧说法，不是在使用它）——
 *              否则"改注释"与"记录改过什么"互相打架，最后没人敢写订正理由。
 *              ⚠️ 代价：一个说法被登记进 `STALE` 之后，就**不能再以"记录"之外的方式**出现，
 *              包括"这句话已经过时了"这类说明——所以订正注释一律用「⚠️ 曾经写……」开头。
 *
 * @see admin-web/src/testing/dom.ts（jsdom 组件用例宿主）；vitest.coverage-gates.ts（覆盖率口径）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');

/**
 * 扫描范围（见 @limitation 一）。
 *
 * @why 服务器侧只收 **adapters / domain / app 三个目录 + shared**，不收全仓：
 *      CAT2-10 那批过时说法全部落在这四处（"注释与实现对不上"最常出现在
 *      "这个文件做什么"的文件头与"这个接口返回什么"的类型旁），
 *      而全仓扫描的耗时风险见 @limitation 一。被复制到别处的，靠评审兜。
 */
const ROOTS = [
  join(ROOT, 'admin-web/src'),
  join(ROOT, 'vitest.coverage-gates.ts'),
  join(ROOT, 'vitest.config.mts'),
  join(ROOT, 'test/factories/stripe.ts'), // PAY3-06：样本工厂的"实现来源"与"没造哪些样本"两处口径
  join(ROOT, 'contracts/api-contract.yaml'), // PAY3-06：锁定口径是前后端共同读的唯一真源
  join(ROOT, 'server/src/adapters'), // CAT2-10：接口注释的返回形态、跨文件 @why 指向
  join(ROOT, 'server/src/domain'), // CAT2-10：文件头的"边界"段指向的落库方
  join(ROOT, 'server/src/app'), // CAT2-10：文件头的"唯一/当前没有"这类全称判断
  join(ROOT, 'packages/shared/src'), // CAT2-10：跨端共享文件的"谁在引用它"
];

/** 已经证伪的说法 → 命中即红（第二项是给人看的"应该说成什么"）。 */
const STALE: ReadonlyArray<readonly [string, string]> = [
  ['没有 jsdom', 'jsdom 组件用例由 admin-web/src/testing/dom.ts 提供（*.dom.unit.test.ts）'],
  ['没有组件测试 harness', 'harness 已存在，组件用例只是成本比纯函数高'],
  ['未引入 testing-library', '刻意不引第三方库，自研 harness 三十行够用'],
  ['没有 jsdom / React Testing Library', '同上'],
  ['会用官方 SDK', '生产验签是 stripe-checkout.ts 自己用 createHmac 写的，刻意不引 SDK（PAY3-06）'],
  [
    'dispute.closed` 等售后后续事件',
    '`charge.dispute.closed` 早已在 STRIPE_EVENT_TYPES 里，也不在豁免名单中（PAY3-06）',
  ],
  [
    '同一账号连续失败 5 次',
    'AJ-243 后是两层桶：同邮箱 × 同来源 5 次，或同邮箱合计 30 次（PAY3-06）',
  ],
  // ── CAT2-10：注释与实现对不上（逐条已回读实现确认） ────────────────────────
  [
    '唯一不可逆',
    '运费整表替换（admin-ops-routes）与 Banner 删除（admin-banner-routes）同样不可逆，三处凭的是同一条理由（CAT2-10）',
  ],
  [
    'replaceShippingRates 要在同一事务里读回结果',
    'selectFxRates 读 fx_rates、replaceShippingRates 读 shipping_rates；且当前三处调用都传 db，没有事务用法（CAT2-10）',
  ],
  [
    '不存在或非本人 → false。',
    'update() 返回 `AddressRow | null`，返回 false 的是 remove()（CAT2-10；注意句末句号用来区分两行）',
  ],
  [
    '不做落库（那是 `adapters/catalog.ts`）',
    '写入方是 `catalog-admin.ts`；`catalog.ts` 是买家侧的**读**仓储（CAT2-10）',
  ],
  ['ProductInputValue', '类型是 `ProductInput`，没有 `ProductInputValue` 这个类型（CAT2-10）'],
  [
    '国家档案当前没有消费方',
    '已有三个：app/address-routes、app/quote-assembly、app/admin-order-routes（CAT2-10）',
  ],
  [
    '报价/建单/下单页反复读',
    '实际是"地址校验"与"报价"两条路径；这句话曾与同文件"没有消费方"自相矛盾（CAT2-10）',
  ],
  ['小程序同源引用', 'limits.ts 只有 server / admin-web 两个消费方，小程序不引用它（CAT2-10）'],
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

function* walk(p: string): Generator<string> {
  if (statSync(p).isFile()) {
    if (/\.(ts|tsx|mts|yaml)$/.test(p)) yield p;
    return;
  }
  for (const name of readdirSync(p)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(p, name));
  }
}

/** 命中的过时说法（相对路径 + 行号 + 行内容）。 */
function hits(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        // @limitation 三：明写"曾经写/订正"的那一行放行——它在**记录**旧说法，不是在使用它
        if (line.includes('订正') || line.includes('曾经写')) return;
        for (const [phrase] of STALE) {
          if (line.includes(phrase)) {
            out.push(`${relative(ROOT, file)}:${String(i + 1)} 「${line.trim()}」`);
            break;
          }
        }
      });
    }
  }
  return out;
}

describe('注释不得重复已证伪的说法（ADM3-07 / PAY3-06）', () => {
  it('🔴 受扫范围内不再出现已证伪的说法（jsdom、Stripe 验签来源、锁定口径等）', () => {
    expect(hits()).toEqual([]);
  });

  it('🔴 jsdom 组件用例的宿主仍在（守卫的前置事实被删了，上面那条就成了空门禁）', () => {
    const host = join(ROOT, 'admin-web/src/testing/dom.ts');
    expect(readFileSync(host, 'utf8')).toContain('jsdom');
  });
});
