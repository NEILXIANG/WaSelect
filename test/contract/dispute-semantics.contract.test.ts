/**
 * 职责：钉住"**拒付结案后 `has_dispute` 的口径**"在契约与代码注释里只有**一版**说法（B33）。
 *
 * @why 0.6.10① 把口径从"结案即复位"改成"**败诉保持 true**"，实现（`app/mark-disputed.ts`）
 *      当天就跟着改了，但契约的 refund 路由描述、0.6.7 的版本说明、以及两处 `@why` 注释
 *      **仍写着旧说法**（B33 实锤）。这类漂移**不会让任何测试变红**——它只存在于
 *      "人读得到"的地方，而下一次照着注释改代码的人会把实现改回旧口径。
 *      按 ADR-29（注释与事实不符 = bug），这就是 bug，且是**必复发**的那一种：
 *      本项目 §2 第 62 条的教训正是"改了口径没 grep 旧说法"。
 *
 * @why 做成"扫描 + 自检"而不是手写几条断言：扫描器写坏（永远返回"没命中"）时，
 *      "没有旧说法"这条业务断言照样全绿——**必须有一条自检用例证明扫描器真能抓到**
 *      （§2 第 34 条：扫描型门禁必须配自检）。
 *
 * @limitation 一：**只覆盖"措辞清单"这一层**。换一种说法的陈旧表述扫不到——
 *              这类门禁天然是**部分**覆盖。它的价值不在"抓住所有陈旧说法"，
 *              而在把"改口径要 grep 全库"从一条靠自觉的纪律变成**会红的门禁**：
 *              谁改了口径，这里会先红，逼他回来把旧说法一起改掉。
 * @limitation 二：扫描范围**刻意只限四个文件**（契约 + 三处持口径的代码注释），
 *              不扫 `docs/`——决策记录是**按时间追加**的历史，AJ-176 里必然出现
 *              "旧口径"字样，扫它只会逼人改写历史。
 *
 * @see contracts/api-contract.yaml 0.6.10①；server/src/app/mark-disputed.ts；
 *      server/src/app/mount.ts；docs/自主决策记录.md AJ-176 ⑧
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 持 `has_dispute` 口径的文件（@limitation 二：不扫 docs/）。 */
const SCANNED = [
  'contracts/api-contract.yaml',
  'server/src/app/mark-disputed.ts',
  'server/src/app/mount.ts',
] as const;

/**
 * 已被 0.6.10① 废掉的旧说法。
 * @why 逐条列而不是写一条"聪明"的正则：正则会把 0.6.10① 自己的句子
 *      （"只有胜诉复位（0.6.7 原为：胜诉与败诉都复位）"）也判成陈旧——
 *      那是**正确的历史陈述**。清单只钉"会误导读者"的那几种写法。
 */
const STALE_PHRASES = [
  'won/lost 都复位',
  'won/lost）时它被复位',
  '结案（won/lost）',
  '一律复位',
  '结案即复位',
  '结案必须把 `orders.has_dispute` **复位成 false**',
] as const;

interface Hit {
  file: string;
  line: number;
  phrase: string;
}

function scanFor(text: string, file: string): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((line, i) => {
    for (const phrase of STALE_PHRASES) {
      if (line.includes(phrase)) hits.push({ file, line: i + 1, phrase });
    }
  });
  return hits;
}

/** 取 refund 路由那段 `description:`（B33 出错的正是这一行）。 */
function refundDescription(yaml: string): string {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.includes('/admin/orders/{id}/refund:'));
  if (at < 0) throw new Error('契约里找不到 /admin/orders/{id}/refund 路由');
  for (let i = at + 1; i < Math.min(at + 8, lines.length); i += 1) {
    const m = /^\s*description:\s*(.+)$/.exec(lines[i] ?? '');
    if (m !== null) return m[1] ?? '';
  }
  throw new Error('refund 路由下面找不到 description（契约结构变了）');
}

describe('B33：拒付结案的 has_dispute 口径，契约与注释不得残留旧说法', () => {
  it('四个扫描目标里没有任何一条旧说法', () => {
    // 🔴 判定标准（§2 第 21 条）：把契约 refund 描述改回"结案（won/lost）时它被复位为 false"
    //    → 本条必须红。只改注释不改契约、或只改契约不改注释，都要各自红。
    for (const rel of SCANNED) {
      const text = readFileSync(join(root, rel), 'utf8');
      const hits = scanFor(text, rel);
      expect(
        hits.map((h) => `${h.file}:${h.line} → ${h.phrase}`),
        `${rel} 里仍有 0.6.10① 之前的旧说法`,
      ).toEqual([]);
    }
  });

  it('refund 路由描述**显式**跟到 0.6.10① 的新口径（不是"删掉旧句子"就算改过）', () => {
    // @why 单独钉这一条：只钉"没有旧说法"的话，把整个 has_dispute 句子**删掉**也全绿——
    //      那等于"契约不再解释闸门语义"，比写错更坏（读者连去哪查都不知道）。
    const desc = refundDescription(readFileSync(join(root, SCANNED[0]), 'utf8'));
    expect(desc.includes('0.6.10')).toBe(true);
    expect(desc.includes('败诉保持 true')).toBe(true);
    // 新口径的完整三要素：语义名 + 谁解除 + 谁继续拦
    expect(desc.includes('未解除的拒付限制')).toBe(true);
  });
});

describe('自检（§2 第 34 条：扫描器本身必须被验证）', () => {
  it('扫描器对每一条旧说法都真的报命中', () => {
    for (const phrase of STALE_PHRASES) {
      const hits = scanFor(`x\n某处写着 ${phrase} 的说明\ny`, 'sample.ts');
      expect(hits, `扫描器漏掉了「${phrase}」`).toHaveLength(1);
      expect(hits[0]?.line).toBe(2);
    }
  });

  it('扫描器对**正确**的新口径不报命中（避免把好句子也扫成陈旧）', () => {
    const good = [
      '只有 lost 保持 true，won 与 withdrawn 都复位',
      '⚠️ 0.6.10① 起 has_dispute 的语义是「有未解除的拒付限制」',
      '结案后 has_dispute：lost 保持 true，won 与 withdrawn 复位',
      '只有**胜诉**复位（0.6.7 原为：胜诉与败诉都复位）',
    ];
    for (const line of good) {
      expect(scanFor(line, 'sample.ts'), `误报：${line}`).toEqual([]);
    }
  });
});
