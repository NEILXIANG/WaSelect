/**
 * 职责：断言「小程序业务代码不得直接调用宿主的 storage 接口」（F14 第四单元的守卫）。
 *
 * @why `storage.ts` 的存在意义是**统一三件事**（前缀 / JSON / 损坏兜底），
 *      但它只能在"人人都走它"时才成立。绕开它的写法（`wxApi.getStorageSync('token')`）
 *      在类型上、在运行时、在 `npm run lint` 上**全都不报错**——
 *      它只是少了一个 `ws:` 前缀，于是与同 appid 内任何第三方 SDK 的同名键互撞，
 *      表现为"数据突然不对"且毫无线索。这类失效没有任何自然信号，只能靠扫描。
 *
 * @why 不复用 ESLint 那条 `no-restricted-globals`：那条拦的是**全局名 `wx`**，
 *      这里要拦的是"拿到了 WxApi 之后仍直连 storage"——`app.js` 在被本单元修掉之前
 *      就是这么写的，正好是它拦不住的形态。两条规则互补，不是重复。
 *
 * @how 纯 fs + 正则（与 `design-token.unit.test.ts` 同套路）：
 *      只匹配**调用形态**（点号 + 方法名 + 左括号），不做语法解析。
 *
 * @limitation 一：**注释里提到这些方法名不会被拦**（只匹配调用形态）。
 *              这是刻意的：注释是说明不是调用，把它算成违规会逼人把注释写得拐弯抹角。
 *              代价是"用注释行伪装调用"能绕过——那不是本门禁要防的失效形态（那是自欺）。
 * @limitation 二：**不识别 `wxApi['getStorageSync'](...)`** 这种下标访问。
 *              精确识别要真解析 AST；本项目当前没有人这么写，出现时再升级到 ESLint 规则。
 * @limitation 三：豁免 `*.test.ts`——测试**就是要**直接打这两个接口（用内存版宿主替身），
 *              把它们算成违规会逼测试去绕开被测对象本身。
 *
 * @see ./utils/storage.js（唯一入口）；./utils/wx-api.js（唯一声明处）；docs/自主决策记录.md AJ-69
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const SOURCE_ROOT = 'miniprogram';

/**
 * 唯一允许直接调用宿主 storage 接口的两个文件。
 * @why 一个是**声明处**（它没有别的实现可走），一个是**封装处**（它就是规则本身）。
 *      豁免必须有名单而不是"看起来像 utils 就放过"——后者会随目录扩张静默放水。
 */
const EXEMPT = ['miniprogram/utils/wx-api.ts', 'miniprogram/utils/storage.ts'];

/**
 * 调用形态：点号 + 方法名 + 左括号。@see @limitation 一
 *
 * ⚠️ 刻意**不带 `g` 标志**：带 `g` 的正则 `test()` 会**跨调用保留 `lastIndex`**，
 *    于是逐行扫描时第二次调用从上一行的匹配位置继续——**漏掉真正的违规且一声不响**。
 *    实测就是这个自检查出来的（三处调用只扫出两处）。
 *    这是"扫描型门禁"最危险的一类失效：**假阴性**（门禁看起来在跑，其实在漏）。
 */
const CALL = /\.\s*(?:getStorageSync|setStorageSync|removeStorageSync)\s*\(/;

function isExempt(rel: string): boolean {
  return EXEMPT.includes(rel) || rel.includes('.test.') || rel.endsWith('.fixture.js');
}

function listSource(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSource(full, out);
    else if (/\.(js|ts)$/.test(entry.name)) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

interface Violation {
  rel: string;
  line: number;
  text: string;
}

function scan(files: string[]): Violation[] {
  const found: Violation[] = [];
  for (const rel of files) {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (CALL.test(text)) found.push({ rel, line: i + 1, text: text.trim() });
    });
  }
  return found;
}

const all = listSource(join(root, SOURCE_ROOT)).sort();
const watched = all.filter((f) => !isExempt(f));

describe(`${SOURCE_ROOT}：storage 必须走 utils/storage.js`, () => {
  it('扫描范围非空，且**必须含 app.js**（否则下面那条"零违规"是假绿灯）', () => {
    // @why 目录改名 / 过滤条件写错 / 豁免名单写成通配，都会让 `watched` 变成空数组，
    //      于是"没有违规"永远成立——它看起来和真的没有违规一模一样。
    //      这是本项目第三次踩同一形态（类型感知 AJ-3、分层 AJ-43），
    //      所以钉一条"范围里必须有那个真实存在、且真的会用到 storage 的文件"。
    expect(all.length).toBeGreaterThan(5);
    expect(watched).toContain('miniprogram/app.js');
  });

  it('业务代码里没有直接调用宿主 storage 接口（守卫"有人绕开封装"）', () => {
    const offenders = scan(watched).map((v) => `${v.rel}:${v.line}  ${v.text.slice(0, 80)}`);
    expect(
      offenders,
      `绕开了 utils/storage.js（丢了 ws: 前缀 → 与同 appid 内其它键互撞且不报错）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('匹配器自检：一段含三处调用的内联源码必须被扫出三条', () => {
    // @why 与上一条形同"门禁的门禁"的另一半：上一条证明"现在没人违规"，
    //      这一条证明"真有人违规时会红"。少了它，一个写坏的正则会永远绿。
    //      用内联字符串而不是夹具文件：正则极简，真正会坏的是**扫描范围**（已由上一条守住），
    //      为一个三行正则单独建一个夹具文件不划算。
    const sample = [
      "const a = wxApi.getStorageSync('token');",
      "wxApi.setStorageSync('token', 'x');",
      "api.removeStorageSync('token');",
      '// 注释里提到 getStorageSync 不算调用（@see @limitation 一）',
    ];
    const hits = sample.filter((l) => CALL.test(l)).length;
    expect(hits).toBe(3);
  });
});
