/**
 * 职责：对已部署环境跑冒烟检查的 CLI 入口（逻辑在 ./smoke-lib.ts）。
 *
 * 用法：
 *   npm run smoke -- --base https://api.staging.example.com
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… SMOKE_ADMIN_TOTP_SECRET=… npm run smoke -- --base …
 * 退出码：全绿 0；任一条红 1；参数错 2。最后一行是结论（CI 用 `tail -1`）。
 *
 * @why 三个管理员凭据**全给才跑管理层**：给了一半（比如漏 TOTP 密钥）只会让登录必败、把"环境坏了"和"凭据没配全"混在一起。
 * @why 禁止打本机以外的 http://：冒烟是给公网环境用的，明文地址只放行本机联调（和 api-fuzz 同一口径的反向）。
 * @limitation 不重试：冒烟要的是"此刻是不是好的"；偶发网络抖动造成的红由定时任务下一次跑覆盖。
 */
import { totpAt } from '../server/src/adapters/totp.js';
import { adminChecks, formatReport, publicChecks, runChecks, type SmokeHttp } from './smoke-lib.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const base = (arg('--base') ?? process.env['SMOKE_BASE_URL'] ?? '').replace(/\/+$/, '');
if (base === '') {
  process.stderr.write('用法：npm run smoke -- --base https://<api 域名>（或设 SMOKE_BASE_URL）\n');
  process.exit(2);
}
const host = new URL(base).hostname;
if (base.startsWith('http://') && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
  process.stderr.write('拒绝：公网环境只允许 https://（口令与 token 不能走明文）\n');
  process.exit(2);
}

const http: SmokeHttp = async (method, path, opts) => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts?.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts?.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    ...(opts?.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text === '' ? {} : JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
};

const email = process.env['SMOKE_ADMIN_EMAIL'] ?? '';
const password = process.env['SMOKE_ADMIN_PASSWORD'] ?? '';
const totpSecret = process.env['SMOKE_ADMIN_TOTP_SECRET'] ?? '';
const withAdmin = email !== '' && password !== '' && totpSecret !== '';
if (!withAdmin && (email !== '' || password !== '' || totpSecret !== '')) {
  process.stderr.write(
    '管理员凭据要三项都给（SMOKE_ADMIN_EMAIL / _PASSWORD / _TOTP_SECRET），否则只跑公开层\n',
  );
}

const checks = [
  ...publicChecks(),
  ...(withAdmin
    ? adminChecks({ email, password, totpSecret }, () => totpAt(totpSecret, Date.now()))
    : []),
];
const results = await runChecks(checks, http);
process.stdout.write(formatReport(base, results) + '\n');
process.exit(results.every((r) => r.ok) ? 0 : 1);
