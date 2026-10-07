/**
 * 职责：用户可见文案里不出现「审核期 / 测试单」这类对审核员自述的字样（第二轮审查 MP2-03 / AJ-244）。
 *
 * @why 审核期全店只开 mock 通道，审核员点"支付"会直接走完（`auto`）。此前那一屏写着
 *      「本次为审核期测试单，无需真实付款」——等于在界面上告诉审核员"你现在看到的和线上不一样"，
 *      而"审核版与线上版不一致"本身就是常见的驳回理由。测试 SKU 与 mock 支付路径应当写进
 *      提审时的「审核备注」，不写进给用户看的界面（D-81④）。
 *      同一屏的银行卡提示原写「将离开微信」：实物商品在外部完成支付并不在微信的禁止之列（R20b），
 *      但"离开微信"是在替审核员把问题说出来——改成只陈述事实（复制链接、在浏览器完成）。
 * @why 做成扫描而不是只改那两句：文案散在 vm / utils / wxml 里，下一次有人加一句"（审核期）"没有任何东西会拦。
 *
 * @limitation 只扫非注释行（注释里解释审核机制是正当的）；只认列在 FORBIDDEN 里的字样。
 * @why 服务端下发的通道名也扫（第三轮审查 TST3-06）：原来这里写"通道 label 是管理端配置的事"而不扫，
 *      而 AJ-379 起 label 由 `payment_channels` 表驱动；内置表（`server/src/adapters/payment/channels.ts`）
 *      与迁移 seed 逐字同源，所以扫内置表仍覆盖 seed。运行时有人改库里的 label 不在本守卫范围内。
 *      mock 通道的「模拟支付」**刻意保留**（AJ-244：不把模拟支付伪装成真实支付；审核备注里说明），
 *      所以它不在 FORBIDDEN 里；这里守的是"内置表里不出现对审核员自述的字样"。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = import.meta.dirname;
const FORBIDDEN = ['审核期', '测试单', '离开微信'] as const;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(js|wxml)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** 去掉注释（js 的行注释 / 块注释行、wxml 的 <!-- -->），只留会渲染或会下发的内容。 */
function visibleText(src: string, isWxml: boolean): string {
  if (isWxml) return src.replace(/<!--[\s\S]*?-->/g, '');
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

/** 通道内置表里的 `label: '…'` 值（会原样出现在支付页按钮上）。 */
function channelLabels(): string[] {
  const src = readFileSync(join(ROOT, '../server/src/adapters/payment/channels.ts'), 'utf8');
  return [...visibleText(src, false).matchAll(/label:\s*'([^']*)'/g)].map((m) => m[1] ?? '');
}

describe('用户可见文案不对审核员自述（AJ-244）', () => {
  const targets = [
    ...files(join(ROOT, 'pages')),
    ...files(join(ROOT, 'utils')),
    ...files(join(ROOT, 'components')),
  ];

  it('自检：扫到了页面、utils 与组件', () => {
    expect(targets.some((f) => f.endsWith('utils/pay-plan.js'))).toBe(true);
    expect(targets.some((f) => f.endsWith('pages/pay/index.wxml'))).toBe(true);
    expect(targets.length).toBeGreaterThan(20);
  });

  it('🔴 任何页面 / utils / 组件的可见文案里都没有「审核期」「测试单」「离开微信」', () => {
    const hits: string[] = [];
    for (const f of targets) {
      const text = visibleText(readFileSync(f, 'utf8'), f.endsWith('.wxml'));
      for (const w of FORBIDDEN) {
        if (text.includes(w)) hits.push(`${relative(ROOT, f)}：${w}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('🔴 服务端通道内置表的按钮名里也没有这些字样（TST3-06）', () => {
    const labels = channelLabels();
    expect(labels, '自检：应读到微信支付 / 银行卡 / 模拟支付三个 label').toEqual(
      expect.arrayContaining(['微信支付', '银行卡', '模拟支付']),
    );
    const hits = labels.filter((l) => FORBIDDEN.some((w) => l.includes(w)));
    expect(hits).toEqual([]);
  });
});
