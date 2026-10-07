/**
 * 职责：`isPlaceholderHost` 的边界表（B9 闸门，AJ-375）。
 *
 * @why 这个函数被**两处**消费（服务端 `config.ts` 规则 4c 的启动期校验、
 *      `scripts/checkout-build-lib.ts` 的构建期校验），所以它自己必须是硬的：
 *      误绿 = 一次静默的线上故障，误红 = 让人改一行配置甚至开始怀疑整份清单。
 *      两侧都要钉，尤其**放行侧**——少了放行侧就会出现"宁可全拒"的过严实现。
 *
 * @see ../src/reserved-domains.ts（判据来源与 RFC 依据写在那里）
 */
import { describe, expect, it } from 'vitest';
import { isPlaceholderHost } from './reserved-domains.js';

describe('isPlaceholderHost：保留/占位域名（B9 闸门）', () => {
  /** 应当拒绝：RFC 2606 / 6761 / 6762、ICANN 2024 与回环。 */
  const PLACEHOLDER: ReadonlyArray<[string, string]> = [
    ['example.com', 'RFC 2606'],
    ['img.example.com', 'RFC 2606 子域'],
    ['example.org', 'RFC 2606'],
    ['example.net', 'RFC 2606'],
    ['example.edu', 'IANA 示例域族'],
    ['pay.test', 'RFC 6761'],
    ['pay.invalid', 'RFC 6761'],
    ['pay.localhost', 'RFC 6761'],
    ['pay.local', 'RFC 6762（mDNS）'],
    ['pay.internal', 'ICANN 2024'],
    ['localhost', '回环主机名'],
    ['127.0.0.1', 'IPv4 回环'],
    ['127.1.2.3', 'IPv4 回环整段'],
    ['[::1]', 'IPv6 回环'],
    ['::1', 'IPv6 回环（不带方括号）'],
    ['::', 'IPv6 任意地址'],
    ['0.0.0.0', 'IPv4 任意地址'],
    // 工程缺口第二轮复核 F3：URL 的 hostname 会保留结尾的点（FQDN 写法），精确匹配与后缀匹配都判不中
    ['img.example.com.', '结尾带点的 FQDN 写法'],
    ['localhost.', '结尾带点的回环主机名'],
  ];

  for (const [host, why] of PLACEHOLDER) {
    it(`🔴 ${host} → 占位（${why}）`, () => {
      expect(isPlaceholderHost(host)).toBe(true);
      // 大小写不敏感：配置里写大写同样是占位
      expect(isPlaceholderHost(host.toUpperCase())).toBe(true);
    });
  }

  /**
   * 应当放行：这一组比上面更重要。**近似占位域的真实域名被拒**是最难发现的一类误伤，
   * 因为配置者会真的去改一个本来正确的域名，进而怀疑整份清单。
   */
  const REAL: ReadonlyArray<[string, string]> = [
    ['waselect.jp', '真实域名'],
    ['img.waselect.jp', '真实子域'],
    ['example.com.cn', 'eTLD+1 是 example.com.cn，可注册'],
    ['notexample.com', '前缀含 example 但可注册（不能按子串匹配）'],
    ['myexample.com', '同上'],
    ['example-jp.com', '同上'],
    ['img.example.commerce.jp', '多级真实域名'],
  ];

  for (const [host, why] of REAL) {
    it(`放行：${host}（${why}）`, () => {
      expect(isPlaceholderHost(host)).toBe(false);
    });
  }
});
