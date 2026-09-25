/**
 * 职责：F17 单元②的门禁——开发文档与三个模板「存在且含必备章节」，外加 README 的一键启动入口。
 *
 * @why 这是扫描类门禁，按 §2 第 34 条**必须配自检**：扫描函数写坏后，
 *      「每份文档都合格」这条业务断言依然全绿（永远返回"不缺章节"），
 *      只有针对扫描器本身的自检会红。本文件的 describe(自检) 就是那道防线。
 *
 * @why 回调路径**不同源于代码**：stripe 说明文档里的转发路径由 `PAY_CALLBACK_PREFIX`
 *      推导（改路由前缀 → 本门禁红 → 逼文档同步），不手抄第二份。
 *
 * @see docs/templates/（三个模板）；docs/dev/stripe-listen-cloudflared.md；地基清单 F17
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAY_CALLBACK_PREFIX } from '../../server/src/app/pay-routes.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface RequiredDoc {
  path: string;
  /** 必备章节标记（子串存在性检查：有意保持宽松，钉的是"章节没被整节删掉"）。 */
  sections: string[];
}

const REQUIRED_DOCS: RequiredDoc[] = [
  {
    path: 'docs/templates/adr-template.md',
    sections: ['状态', '背景', '选项', '决定', '理由', '反向风险', '回滚'],
  },
  {
    path: 'docs/templates/unit-completion-template.md',
    sections: ['做了什么', '测了什么', '红灯证据', '门禁结果', '下一步'],
  },
  {
    path: 'docs/templates/defect-report-template.md',
    sections: ['现象', '期望', '实际', '复现', 'trace_id', '影响面', '根治'],
  },
  {
    path: 'docs/dev/stripe-listen-cloudflared.md',
    sections: ['stripe listen', 'whsec', 'cloudflared', '合法域名'],
  },
];

/** 缺哪些必备章节（全缺全报）。抽成纯函数：自检要能喂任意内容给它。 */
function missingSections(content: string, required: readonly string[]): string[] {
  return required.filter((s) => !content.includes(s));
}

function readDoc(relPath: string): string {
  return readFileSync(join(root, relPath), 'utf8');
}

describe('开发文档与模板：存在且含必备章节', () => {
  for (const doc of REQUIRED_DOCS) {
    it(`${doc.path} 章节齐备`, () => {
      const content = readDoc(doc.path);
      expect(missingSections(content, doc.sections), `${doc.path} 缺章节`).toEqual([]);
    });
  }

  it('stripe 说明里的回调转发路径与代码同源（PAY_CALLBACK_PREFIX 推导，不手抄）', () => {
    const content = readDoc('docs/dev/stripe-listen-cloudflared.md');
    expect(content).toContain(`${PAY_CALLBACK_PREFIX}/stripe`);
  });

  it('README 保留一键启动入口（F17 的验收路径不能静默消失）', () => {
    expect(readDoc('README.md')).toContain('npm run dev');
  });
});

describe('自检：扫描器本身（§2 第 34 条——业务断言全绿时唯一会红的防线）', () => {
  it('全缺必须全报（防"永远返回空"的假阴性）', () => {
    for (const doc of REQUIRED_DOCS) {
      expect(
        missingSections('', doc.sections),
        `扫描器对 ${doc.path} 的章节清单必须全缺全报`,
      ).toEqual(doc.sections);
    }
  });

  it('必备清单非空且每项都有章节（清单空 = 门禁空转）', () => {
    expect(REQUIRED_DOCS.length).toBeGreaterThanOrEqual(4);
    for (const doc of REQUIRED_DOCS) {
      expect(doc.sections.length, `${doc.path} 的必备章节清单为空`).toBeGreaterThan(0);
    }
  });

  it('被检查的每个路径都必须真实存在（防"路径拼错 → readDoc 抛错"被误读成章节缺失）', () => {
    for (const doc of REQUIRED_DOCS) {
      expect(() => readDoc(doc.path), `${doc.path} 不存在`).not.toThrow();
    }
  });
});
