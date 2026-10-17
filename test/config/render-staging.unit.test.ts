/**
 * 职责：`render.staging.yaml` 的守卫——键名认得、密钥不进仓库、名字不与生产撞车、staging 的闸门前提成立。
 *
 * @why 与 render-env.unit.test.ts 守 render.yaml 同一类失效，但这份清单有两处额外的坑：
 *      ① 名字撞车：Render 对"同名服务"是把清单套用到已有服务上，staging 清单一旦用了生产的名字，
 *         首次创建 Blueprint 就会去改生产服务；
 *      ② 值不同：staging 是"公网可达环境"，config.ts 会拒启动的组合（mock 通道、开发登录、自动确认）不能出现在清单里。
 * @how 用 js-yaml 解析（它是 devDependency），不复用 render-env 那份手写行解析器——这里要看嵌套的 fromDatabase / generateValue。
 * @limitation 只比对键名与结构，不判断取值是否合理（plan 档位、URL 是否真的可达是人的判断）。
 * @see ../../render.staging.yaml；docs/操作手册-staging搭建与小程序真机-新手版.md
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, REQUIRED_ENV_KEYS, SECRET_KEYS } from '../../server/src/config.js';

// 与 test/helpers/contract-schema.ts 同一种取法：js-yaml 没有类型声明，CJS 取用最省事
const { load: yamlLoad } = createRequire(import.meta.url)('js-yaml') as {
  load: (s: string) => unknown;
};
const root = resolve(import.meta.dirname, '../..');

interface EnvVar {
  key: string;
  value?: unknown;
  sync?: boolean;
  generateValue?: boolean;
  fromDatabase?: { name: string; property: string };
  fromService?: { name: string };
}
interface Service {
  type: string;
  name: string;
  runtime?: string;
  region?: string;
  plan?: string;
  envVars?: EnvVar[];
}
interface Blueprint {
  services: Service[];
  databases: { name: string; region: string; plan: string; databaseName: string }[];
}

const load = (file: string): Blueprint =>
  yamlLoad(readFileSync(resolve(root, file), 'utf8')) as Blueprint;
const staging = load('render.staging.yaml');
const prod = load('render.yaml');
const api = staging.services.find((s) => s.name === 'waselect-staging-api');
const envOf = (s: Service | undefined): Map<string, EnvVar> =>
  new Map((s?.envVars ?? []).map((e) => [e.key, e]));

/** 平台 / 构建期专用变量（不进应用 schema）。每条必须写原因。 */
const PLATFORM_KEYS: Readonly<Record<string, string>> = {
  NODE_VERSION: 'Render 运行时版本开关，平台自己读',
  DAILY_JOB_TARGET: 'cron 专用：fromService 注入的内网地址，只给 startCommand 用',
  DEPLOY_TARGET: 'admin-web 构建闸门开关（scripts/assert-admin-deploy-env.ts）',
  VITE_API_BASE_URL: 'admin-web 构建期变量（Vite 只注入 VITE_ 前缀），不进服务端 schema',
};

describe('render.staging.yaml', () => {
  it('🔴 所有服务 / 数据库的名字都以 waselect-staging- 开头，且与 render.yaml 一个都不重名', () => {
    const names = [...staging.services.map((s) => s.name), ...staging.databases.map((d) => d.name)];
    for (const n of names) expect(n.startsWith('waselect-staging-'), n).toBe(true);
    const prodNames = new Set([
      ...prod.services.map((s) => s.name),
      ...prod.databases.map((d) => d.name),
    ]);
    expect(names.filter((n) => prodNames.has(n))).toEqual([]);
  });

  it('🔴 每个变量键名要么是应用认得的配置键，要么在平台白名单里（拼错的键会被 zod 静默忽略）', () => {
    const known = new Set<string>([...CONFIG_KEYS, ...Object.keys(PLATFORM_KEYS)]);
    const unknown = staging.services
      .flatMap((s) => (s.envVars ?? []).map((e) => e.key))
      .filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it('🔴 密钥类变量绝不带字面量 value（只能 sync:false / generateValue / fromService）', () => {
    const leaked = staging.services
      .flatMap((s) => s.envVars ?? [])
      .filter((e) => (SECRET_KEYS as readonly string[]).includes(e.key) && e.value !== undefined)
      .map((e) => e.key);
    expect(leaked).toEqual([]);
    // 兜底：任何字面量值长得像 Stripe 密钥 / webhook 密钥，都不许进仓库
    const text = readFileSync(resolve(root, 'render.staging.yaml'), 'utf8');
    expect(/sk_(test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(text)).toBe(false);
  });

  it('🔴 API 服务的环境：NODE_ENV=staging；通道不含 mock；不出现开发登录 / 自动确认 / mock 密钥（公网环境会被 config 拒启）', () => {
    const env = envOf(api);
    expect(env.get('NODE_ENV')?.value).toBe('staging');
    expect(String(env.get('PAYMENT_CHANNELS')?.value)).not.toContain('mock');
    for (const k of ['WECHAT_DEV_LOGIN', 'MOCK_AUTO_CONFIRM', 'MOCK_CALLBACK_SECRET'])
      expect(env.has(k), k).toBe(false);
  });

  it('🔴 API 服务声明了全部"无默认值就必填"的键（漏配的表现是部署后启动失败）', () => {
    const declared = envOf(api);
    const missing = (REQUIRED_ENV_KEYS as readonly string[]).filter((k) => !declared.has(k));
    expect(missing).toEqual([]);
  });

  it('🔴 数据库引用对得上；库名不带 prod 也不是本机开发库名；cron 与 web 同区（私网只在同区可达）', () => {
    const dbNames = new Set(staging.databases.map((d) => d.name));
    const ref = envOf(api).get('DATABASE_URL')?.fromDatabase?.name;
    expect(ref !== undefined && dbNames.has(ref)).toBe(true);
    for (const d of staging.databases) {
      expect(d.databaseName).not.toMatch(/prod/);
      expect(d.databaseName).not.toBe('japan_shop');
      expect(d.plan).not.toBe('free');
    }
    const regions = new Set(
      staging.services.filter((s) => s.runtime !== 'static').map((s) => s.region),
    );
    expect(regions.size).toBe(1);
  });

  it('🔴 三个互相引用的 URL 同源一致：CORS_ORIGINS = 管理端静态站、管理端的 VITE_API_BASE_URL = PUBLIC_API_BASE', () => {
    const admin = staging.services.find((s) => s.name === 'waselect-staging-admin');
    const apiEnv = envOf(api);
    const adminEnv = envOf(admin);
    expect(apiEnv.get('CORS_ORIGINS')?.value).toBe(`https://${admin?.name}.onrender.com`);
    expect(adminEnv.get('VITE_API_BASE_URL')?.value).toBe(apiEnv.get('PUBLIC_API_BASE')?.value);
    expect(apiEnv.get('PUBLIC_API_BASE')?.value).toBe(`https://${api?.name}.onrender.com`);
  });
});
