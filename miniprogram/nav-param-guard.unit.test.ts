/**
 * 职责：页面跳转**参数名**守卫——A 页 `?name=` 传过去的每个参数，B 页的 `onLoad` 必须真的读 `options.name`。
 *
 * @why 2026-09-30 复核时实际踩到（R-03 / AJ-225）：支付页在微信支付成功后
 *      `redirectTo('/pages/order-detail/index?orderId=…')`，而订单详情页读的是 `options.id`
 *      （订单列表一直传的是 `?id=`）。结果是"付款成功 → 落地页显示『订单不存在或链接无效』"。
 *      两个页面各自的用例全绿：支付页的守卫只断言"有 success 回调"，详情页的 vm 不认识路由参数。
 *      这是典型的**两端各自都对、接起来错**——参数名是两个文件之间的口头约定，没有任何东西校验它。
 *
 * @why 做成扫描型守卫而不是只改那一行：同类跳转全仓有十余处，下一次改名照样会漏（约束九）。
 *      扫描对象是源码文本：`${某页常量}?参数名=` 这一固定写法 + 目标页 `options?.参数名`。
 *
 * @limitation 一：只认 `${XX_PAGE}?name=` 这一种拼法（全仓目前只有这一种）。
 *              改用对象拼 query、或把路径写成字面量，本守卫会**看不见**——
 *              为此有一条"至少扫到 N 处"的自检，写法整体换掉时它会红，提醒同步扩展。
 * @limitation 二：通用规则只校验"传了的参数有人读"，不校验"读的参数有人传"——后者对可选参数会误报。
 *              **唯一的例外**是下面第 3 条：到订单详情页的跳转**必须**带 `id`（这个页面没有 id 就什么都不是）。
 *              它是注入 d2（跳转干脆不带参数）逼出来的——漏传与写错名字的后果完全一样，
 *              而"传了有人读"这条规则对"没传"根本不会生成待检条目，看不见它。
 *              代价：将来新增必带参数的页面时要记得同步这里。
 * @limitation 三：不校验参数**值**的形状（那归各页 `onLoad` 自己的校验）。
 *
 * @see docs/自主决策记录.md AJ-225；pages/pay/index.js；pages/order-detail/index.js
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGES_DIR = join(import.meta.dirname, 'pages');

interface Nav {
  from: string;
  targetPath: string;
  /** 这次跳转带上的全部参数名（按 URL 里的出现顺序）。 */
  params: string[];
}

/** 去掉注释行：注释里的示例写法不算一次真实跳转。 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** 扫一个文件里的"页面路径常量"，例如 `const ORDER_DETAIL_PAGE = '/pages/order-detail/index';`。 */
function pageConsts(code: string): Map<string, string> {
  const consts = new Map<string, string>();
  for (const m of code.matchAll(/const\s+(\w+)\s*=\s*'(\/pages\/[\w-]+\/index)'/g)) {
    consts.set(m[1]!, m[2]!);
  }
  return consts;
}

/** 扫该页发起的**全部**跳转（含不带参数的）。 */
function collectAll(): Nav[] {
  const out: Nav[] = [];
  for (const dir of readdirSync(PAGES_DIR)) {
    const file = join(PAGES_DIR, dir, 'index.js');
    if (!existsSync(file)) continue;
    const code = codeOf(file);
    const consts = pageConsts(code);
    for (const m of code.matchAll(/\$\{(\w+)\}([^`]*)`/g)) {
      const targetPath = consts.get(m[1]!);
      if (targetPath === undefined) continue;
      const rest = m[2]!;
      // `${PAGE}?a=1&b=2` 或 `${PAGE}`；`${PAGE}/sub/path` 不是页面内跳转，跳过
      if (rest !== '' && !rest.startsWith('?')) continue;
      out.push({
        from: `pages/${dir}/index.js`,
        targetPath,
        // ⚠️ 先去掉开头的 `?` 再按 `&` 认参数名：带着它时 `(?:^|&)(\w+)=` 在位置 0 碰到的是 `?`，
        //    一个参数都认不出来（自检会报「扫到 0 处」）。
        params: [...rest.replace(/^\?/, '').matchAll(/(?:^|&)(\w+)=/g)].map((p) => p[1]!),
      });
    }
  }
  return out;
}

/** 展开成"一个参数一条"，供第 2 条用例逐个核对目标页是否读它。 */
function flatten(all: Nav[]): Array<{ from: string; targetPath: string; param: string }> {
  return all.flatMap((n) =>
    n.params.map((param) => ({ from: n.from, targetPath: n.targetPath, param })),
  );
}

describe('页面跳转参数名守卫（R-03 / AJ-225）', () => {
  const all = collectAll();
  const navs = flatten(all);

  it('自检：确实扫到了带参数的跳转（写法整体换掉时这条会红，提醒同步扩展扫描规则）', () => {
    expect(navs.length).toBeGreaterThanOrEqual(6);
    // 已知必有的一条，防"扫到的全是别的东西"
    expect(navs.some((n) => n.targetPath === '/pages/pay/index' && n.param === 'orderId')).toBe(
      true,
    );
  });

  it('每个传出去的参数，目标页都真的读 `options.<参数名>`', () => {
    const broken: string[] = [];
    for (const n of navs) {
      const target = join(import.meta.dirname, `${n.targetPath.slice(1)}.js`);
      const code = existsSync(target) ? codeOf(target) : '';
      const reads = new RegExp(`options\\??\\.${n.param}\\b`).test(code);
      if (!reads)
        broken.push(`${n.from} → ${n.targetPath}?${n.param}=…（目标页没有读 options.${n.param}）`);
    }
    expect(broken, `参数名对不上：\n${broken.join('\n')}`).toEqual([]);
  });

  /**
   * @why 针对订单详情页的**定向**反向校验（@limitation 二的唯一例外）：
   *      注入实验里，把支付页的参数名写错（d1）守卫会红，但**把参数整个删掉**（d2）守卫是全绿的
   *      —— d2 的后果与 d1 一模一样（落地页显示"订单不存在"），而"传了有人读"这条规则
   *      对"没传"根本不会生成任何待检条目。这里显式钉住：到详情页的跳转必须带 `id`。
   */
  it('跳到订单详情页的每一处都带了 `id`', () => {
    const toDetail = all.filter((n) => n.targetPath === '/pages/order-detail/index');
    expect(toDetail.length).toBeGreaterThanOrEqual(2);
    const missing = toDetail
      .filter((n) => !n.params.includes('id'))
      .map(
        (n) =>
          `${n.from} → ${n.targetPath}（${n.params.length === 0 ? '未带任何参数' : `只带了 ${n.params.join('、')}`}）`,
      );
    expect(missing, `跳转漏传 id：\n${missing.join('\n')}`).toEqual([]);
  });
});
