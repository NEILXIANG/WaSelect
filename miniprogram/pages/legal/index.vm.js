/**
 * 职责：法务页（`pages/legal`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 结算页有一个"阅读并同意购买条款"的勾选，而**条款正文在小程序里打不开**
 *      （D-49 已废 web-view，外站页面只能靠复制链接出去看）。
 *      于是"用户到底同意了什么"这件事全押在 `/terms` 给的链接上——
 *      链接少一个语种、带个空格、或者根本没拿到，页面**照样能渲染**，
 *      只是用户复制走一个打不开的地址，而没有任何东西报错。
 *      这类"看起来能用、实际是坏的"只能靠纯函数层逐条钉住。
 *
 * @why **不在这里写条款正文**：正文的单一事实源是 `checkout.<domain>` 上的静态页
 *      （契约 `/terms` 的 `urls` 指的就是它们）。小程序里再抄一份的后果是
 *      "改了条款、小程序里还是旧版"，而版本号对得上——比没有更危险。
 *      依据见文档库 `jp/20-股权与合同/法务文本要点-隐私政策·用户协议·退款政策.md` §0
 *      （四份文本的发布位置：小程序法务页 + checkout 静态站）。
 *
 * @limitation 一：**不显示 `updated_at`**。它是 UTC 的 ISO 串，要按项目口径（JST）
 *              显示就得做时间运算，而 vm 里不允许读时钟（F10 / vm-guard）。
 *              版本号的例子 `TOS-2026-09-20` 本身已带日期，够用了。
 *              等契约给出"服务端已格式化好的展示串"再补，不在前端发明时区换算。
 * @limitation 二：`urls` 只认 `zh` / `ja` / `en` 三个键（与契约双向比对，单测钉住）。
 *              契约将来加语种而这里没跟上 → 单测立刻红；
 *              反过来这里多写一个键 → 同样红（多出来的那行会是一个空链接）。
 * @limitation 三：url **trim 后为空就整行丢掉**，不是显示一个空的"复制"。
 *              空白 url 复制下来什么都没有，用户会以为是小程序坏了。
 *
 * @see ../../../contracts/api-contract.yaml（GET /terms）；CLAUDE.md 约束十一
 */

/**
 * 三个语种的展示顺序与文案。
 *
 * @why 顺序是**产品决定**（中文优先：当前用户群是中文买家），不是契约顺序——
 *      所以它是这里的常量，靠单测与契约比对"有没有漏语种"，
 *      而不是把契约的键顺序原样渲染出来（那等于把展示顺序交给后端）。
 */
export const LANG_ROWS = [
  { key: 'zh', label: '中文' },
  { key: 'ja', label: '日本語' },
  { key: 'en', label: 'English' },
];

/**
 * `GET /terms` 的响应 → 法务页视图。
 *
 * @param {unknown} res 契约 `{version, updated_at, urls:{zh,ja,en}}`；也可能是任何东西
 * @returns {{version: string, hasVersion: boolean, langs: Array<{key: string, label: string, url: string}>}}
 *
 * @why `version` 与 `langs` 分开给：版本号是"你同意的是哪一版"的唯一凭证，
 *      链接是"去哪看"。两者都拿不到时页面要给的是**两种不同**的提示
 *      （"加载中" vs "暂时没有可查看的条款"），合成一个布尔值说不清。
 */
export function termsView(res) {
  const o = res !== null && typeof res === 'object' && !Array.isArray(res) ? res : {};
  const version = typeof o.version === 'string' ? o.version.trim() : '';
  const urls =
    o.urls !== null && typeof o.urls === 'object' && !Array.isArray(o.urls) ? o.urls : {};

  const langs = LANG_ROWS.map((r) => ({
    key: r.key,
    label: r.label,
    // ⚠️ trim 而不是原样透传：`urls.zh = ' https://… '` 复制进浏览器是打不开的，
    //    而它不会报错——用户只会觉得"这个站给我一个坏链接"（@see @limitation 三）
    url: typeof urls[r.key] === 'string' ? urls[r.key].trim() : '',
    // 只给出浏览器打得开的绝对地址（W-06）：服务端在法务页上线前返回的是 `/legal/terms.zh.html`
    // 这类占位相对路径，复制到浏览器打不开；宁可落到"暂时没有可查看的条款"，也不给一个坏链接。
  })).filter((r) => /^https:\/\//.test(r.url));

  return { version, hasVersion: version !== '', langs };
}

/**
 * 法务页三态：加载中 / 有条款可看 / 暂时没有。
 *
 * @param {unknown} s 期望 `{loading?: boolean, langCount?: number, error?: string}`；
 *                    标 `unknown` 而不是那个对象类型，是因为它**必须**接得住脏输入——
 *                    页面传进来的可能是任何东西（`langCount` 是字符串 / 整个值是 null），
 *                    而标成精确类型会让"不脏"这件事看起来已经被类型保证了（它没有）。
 * @returns {{showLoading: boolean, showList: boolean, showEmpty: boolean}}
 *
 * @why 与订单列表页 `emptyState` 同一条口径：**请求失败时不能说"没有"**。
 *      法务页说"暂时没有可查看的条款"而实际是网络挂了，
 *      用户读到的是"这家店没有条款"——那是最坏的一种暗示，且没人会来纠正它。
 * @why `loading` 也要参与：拉不到数据时 `langCount` 也是 0，
 *      只看 count 的表现是"进来先闪一句'没有条款'，然后才出现列表"。
 */
export function legalState(s) {
  const x = s !== null && typeof s === 'object' ? s : {};
  const failed = typeof x.error === 'string' && x.error !== '';
  const loading = x.loading === true;
  const count = Number.isInteger(x.langCount) ? x.langCount : 0;
  return {
    showLoading: loading && !failed,
    showList: !loading && !failed && count > 0,
    showEmpty: !loading && !failed && count === 0,
  };
}

/**
 * 四类法务文档（剩余清单 4-1）：固定顺序 + 中文名 + 一句交叉说明（可空）。
 * 键与服务端 `server/src/domain/legal.ts` 的 LEGAL_DOCS 同名。
 * @why 顺序写死在这里而不是跟随服务端对象的键序：JSON 对象键序不是契约的一部分，按它排会让页面顺序随服务端实现漂移。
 * @why `note` 一律给（没有就给空串）而不是只给需要的那一行：四类文档是**同一种东西的四份**，
 *      形状一致时"这一类有没有说明"才是一眼能看出来的差别（也让 `doc.note` 读起来不出 undefined）。
 */
export const DOC_ROWS = [
  { key: 'terms', title: '用户协议', note: '' },
  { key: 'privacy', title: '隐私政策', note: '' },
  /**
   * 审计 CPY-08：这一份在**政策页**叫「退货与退款政策」，在**功能入口**叫「售后」
   * （订单详情的「申请售后」、订单页签「售后·退款」）——两边一个共同词都没有。
   * @why 改的是**加一句交叉说明**而不是改标题：标题是这份法务文本自己的名字
   *      （checkout 静态站上那份 `<title>` 就叫「退货与退款政策」），改名等于让两处指的不是同一份文件。
   *      补一句说明，从「售后」点进来的人能认出这就是管那件事的那一份。
   */
  { key: 'refund', title: '退货与退款政策', note: '订单里的「售后」申请，按这份政策处理' },
  { key: 'tokushoho', title: '日本特定商交易法标示（商家信息）', note: '' },
];

/**
 * `GET /terms` 的 `documents` → 每类文档的可复制链接。
 * @why 与 termsView 同一条过滤口径（只留 https 绝对地址，W-06）；整类没有可用链接的文档不出现，
 *      而不是显示一张"没有链接的卡"。不认识的文档类不出现（服务端加一类而这里没跟上 → 只是不显示，不会显示乱码标题）。
 * @why 语种行的 key 带文档前缀（`terms:zh`）：页面的"已复制"按 key 标记，四类文档共用 zh 时不能串。
 * @returns {Array<{key: string, title: string, note: string, langs: Array<{key: string, label: string, url: string}>}>}
 */
export function documentsView(res) {
  const o = res !== null && typeof res === 'object' && !Array.isArray(res) ? res : {};
  const docs =
    o.documents !== null && typeof o.documents === 'object' && !Array.isArray(o.documents)
      ? o.documents
      : {};
  return DOC_ROWS.map((d) => {
    const urls = docs[d.key] !== null && typeof docs[d.key] === 'object' ? docs[d.key] : {};
    const langs = LANG_ROWS.map((r) => ({
      key: `${d.key}:${r.key}`,
      label: r.label,
      url: typeof urls[r.key] === 'string' ? urls[r.key].trim() : '',
    })).filter((r) => /^https:\/\//.test(r.url));
    return { key: d.key, title: d.title, note: d.note, langs };
  }).filter((d) => d.langs.length > 0);
}

/** 特商法字段的展示顺序与标签（与静态页 tokushoho 同口径）。 */
const SELLER_ROWS = [
  { key: 'name', label: '销售商（販売業者）' },
  { key: 'representative', label: '负责人' },
  { key: 'address', label: '所在地' },
  { key: 'phone', label: '电话' },
  { key: 'email', label: '联系邮箱' },
];

/**
 * `GET /terms` 的 `seller` → 展示行。只列服务端给了的字段（公司登记前为空，不编占位值）。
 * @returns {Array<{label: string, value: string}>}
 */
export function sellerRows(res) {
  const o = res !== null && typeof res === 'object' && !Array.isArray(res) ? res : {};
  const s =
    o.seller !== null && typeof o.seller === 'object' && !Array.isArray(o.seller) ? o.seller : {};
  return SELLER_ROWS.filter((r) => typeof s[r.key] === 'string' && s[r.key].trim() !== '').map(
    (r) => ({ label: r.label, value: s[r.key].trim() }),
  );
}
