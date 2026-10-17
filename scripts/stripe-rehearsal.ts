/**
 * 职责：支付排练的 CLI 入口（编排在 ./stripe-rehearsal-lib.ts）。
 *
 * 用法（先 `npm run dev` 把本机服务起好）：
 *   npm run stripe:rehearsal -- --channel mock      # 不需要 Stripe 账户：验脚本与 mock 链路
 *   npm run stripe:rehearsal -- --channel stripe    # 需要 .env 里的 sk_test_ 密钥与 Stripe CLI（stripe login 过）
 * 可选：--base http://127.0.0.1:3000（默认读 .env 的 PORT）；--timeout 300（等回调的秒数）
 * 退出码：全绿 0；有失败 1；前置条件不满足 2。报告写到 var/rehearsal/<时间>.md。
 *
 * @why stripe 通道时脚本自己起 `stripe listen` 转发到本机回调入口，并核对它打印的 whsec 与服务用的是否一致：
 *      不一致时所有回调都会 40103 验签失败，表现为"付了款订单一直待付款"，新手会在这里卡很久。
 * @limitation 一：核对靠 .env 里的 STRIPE_WEBHOOK_SECRET 与 listen 输出比对——服务实际用的是启动时读到的值，
 *              改了 .env 没重启也会不一致；脚本只能提醒，判不了服务进程里的值。
 * @limitation 二：`stripe listen` 的输出措辞与 whsec 是否跨次稳定【待实测，等 Stripe 测试账户到手】。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  DEV_MOCK_CALLBACK_SECRET,
  parseWebhookSecret,
  renderReport,
  runRehearsal,
  type RehearsalHttp,
} from './stripe-rehearsal-lib.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

/** 只读 .env 里本脚本需要的几项；不解析引号与转义（本项目 .env 由 dev-up 物化，键值都是裸值）。 */
function readEnv(): Record<string, string> {
  let text = '';
  try {
    text = readFileSync('.env', 'utf8');
  } catch {
    die('没有 .env：先 npm run dev（它会从 .env.example 物化一份）');
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=([^#]*)/.exec(line);
    if (m !== null) out[m[1] ?? ''] = (m[2] ?? '').trim();
  }
  return out;
}

const channel = arg('--channel');
if (channel !== 'stripe' && channel !== 'mock') die('用法：--channel stripe|mock');
const env = readEnv();
const base = (arg('--base') ?? `http://127.0.0.1:${env['PORT'] ?? '3000'}`).replace(/\/+$/, '');
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  die('排练只打本机（它会建真实订单并退款）');
// stripe 要等人去托管页付款，默认 5 分钟；mock 没有人工步骤，回调几秒内到
const timeoutSec = Number(arg('--timeout') ?? (channel === 'mock' ? '30' : '300'));
const adminEmail = env['ADMIN_EMAIL'] ?? '';
const adminPassword = env['ADMIN_INITIAL_PASSWORD'] ?? '';
if (adminEmail === '' || adminPassword === '')
  die('.env 里要有 ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD（dev 库的管理员）');
if ((env['WECHAT_DEV_LOGIN'] ?? '') === '')
  die('.env 里要有 WECHAT_DEV_LOGIN（开发登录；npm run dev 会填）');

let listen: ChildProcess | null = null;
if (channel === 'stripe') {
  if (!(env['STRIPE_SECRET_KEY'] ?? '').startsWith('sk_test_'))
    die('STRIPE_SECRET_KEY 必须是测试密钥（sk_test_…）：排练只用假钱');
  if (spawnSync('stripe', ['--version'], { encoding: 'utf8' }).status !== 0) {
    die(
      '没装 Stripe CLI：见 https://docs.stripe.com/stripe-cli（macOS 可下载官方二进制放进 PATH），装好后 `stripe login`',
    );
  }
  listen = spawn('stripe', ['listen', '--forward-to', `${base}/api/v1/pay/callback/stripe`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const secret = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('stripe listen 20 秒内没打印签名密钥（先 stripe login？）')),
      20_000,
    );
    const onLine = (line: string) => {
      const s = parseWebhookSecret(line);
      if (s !== null) {
        clearTimeout(timer);
        resolve(s);
      }
    };
    createInterface({ input: listen!.stdout! }).on('line', onLine);
    createInterface({ input: listen!.stderr! }).on('line', onLine);
    listen!.on('exit', (code) => reject(new Error(`stripe listen 退出（${String(code)}）`)));
  }).catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
  if (secret !== env['STRIPE_WEBHOOK_SECRET']) {
    listen.kill();
    die(
      `stripe listen 的签名密钥是 ${secret}，与 .env 的 STRIPE_WEBHOOK_SECRET 不同：把它填进 .env 后重启 npm run dev 再来`,
    );
  }
  process.stdout.write(`stripe listen 已转发到 ${base}/api/v1/pay/callback/stripe\n`);
}

const http: RehearsalHttp = async (method, path, opts) => {
  const headers: Record<string, string> = { accept: 'application/json', ...(opts?.headers ?? {}) };
  if (opts?.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts?.body !== undefined && headers['content-type'] === undefined)
    headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    ...(opts?.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    ...(opts?.redirect === 'manual' ? { redirect: 'manual' as const } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text === '' ? {} : JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
  return { status: res.status, json, headers: h };
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = (message: string): Promise<void> =>
  new Promise((resolve) => rl.question(`\n${message}\n付完后按回车继续… `, () => resolve()));

const startedAt = new Date().toISOString();
const steps = await runRehearsal(
  {
    http,
    prompt,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (l) => process.stdout.write(`${l}\n`),
  },
  {
    channel,
    buyerCode: `rehearsal-${String(Date.now())}`,
    admin: { email: adminEmail, password: adminPassword },
    mockCallbackSecret:
      env['MOCK_CALLBACK_SECRET'] === '' || env['MOCK_CALLBACK_SECRET'] === undefined
        ? DEV_MOCK_CALLBACK_SECRET
        : env['MOCK_CALLBACK_SECRET'],
    pollIntervalMs: 2000,
    pollTimeoutMs: timeoutSec * 1000,
  },
);
rl.close();
listen?.kill();

mkdirSync('var/rehearsal', { recursive: true });
const file = `var/rehearsal/${startedAt.replace(/[:.]/g, '-')}-${channel}.md`;
writeFileSync(file, renderReport({ channel, startedAt, baseUrl: base }, steps));
const failed = steps.filter((s) => !s.ok).length;
process.stdout.write(
  `${failed === 0 ? `rehearsal ok: ${String(steps.length)} steps` : `rehearsal FAILED: ${String(failed)} of ${String(steps.length)} steps`} → ${file}\n`,
);
process.exit(failed === 0 ? 0 : 1);
