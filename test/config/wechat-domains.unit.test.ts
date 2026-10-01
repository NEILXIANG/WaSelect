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
