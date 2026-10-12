/**
 * 职责："看得懂"不变量——运营 / 买家看到的文字里不许出现内部码（测试缺口复盘 2026-10-12，`docs/测试缺口复盘-2026-10-12.md`）。
 *
 * @why 这两天真实界面上找到的问题，约四成是"看不懂 / 说错话"：36 位用户 id、`支付机构 mock`、
 *      英文状态 `paid`、裸错误码 40400、「円」。旧测试的期望值是照着实现抄的，实现输出什么就断言什么，
 *      于是缺陷被断言锁住（17 / 46 个修复要改旧断言）。这里给测试一个**独立于实现**的判据：
 *      不管文案怎么写，下面这些东西出现在展示文字里就是缺陷。
 * @why 递归收集 view 对象里的字符串，但跳过"给程序用"的键（id / url / 图片 / 跳转意图）：
 *      vm 的输出里本来就混着导航用的 id，那些不上屏。
 * @limitation 一：只能拦"出现了内部码"，拦不了"这句话新手看不看得懂"——那仍靠走查。
 * @limitation 二：裸错误码按 `4xxxx / 5xxxx` 判，美国邮编 40000–59999（肯塔基、密歇根……）会误报；
 *              旅程 fixture 用加州 / 纽约地址避开，地址字段另由 `SKIP_KEY` 跳过。
 * @limitation 三：键名判"给程序用"是约定（`*Id` / `*Url` / `image` …），新 vm 若把展示文字放进这类键名会被漏看。
 */

/** 不上屏的键：标识、链接、图片、跳转意图、原始数值。 */
const SKIP_KEY =
  /(^id$|Id$|^ids$|Ids$|url$|Url$|href$|Href$|^src$|image|Image|thumb|Thumb|^go$|^query$|^path$|^key$|Key$|^ref$|^raw|Raw$|^code$|^status$|Jpy$|Minor$|^qty$|^currency$|^channel$|^postal|^zip|^phone)/;

export interface Finding {
  path: string;
  text: string;
  why: string;
}

const RULES: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, why: '36 位内部 id' },
  { re: /\bord-[0-9a-z]/i, why: '内部订单编号（ord-…）' },
  {
    re: /\b(pending_payment|paid|shipped|delivered|completed|refunding|refunded|cancelled|expired|closed|refund_failed|partial_refunded|draft|offline)\b/,
    why: '英文状态代号',
  },
  { re: /\b(mock|stripe|wechat_pay|in_app)\b/i, why: '支付通道代号' },
  // 停售状态行曾只写 `admin:<内部 id>`（三端联动模拟 2026-10-08）
  { re: /\b(admin|user|system|job):[\w-]+/, why: '内部账号（admin:… 这类）' },
  { re: /(^|[^\d,.])[45]\d{4}(?![\d,])/, why: '裸错误码（4xxxx / 5xxxx）' },
  { re: /\b(undefined|null|NaN)\b|\[object Object\]/, why: '程序占位值' },
  { re: /円/, why: '「円」（中文读者认不得，D-82）' },
];

/** 递归收集展示文字（跳过 SKIP_KEY）。 */
export function visibleTexts(v: unknown, path = '$'): Array<{ path: string; text: string }> {
  if (typeof v === 'string') return v.trim() === '' ? [] : [{ path, text: v }];
  if (Array.isArray(v)) return v.flatMap((x, i) => visibleTexts(x, `${path}[${String(i)}]`));
  if (v !== null && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      SKIP_KEY.test(k) ? [] : visibleTexts(x, `${path}.${k}`),
    );
  }
  return [];
}

export function unreadable(v: unknown): Finding[] {
  const out: Finding[] = [];
  for (const t of visibleTexts(v)) {
    for (const r of RULES) if (r.re.test(t.text)) out.push({ ...t, why: r.why });
  }
  return out;
}
