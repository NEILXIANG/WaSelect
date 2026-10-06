/**
 * 职责：法务页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是三件**都不报错**的事：
 *      ① 链接带空白 → 用户复制走一个打不开的地址；
 *      ② 语种缺一个 / 契约新增语种 → 页面静默少一行（或显示一个空链接）；
 *      ③ 请求失败时说"暂时没有可查看的条款" → 用户读到"这家店没有条款"。
 *      三条在真机上都长得"页面正常"，只有断言能分出来。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANG_ROWS, legalState, termsView } from './index.vm.js';

const TERMS = {
  version: 'TOS-2026-09-20',
  updated_at: '2026-09-20T00:00:00Z',
  urls: {
    zh: 'https://checkout.example/privacy?lang=zh',
    ja: 'https://checkout.example/privacy?lang=ja',
    en: 'https://checkout.example/privacy?lang=en',
  },
};

describe('termsView（GET /terms → 视图）', () => {
  it('版本号与三语种链接都出来', () => {
    expect(termsView(TERMS)).toEqual({
      version: 'TOS-2026-09-20',
      hasVersion: true,
      langs: [
        { key: 'zh', label: '中文', url: 'https://checkout.example/privacy?lang=zh' },
        { key: 'ja', label: '日本語', url: 'https://checkout.example/privacy?lang=ja' },
        { key: 'en', label: 'English', url: 'https://checkout.example/privacy?lang=en' },
      ],
    });
  });

  it('⚠️ url 前后空白要 trim（复制进浏览器打不开，且不报错）', () => {
    const [zh] = termsView({ version: 'v', urls: { zh: '  https://a.example/x  ' } }).langs;
    expect(zh?.url).toBe('https://a.example/x');
  });

  it('⚠️ 语种缺失 / 空串 → 整行丢掉，不是显示一个空的"复制"', () => {
    const view = termsView({ version: 'v', urls: { zh: 'https://a.example/x', ja: '', en: '  ' } });
    expect(view.langs.map((l) => l.key)).toEqual(['zh']);
    expect(termsView({ version: 'v', urls: {} }).langs).toEqual([]);
    expect(termsView({ version: 'v' }).langs).toEqual([]);
  });

  it('⚠️ 版本号缺失 → hasVersion false，但链接照显示（版本与链接是两件事）', () => {
    const view = termsView({ urls: { zh: 'https://a.example/x' } });
    expect(view.hasVersion).toBe(false);
    expect(view.version).toBe('');
    expect(view.langs).toHaveLength(1);
  });

  it('脏输入：null / 字符串 / urls 是数组 → 不崩，给空视图', () => {
    expect(termsView(null)).toEqual({ version: '', hasVersion: false, langs: [] });
    expect(termsView('oops')).toEqual({ version: '', hasVersion: false, langs: [] });
    expect(termsView([])).toEqual({ version: '', hasVersion: false, langs: [] });
    expect(termsView({ urls: ['https://a.example/x'] })).toEqual({
      version: '',
      hasVersion: false,
      langs: [],
    });
    expect(termsView({ version: 123, urls: { zh: 42 } })).toEqual({
      version: '',
      hasVersion: false,
      langs: [],
    });
  });
});

describe('legalState（三态）', () => {
  it('⚠️ 请求失败时不说"没有条款"（用户会读成"这家店没有条款"）', () => {
    expect(legalState({ langCount: 0, error: '50003 服务异常' })).toEqual({
      showLoading: false,
      showList: false,
      showEmpty: false,
    });
  });

  it('⚠️ 加载中不算"没有"（只看 count 的表现是先闪一句"没有条款"）', () => {
    expect(legalState({ loading: true, langCount: 0 })).toEqual({
      showLoading: true,
      showList: false,
      showEmpty: false,
    });
  });

  it('拉到了但真的没有语种 → 空态', () => {
    expect(legalState({ langCount: 0 })).toEqual({
      showLoading: false,
      showList: false,
      showEmpty: true,
    });
  });

  it('有链接 → 列表；失败优先于 loading（失败后不该还在转圈）', () => {
    expect(legalState({ langCount: 3 }).showList).toBe(true);
    expect(legalState({ loading: true, langCount: 0, error: 'x' }).showLoading).toBe(false);
  });

  it('脏输入：null / 缺字段 → 不当成"有条款"（count 缺失时宁可空态也不乱显示）', () => {
    expect(legalState(null)).toEqual({ showLoading: false, showList: false, showEmpty: true });
    expect(legalState({})).toEqual({ showLoading: false, showList: false, showEmpty: true });
    expect(legalState({ langCount: '3' })).toEqual({
      showLoading: false,
      showList: false,
      showEmpty: true,
    });
  });
});

/**
 * ⚠️ 与契约的双向比对：展示的语种必须**恰好等于** `GET /terms` 里 `urls` 的键。
 * @why 契约新增一个语种而这里没跟上的表现是：法务页静默少一行，
 *      说那个语种的用户复制不到任何地址——不报错、不崩溃，只是那一部分用户没有条款可读。
 *      反向（这里多写一个键）同样是红的：多出来的那行会是一个永远拿不到 url 的空链接。
 */
describe('LANG_ROWS 与契约 /terms 的 urls 双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('urls: {type: object')) ?? '';
  const contractLangs = [...line.matchAll(/([a-z]{2}):\s*\{\s*type: string\s*\}/g)].map(
    (m) => m[1] ?? '',
  );

  it('抽到了 urls 的键（契约改写格式会失配 → 这条先红）', () => {
    expect(line).toContain('urls:');
    expect(contractLangs.length).toBeGreaterThan(0);
  });

  it('两边集合相等：契约有而页面没有 → 那个语种的用户没有条款可读', () => {
    expect(contractLangs.sort()).toEqual(LANG_ROWS.map((r) => r.key).sort());
  });

  it('每条文案非空（空串 = 真机上一个空白标签）', () => {
    for (const row of LANG_ROWS) {
      expect(row.label, `${row.key} 的文案为空`).not.toBe('');
    }
  });
});

/** 占位相对路径不能当链接给出去（W-06）：复制到浏览器打不开。 */
describe('termsView：只保留 https 绝对地址（W-06）', () => {
  it('相对路径 / http → 过滤掉；https → 保留', () => {
    const view = termsView({
      version: 'v',
      urls: { zh: '/legal/terms.zh.html', ja: 'http://a.example/x', en: 'https://a.example/en' },
    });
    expect(view.langs.map((l) => l.key)).toEqual(['en']);
  });
});
