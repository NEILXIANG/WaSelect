/**
 * 职责：小程序「服务器域名」登记清单 ↔ `API_BASES` 的**对账**（B5）。
 *
 * @why 微信后台的合法域名**每月只能改 5 次**，而这个限制没有对应的技术闸门：
 *      代码里换了 API 域名、后台没登记（或反过来），表现是"真机上请求全部失败"，
 *      而开发者工具因为勾了"不校验合法域名"永远是好的——
 *      典型的"我这儿是好的"线上问题，且排障方向会被带到网络/证书/跨域。
 *      两份各写一份必然漂移（ADR-29），所以像 B3 那样在仓库里放一份清单并让测试对账。
 *
 * @limitation 它只能保证"仓库里这份清单与代码一致"，**保证不了微信后台真的照它填了**
 *      ——那一步只能在真机上验（开发版关掉"不校验合法域名"跑一遍）。
 *
 * @see ../../deploy/wechat-domains.json；../../miniprogram/config.js
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_BASES } from '../../miniprogram/config.js';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'deploy/wechat-domains.json'), 'utf8')) as {
  request: string[];
  uploadFile: string[];
  downloadFile: string[];
  socket: string[];
};

/** `https://api.example.com` → `api.example.com`（后台登记的是 host，不带协议）。 */
function hostOf(base: string): string {
  return base.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/**
 * B9 闸门（AJ-375）：清单"填了一半"的问题列表。
 * @see 下方 `🔴 填了一半必须红` 用例的 @why / @limitation（为何只强制 downloadFile、为何不强制同源）
 */
function halfFilledIssues(m: { request: string[]; downloadFile: string[] }): string[] {
  const issues: string[] = [];
  if (m.request.length > 0 && m.downloadFile.length === 0) {
    issues.push(
      'request 已登记但 downloadFile 是空的：小程序商品图（<image>）全部加载失败且不报错；' +
        '补登记还要再花一次「每月 5 次」的额度，而两次登记之间线上一直是坏的',
    );
  }
  return issues;
}

describe('小程序合法域名清单（B5）', () => {
  it('四类字段都在（缺一类 = 提交时才发现漏了，白花一次修改次数）', () => {
    for (const key of ['request', 'uploadFile', 'downloadFile', 'socket']) {
      expect(Array.isArray(manifest[key as keyof typeof manifest]), `${key} 必须是数组`).toBe(true);
    }
  });

  /**
   * @why 这是本文件的核心：代码里的 API 域名**必须**出现在登记清单里。
   *      域名一旦定了（`API_BASES.trial` / `release` 填上），这里没同步就红——
   *      换来的不是"少一次手误"，而是"提审前必然被发现"，
   *      因为改域名本来就是一件要动两处、而第二处极其容易忘的事。
   *      ⚠️ 目前两项是空串（待 B9 定域名），空串刻意放行——那是"还没定"，不是"定错了"。
   */
  it('代码里配了的非开发域名，都必须出现在 request 清单里（换域名而后台没登记 → 真机全挂）', () => {
    for (const key of ['trial', 'release'] as const) {
      const base = API_BASES[key];
      if (base === '') continue; // 待 B9 定域名（miniprogram/config.js @limitation 一）
      const host = hostOf(base);
      expect(manifest.request, `API_BASES.${key} 的 ${host} 还没登记到 request 清单`).toContain(
        host,
      );
    }
  });

  /**
   * 🔴 B9 闸门（AJ-375）：**填了一半**必须红。
   *
   * @why 微信后台四类域名共用一个"每月 5 次"的额度，本文件自己的 constraints 就写着
   *      「必须一次想全、一次填完」。但现存闸门只查**格式**（每项是不是合法 host、
   *      有没有误抄 localhost），**不查"填了一半"**——而"填了一半"恰恰是最贵的那一种：
   *      ① 商品图走 `downloadFile`：漏登记的表现是小程序 `<image>` **全部不显示**，
   *         既不报错也不占位，页面上一片空白，排障方向会被带到"图片没上传"；
   *      ② 要补登记得再花**一次额度**，而两次登记之间线上一直是坏的
   *         （改域名后还需重新打包才生效，已发布版本用旧配置）。
   *      所以闸门必须在"request 已登记"的那一刻就要求 downloadFile 同时登记。
   *
   * @why 只对 `downloadFile` 强制，`uploadFile` / `socket` **不强制**：
   *      本文件的 notes 已写明这两类**刻意留空**（小程序端不直传图片、不用 WebSocket）。
   *      把它们一起强制等于逼人去填两栏本来就不需要的东西，闸门会立刻被人绕开。
   *
   * @limitation 不要求 `downloadFile` 与 `request` **同 eTLD+1**：图片走 R2 自定义域，
   *      将来换独立 CDN 域名是显式决定，不是遗漏——强制同源会误红，误红的成本是让人改一行配置、
   *      进而开始怀疑整份清单。**这里守的是"完全没登记"（静默全挂），不是"登记了别的域"。**
   *
   * @how 做成纯函数而不是"直接断言当前文件"：当前 `request` 与 `downloadFile` **都是空的**
   *      （B9 还没定域名），直接断言会让这条用例在域名定下来之前**永远绿**——
   *      那正是本轮要消灭的那类假守卫。抽成函数后可以对样本清单做**自检**，
   *      证明它在"填了一半"时确实会红（下面两条自检）。
   */
  it('🔴 填了一半必须红：request 已登记时 downloadFile 不得为空（商品图全不显示且不报错）', () => {
    expect(
      halfFilledIssues(manifest),
      'request 已登记却没登记 downloadFile：小程序商品图全部加载失败且不报错，' +
        '补登记还要再花一次「每月 5 次」里的额度',
    ).toEqual([]);
  });

  it('自检：request 填了、downloadFile 空 → 闸门必须报（防"域名定下来之前永远绿"）', () => {
    const issues = halfFilledIssues({ request: ['api.waselect.jp'], downloadFile: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('downloadFile');
  });

  it('自检：两类都空（B9 未定）→ 放行（"还没定"不是"定错了"，闸门不该逼人先填假值）', () => {
    expect(halfFilledIssues({ request: [], downloadFile: [] })).toEqual([]);
  });

  it('自检：两类都填齐 → 放行（正常形态不能被自己的闸门拦住）', () => {
    expect(
      halfFilledIssues({ request: ['api.waselect.jp'], downloadFile: ['img.waselect.jp'] }),
    ).toEqual([]);
  });

  it('登记进清单的域名必须是 host 形式（不带协议/路径/端口——后台不收）', () => {
    for (const key of ['request', 'uploadFile', 'downloadFile', 'socket'] as const) {
      for (const domain of manifest[key]) {
        expect(domain, `${key} 里的 ${domain} 不是合法 host`).toMatch(/^[a-z0-9.-]+$/);
        expect(domain.startsWith('http'), `${key} 里的 ${domain} 不该带协议`).toBe(false);
      }
    }
  });

  /**
   * @why localhost / 127.0.0.1 登记不上去（微信后台直接拒绝），
   *      而它出现在清单里的唯一可能是有人把 develop 的地址抄了过来——
   *      那会让人误以为"开发版也需要登记"，进而怀疑配置、白花一次修改次数。
   */
  it('清单里不得出现 localhost / 回环地址（开发版靠开发者工具「不校验合法域名」）', () => {
    for (const key of ['request', 'uploadFile', 'downloadFile', 'socket'] as const) {
      for (const domain of manifest[key]) {
        expect(domain).not.toMatch(/^(localhost|127\.0\.0\.1|0\.0\.0\.0)/);
      }
    }
  });
});
