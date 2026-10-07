/**
 * 职责：小程序环境配置的单测（B4）——`resolveApiBase` 的三档选择 + 未配置时必须响亮失败。
 *
 * @why 这一段错了的三种形态全部**不报错**，只会静默打到一个错误的地址：
 *      ① 正式版取到 develop 的地址 → 全站请求失败，而开发者工具里永远是对的
 *         （"我这儿是好的"是最难排查的一类线上问题）；
 *      ② 域名没配却静默回落到 localhost → 同上，且排障方向被带到"网络/证书"；
 *      ③ 配成了 http 或带了路径 → 前者被 WebView 拦、后者拼出双前缀，都只在真机可见。
 *      所以这里既测"选得对"，也测"没配会抛"。
 *
 * @limitation 测的是**选择逻辑与形状**，测不了"域名在微信后台登记过没有"——
 *              那一步是 B5 的清单与真机验收的事（@see deploy/wechat-domains.json）。
 */
import { describe, expect, it } from 'vitest';
import { API_BASES, DEVELOP_DEVICE_API_BASE, resolveApiBase } from './config.js';

describe('resolveApiBase：按 envVersion 选地址', () => {
  it('develop → localhost（开发者工具勾"不校验合法域名"后可用）', () => {
    expect(resolveApiBase('develop')).toBe(API_BASES.develop);
    expect(resolveApiBase('develop')).toContain('localhost');
  });

  /**
   * @why 未知/缺失一律回落 **develop** 而不是 release（@see config.js @limitation 三）：
   *      回落成 localhost 的表现是"请求全失败"（响亮）；回落成 release 的表现是
   *      "开发/体验版打到了生产库"（静默写坏数据）。这条断言把**方向**钉死，
   *      因为把 `key` 的兜底值从 'develop' 改成 'release' 是一个字符的改动，
   *      而后果是完全不同的两类事故。
   */
  it('envVersion 未知 / 缺失 → 回落 develop（不是 release：宁可全站失败，不能打到生产库）', () => {
    for (const unknown of [undefined, '', 'gray', 'RELEASE', 'unknown-env']) {
      expect(resolveApiBase(unknown), `envVersion=${String(unknown)} 应回落 develop`).toBe(
        API_BASES.develop,
      );
    }
  });

  /**
   * @why trial / release 目前是空串（域名待 B9）。空串必须**抛**而不是回落到 localhost：
   *      回到 localhost 的表现是"体验版/正式版全站请求失败"，排障方向会被带到网络与证书，
   *      而真正的病因只是"这一项还没填"。抛出来的错误信息直接点名是哪一个键。
   */
  it('trial / release 未配置 → 抛且点名是哪个键（不静默回落 localhost）', () => {
    expect(() => resolveApiBase('trial')).toThrow(/api_base_not_configured:trial/);
    expect(() => resolveApiBase('release')).toThrow(/api_base_not_configured:release/);
  });
});

describe('API_BASES 的形状（填了就必须填对）', () => {
  /**
   * @why 这是**唯一**一道能在"域名填错"时红的闸：填成 `http://`（小程序要求 https）、
   *      填成带路径的（`https://api.example.com/v2` → 拼出 `/v2/api/v1/…` 双前缀）、
   *      或者忘改 `example.com` 占位——三种都在真机才暴露，且都不报"地址错了"。
   *      ⚠️ 目前 trial / release 是空串（待 B9），空串**刻意放行**（那是"还没定"，不是"定错了"）。
   */
  it('非空的非 develop 项必须是 https 公网地址，且不带路径', () => {
    for (const [key, value] of Object.entries(API_BASES)) {
      if (key === 'develop') continue; // 开发者工具走 http + localhost，是唯一例外
      if (value === '') continue; // 待 B9 定域名（config.js @limitation 一）
      expect(value, `API_BASES.${key} 必须是 https://host 形式`).toMatch(/^https:\/\/[^/]+$/);
      expect(value).not.toMatch(/example\.com/); // 占位域名不许提交上去
    }
  });

  it('develop 是 http + localhost（唯一不需要在微信后台登记的域名）', () => {
    expect(API_BASES.develop).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/);
  });
});

/**
 * P2-33：开发版在**真机预览**里也是 envVersion=develop，原来一律给 localhost——
 * 手机上的 localhost 是手机自己，每个请求都 `request:fail`，页面说"网络不太稳定"，
 * 排障方向被带到网络上。真机（platform 不是 devtools）且没配局域网地址时，按"没配地址"处理（-2 那条说明）。
 */
describe('resolveApiBase：开发版区分模拟器与真机（P2-33）', () => {
  it('开发者工具（platform=devtools）→ localhost，模拟器照旧可用', () => {
    expect(resolveApiBase('develop', 'devtools')).toBe(API_BASES.develop);
  });

  it('🔴 真机预览（ios / android / ohos …）且没配局域网地址 → 抛 develop-device 未配置（不给 localhost）', () => {
    if (DEVELOP_DEVICE_API_BASE !== '') return; // 配了就走下一条
    for (const platform of ['ios', 'android', 'ohos', 'windows', 'mac']) {
      expect(() => resolveApiBase('develop', platform), platform).toThrow(
        /api_base_not_configured:develop-device/,
      );
    }
    // envVersion 认不出时按 develop 处理，真机同样不给 localhost
    expect(() => resolveApiBase(undefined, 'ios')).toThrow(/develop-device/);
  });

  it('拿不到 platform（宿主过旧 / 单测不传）→ 保持原行为（localhost）', () => {
    expect(resolveApiBase('develop', undefined)).toBe(API_BASES.develop);
    expect(resolveApiBase('develop', '')).toBe(API_BASES.develop);
  });

  it('体验版 / 正式版不看 platform（仍按各自的地址，没配就抛各自的键）', () => {
    expect(() => resolveApiBase('trial', 'ios')).toThrow(/api_base_not_configured:trial/);
    expect(() => resolveApiBase('release', 'devtools')).toThrow(/api_base_not_configured:release/);
  });

  it('DEVELOP_DEVICE_API_BASE 填了就必须是 http(s)://主机[:端口]，不带路径、不是 localhost', () => {
    if (DEVELOP_DEVICE_API_BASE === '') return;
    expect(DEVELOP_DEVICE_API_BASE).toMatch(/^https?:\/\/[^/]+$/);
    expect(DEVELOP_DEVICE_API_BASE).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});
