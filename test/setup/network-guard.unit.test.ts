/**
 * 职责：外网闸门**自己**的用例（F12）——闸门坏了必须比"有人偷偷出网"更早被发现。
 *
 * @why 这条是《地基搭建清单》F12 验收标准里最硬的一条："测试环境任何未被拦截的
 *      外网请求直接报错"。而闸门本身是**测试基础设施**，它失效时表现为
 *      "一切照常绿灯"——所以必须有用例盯住它，且必须包含"真的会抛"这一条断言。
 *
 * @limitation 本文件只验闸门的**判定逻辑与安装**，不出网（出网正是它要禁止的事）。
 */
import { describe, expect, it } from 'vitest';
import { allowOutbound, installNetworkGuard, isOutboundAllowed } from './network-guard.js';

describe('外网闸门（禁止测试环境真实出网）', () => {
  it('闸门确实由 **setupFiles** 装上（不依赖本文件 import 的副作用）', () => {
    /**
     * @why 这条是整个闸门的"门禁的门禁"。
     *      曾经踩过一次：模块底部自安装时，这个测试**永远绿**——
     *      因为本文件自己 import 了它。而其它测试文件其实压根没装闸门。
     *      现在断言的是 `globalThis` 上的安装标记：只有 setupFiles 真的跑了它才会是 true。
     */
    const s = (globalThis as unknown as Record<symbol, { installed?: boolean } | undefined>)[
      Symbol.for('waselect.network-guard')
    ];
    expect(s?.installed, 'setupFiles 没生效：闸门没装上，所有"禁止出网"的保证都不成立').toBe(true);
  });

  it('🔒 未放行的外网 URL → 直接抛错（不是尝试连接后失败）', async () => {
    await expect(fetch('https://example.com/whatever')).rejects.toThrow(/禁止真实外网请求/);
  });

  it('本机一律放行（端到端要真起端口，闸门只拦第三方）', () => {
    expect(isOutboundAllowed('http://127.0.0.1:54321/healthz')).toBe(true);
    expect(isOutboundAllowed('http://localhost:3000/api/v1/x')).toBe(true);
    expect(isOutboundAllowed('http://[::1]:8080/')).toBe(true);
  });

  it('第三方默认**不放行**', () => {
    expect(isOutboundAllowed('https://api.stripe.com/v1/checkout/sessions')).toBe(false);
  });

  it('allowOutbound 之后放行，且**必须写理由**（否则白名单会变成随手加）', () => {
    expect(() => allowOutbound('https://api.stripe.test', '   ')).toThrow(/理由/);
    allowOutbound('https://api.stripe.test', '本用例要验证真实握手（示例理由）');
    expect(isOutboundAllowed('https://api.stripe.test/v1/x')).toBe(true);
  });

  it('重复安装是幂等的（setupFiles 可能被调用多次）', () => {
    installNetworkGuard();
    installNetworkGuard();
    // 幂等的表现：闸门仍然生效（没有被自己套娃替换成"放行一切"）
    expect(isOutboundAllowed('https://example.com')).toBe(false);
  });
});
