/**
 * 职责：**保留/占位域名**的判定（B9 闸门，AJ-375）——服务端启动校验与构建期校验的单一来源。
 *
 * @why 这一类值的危险在于它们**能通过全部形状校验**：`https://img.example.com` 是合法的 https URL，
 *      `https://admin.example.com` 是合法的 origin。于是"照 `.env.example` 抄一份就部署"这件事
 *      在生产上是**全绿启动**的，而支付短链 / 商品图 / 管理端跨域全部指向不存在的地址，
 *      且没有任何日志会说是域名错了——浏览器只报 CORS / 加载失败，服务端看起来一切正常。
 *
 * @why 放在 `shared` 而不是某一端：同一个判据要被**两处**使用——
 *      ① 服务端 `config.ts` 的跨字段规则 4c（生产启动即拒）；
 *      ② `scripts/checkout-build-lib.ts` 的 `assertDeployApiBase`（`PUBLIC_API_BASE` 与
 *         `VITE_API_BASE_URL` 的**构建期**闸门，产物烤着占位域同样是静默故障）。
 *      两处各写一份必然漂移（ADR-29 同口径），而这里与 `us-states.ts` 一样是"只放常量与谓词"的边界内。
 *
 * @measured(RFC 2606 §3)：`example.com` / `example.net` / `example.org` 为文档示例保留，永不分配。
 * @measured(RFC 6761 §6)：`.test` / `.invalid` / `.localhost` 为特殊用途保留；`example.` 同族。
 * @measured(RFC 6762)：`.local` 为 mDNS 保留。
 * @measured(ICANN, 2024)：`.internal` 保留供内部使用。
 * @why `example.edu` 一并纳入：与上面三个同属 IANA 示例域族，同样不可注册。
 *
 * @limitation 一：必须**精确匹配**。
 *      · `includes('example.com')` 会误杀可注册的 `notexample.com` / `myexample.com`；
 *      · `endsWith('example.com')` 同样误杀 `notexample.com`。
 *      故用 `h === d || h.endsWith('.' + d)`；`example.com.cn`（eTLD+1 是 example.com.cn）因此**放行**，这是对的。
 * @limitation 二：只判**主机名**，不判端口与路径——`https://img.waselect.jp:8443` 是真实地址
 *      （端口该不该有是各自的规则，不在这里混一层判断）。
 * @limitation 三：回环与 `0.0.0.0` 也算占位（连的是本机）。IPv6 的 `::1` / `::` 一并纳入，
 *      与 `config.ts` 规则 4 的 `DATABASE_URL` 判定同名单。
 */

/** IANA / RFC 保留的示例域族（`example.edu` 与前三者在 IANA 示例中同族）。 */
const RESERVED_EXAMPLE_DOMAINS: readonly string[] = [
  'example.com',
  'example.net',
  'example.org',
  'example.edu',
];

/** 保留的顶级域后缀（含点，用于 `endsWith`）。 */
const RESERVED_SUFFIXES: readonly string[] = [
  '.test',
  '.invalid',
  '.localhost',
  '.local',
  '.internal',
];

/** 回环 / 任意地址主机名（小写比较）。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '::1',
  '[::1]',
  '::',
  '[::]',
  '0.0.0.0',
]);

export function isPlaceholderHost(host: string): boolean {
  const h = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(h) || h.startsWith('127.')) return true;
  for (const d of RESERVED_EXAMPLE_DOMAINS) {
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  for (const s of RESERVED_SUFFIXES) {
    if (h === s.slice(1) || h.endsWith(s)) return true;
  }
  return false;
}
