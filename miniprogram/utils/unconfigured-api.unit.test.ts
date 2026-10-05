/**
 * 职责：`utils/unconfigured-api.js`（未配置服务地址时的替身请求器）的用例。
 *
 * @why 这条端到端的后果里有**两个独立故障点**，必须分开钉：
 *      ① 替身本身是不是"必然失败且原因可读"；
 *      ② `app.js` 有没有真的把它接上（缺了它 `globalData.api` 就是 `null`，
 *         页面崩在 TypeError 上）。前者是单元行为，后者是**跨文件约定**——
 *         约定只能由扫描型守卫守（与 `page-button-guard` / `nav-param-guard` 同一口径）。
 *
 * @measured 2026-10-05（AJ-364）：把 app.js 的接线删掉（回到裸 `resolveApiBase`）
 *          之后，第 4 条立刻变红；还原后转绿。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNCONFIGURED_CODE, createUnconfiguredApi } from './unconfigured-api.js';

const MP_DIR = join(resolve(import.meta.dirname, '..'));
const REASON = 'api_base_not_configured:release——API_BASES.release 是空的';

/**
 * 取 reject 出来的那个值；**若它 resolve 了就炸**。
 *
 * @why 不用 `.catch((e) => { …断言… })` 那种写法：它在"根本没 reject"时**什么都不执行**，
 *      用例照样绿——这正是本项目栽过的同款假绿灯（§2 第 8 条）。
 *      这里把"必须 reject"变成前提，替身一退化成立即成功就第一时间红。
 */
function rejected(p: Promise<unknown>): Promise<Record<string, unknown>> {
  return p.then(
    () => {
      throw new Error('本应 reject，实际 resolve 了');
    },
    (e: unknown) => e as Record<string, unknown>,
  );
}

describe('createUnconfiguredApi（未配置服务地址时的替身请求器）', () => {
  it('🔴 每次调用都 reject，且原因是 ApiError(-2) + 原始 message', async () => {
    const api = createUnconfiguredApi(REASON);
    // ⚠️ 断言 `rejects.` 而不是 try/catch：前者在"没有 reject、直接返回了 undefined"时会红，
    //    后者写成 `catch(e)` 却什么都不断言时会假绿。
    await expect(api({ url: '/api/v1/products' })).rejects.toMatchObject({
      code: UNCONFIGURED_CODE,
      message: REASON,
    });
  });

  it('错误形状与 ApiError 一致（页面按 code + message 读取）', async () => {
    const api = createUnconfiguredApi(REASON);
    const e = await rejected(api({}));
    expect(e.name).toBe('ApiError');
    expect(typeof e.code).toBe('number');
    expect(typeof e.message).toBe('string');
  });

  it('🔴 不看参数、也不重放：任意参数都是同一个失败（区别于真请求器）', async () => {
    const api = createUnconfiguredApi(REASON);
    const a = await rejected(api({ method: 'POST', idempotencyKey: 'k', traceId: 't' }));
    const b = await rejected(api({ url: '/x' }));
    expect(a.message).toBe(REASON);
    expect(b.message).toBe(REASON);
  });

  it('🔴 负数码不与任何服务端业务码撞（服务端全是 5 位正数）', () => {
    expect(UNCONFIGURED_CODE).toBeLessThan(0);
    expect(Math.abs(UNCONFIGURED_CODE)).toBeLessThan(10000);
  });

  it('reason 是空串时给兜底文案，不清空错误提示', async () => {
    const api = createUnconfiguredApi('');
    const e = await rejected(api({}));
    expect(e.code).toBe(UNCONFIGURED_CODE);
    expect(e.message).not.toBe('');
  });
});

describe('守卫：app.js 必须真的接住缺配置的失败', () => {
  it('🔴 app.js 出现 try 包住 resolveApiBase，并把它交给 createUnconfiguredApi', () => {
    const src = readFileSync(join(MP_DIR, 'app.js'), 'utf8');
    // ⚠️ 形态级正则不是 AST（与 vm-guard 同口径）：真实威胁是"顺手改回去"，扫得到。
    expect(src).toMatch(/try\s*\{[\s\S]*?resolveApiBase\(/);
    // ⚠️ 断言带**左括号**的用法，不是只断言名字：只有 `import { createUnconfiguredApi }`
    //    而没有被调用时，不带括号的断言照样全绿（本次注入实测出来的盲区）。
    expect(src).toContain('createUnconfiguredApi(');
    // ⚠️ 第三条只是"这段赋值还在"，不是断言替身被用上：
    //    上面第二条（`toContain('createUnconfiguredApi')`）已经保证它出现在 app.js 里。
    expect(src).toMatch(/globalData\.api\s*=/);
  });
});
