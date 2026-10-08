// 契约驱动的自动异常模拟 —— 回答「怎样更快更全面地发现问题」
//
// 用法：node api-fuzz.mjs                 # 默认**只读**：只探 GET 接口 + 不写库的协议层畸形
//       node api-fuzz.mjs --allow-writes  # 连写接口一起探（会真的改库，只对模拟库 / 一次性库用）
//       API_FUZZ_BASE=http://127.0.0.1:3001 node api-fuzz.mjs   # 换目标（只允许本机）
// 前提：server 已在 BASE 运行，且 contracts/api-contract.yaml 存在
//
// ⚠️ 写接口为什么默认不跑（批次复审发现）：变异里有一部分本身就是**合法请求**
//    （「多余字段」= 合法基线 + 两个会被 zod 剥掉的键；「零」「浮点」在不少字段上也合法），
//    初版拿订单列表第一张真单当路径参数，跑一遍就会把它发货 / 退款 / 取消、打开售卖暂停、覆盖运费表。
//    --allow-writes 下带 id 的写路由改用**不存在的 id**：body 校验先于取单，仍能探到 400 一侧；
//    不带 id 的写接口（运费表、售卖暂停、新建商品 / Banner）仍会生效——所以开关必须显式给。
//
// 与手写探针的区别（也是「为什么更全」）：
//   1. 端点、必填字段、maxLength、enum、minimum 全部从 contracts/api-contract.yaml 读出，
//      不依赖人手列清单 —— 契约加一个接口，这里自动多覆盖一个，不会漏。
//   2. 每个必填字段自动生成「缺失 / 超长 / 空串 / 错型 / 越界」五种变异。
//   3. 每个响应都校验：实际状态码 ∈ 契约声明集合（抓契约漂移）、
//      非 2xx 必须是 {code,message} 且不含内部堆栈、2xx 必须含契约声明的 required 键。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const BASE = process.env.API_FUZZ_BASE ?? 'http://127.0.0.1:3000';
const ALLOW_WRITES = process.argv.includes('--allow-writes');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.error('拒绝：只允许打本机（' + BASE + '）。这个脚本会发大量畸形与（可选）写请求。');
  process.exit(1);
}
const PREFIX = '/api/v1';
const EMAIL = 'dev@waselect.test';
const PASS = 'dev-Local-Admin-2026';

const CONTRACT = path.join(root, 'contracts', 'api-contract.yaml');
if (!fs.existsSync(CONTRACT)) {
  console.error('找不到契约文件：' + CONTRACT);
  process.exit(1);
}
const spec = yaml.load(fs.readFileSync(CONTRACT, 'utf8'));

// ── HTTP ────────────────────────────────────────────────
function req(method, urlPath, body, token) {
  return new Promise((resolve) => {
    const u = new URL(BASE + urlPath);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    if (data !== null) headers['content-length'] = Buffer.byteLength(data);
    const r = http.request(u, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, ct: String(res.headers['content-type'] || ''), body: d }),
      );
    });
    r.on('error', (e) => resolve({ status: 0, ct: '', body: String(e.message) }));
    if (data !== null) r.write(data);
    r.end();
  });
}
const jparse = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
};

/**
 * 响应体里不该出现的「内部实现泄漏」形状。
 * ⚠️ 声明位置必须在 {@link check} 与自检之前：`const` 有 TDZ，
 *    放在函数之后会在自检（--selftest）里抛 "Cannot access 'LEAK' before initialization"。
 */
const LEAK =
  /(at Object\.|at async |Error: |SELECT |INSERT |UPDATE |DELETE FROM|pg_|node_modules|BEGIN |ROLLBACK)/i;

const findings = [];
const stats = { probes: 0, ops: 0, skippedWrites: 0 };
function add(sev, tag, detail) {
  findings.push({ sev, tag, detail });
}

// ── 契约工具 ────────────────────────────────────────────
const schemas = spec.components?.schemas ?? {};
function deref(s, seen = 0) {
  if (s === null || s === undefined) return { type: 'object' };
  if (typeof s !== 'object') return { type: 'object' };
  if (s.$ref) {
    const name = String(s.$ref).split('/').pop();
    if (seen > 8) return { type: 'object' };
    return deref(schemas[name], seen + 1);
  }
  return s;
}

/** 按 schema 生成一个「合法基线」值（尽量小、不触发 min/max）。 */
function gen(s, seen = 0) {
  const sc = deref(s, seen);
  if (seen > 8) return null;
  if (Array.isArray(sc.enum) && sc.enum.length > 0) return sc.enum[0];
  switch (sc.type) {
    case 'string':
      return sc.format === 'date-time' ? new Date().toISOString() : 'テスト';
    case 'integer':
      return Math.max(1, Number(sc.minimum ?? 1));
    case 'number':
      return Number(sc.minimum ?? 1.5);
    case 'boolean':
      return true;
    case 'array':
      return sc.items ? [gen(sc.items, seen + 1)] : [];
    case 'object':
    default: {
      const out = {};
      const reqd = new Set(Array.isArray(sc.required) ? sc.required : []);
      for (const [k, v] of Object.entries(sc.properties ?? {})) {
        if (reqd.has(k)) out[k] = gen(v, seen + 1);
      }
      // 非必填也塞进去，尽量贴近真实请求（有的路由对缺省 semantics 不同）
      for (const [k, v] of Object.entries(sc.properties ?? {})) {
        if (!(k in out) && Math.abs(hash(k)) % 3 === 0) out[k] = gen(v, seen + 1);
      }
      return out;
    }
  }
}
const hash = (s) => Array.from(s).reduce((a, c) => a + c.charCodeAt(0), 0);

/** 收集对象 schema 顶层的字符串 / 数字字段（用于逐字段变异）。 */
function topFields(sc) {
  const s = deref(sc);
  const out = { strings: [], numbers: [], enums: [] };
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    const vs = deref(v);
    if (vs.type === 'string') {
      if (Array.isArray(vs.enum)) out.enums.push(k);
      else out.strings.push(k);
    } else if (vs.type === 'integer' || vs.type === 'number') out.numbers.push(k);
  }
  return out;
}

// ── 自检（缺陷注入：证明本 harness 本身是敏感的）────────
/**
 * @why 全绿是最不可信的输出——它既可能是"服务端真的没问题"，
 *      也可能是"探测器根本没接上"（写错了字段名、断言永远为真）。
 *      按约束八，注入 5 个已知坏响应，必须全部报红；漏报即 exit 1。
 *      这条自检让"0 异常"这个结论**可复现地**成立，而不是一句自述。
 */
if (process.argv.includes('--selftest')) {
  const cases = [
    [
      'selftest/5xx',
      { status: 500, ct: 'application/json', body: '{"code":50000,"message":"boom"}' },
      ['200', '400'],
      null,
    ],
    [
      'selftest/契约漂移',
      { status: 418, ct: 'application/json', body: '{"code":40001,"message":"x"}' },
      ['200', '400'],
      null,
    ],
    [
      'selftest/缺必回键',
      { status: 200, ct: 'application/json', body: '{"a":1}' },
      ['200'],
      { required: ['zzz'] },
    ],
    [
      'selftest/泄漏堆栈',
      {
        status: 400,
        ct: 'application/json',
        body: '{"code":40001,"message":"at Object.<anonymous> SELECT 1"}',
      },
      ['400'],
      null,
    ],
    ['selftest/非JSON', { status: 200, ct: 'text/html', body: '<html></html>' }, ['200'], null],
  ];
  let reds = 0;
  for (const [tag, r, decl, ok] of cases) {
    const n0 = findings.length;
    check(tag, r, decl, ok);
    if (findings.length > n0) reds++;
    else console.log('  ✗ 自检漏报: ' + tag);
  }
  console.log('自检（缺陷注入）: 应报红 ' + cases.length + ' 项，实际报红 ' + reds + ' 项');
  process.exit(reds === cases.length ? 0 : 1);
}

// ── 登录 ────────────────────────────────────────────────
const lr = await req('POST', PREFIX + '/auth/admin/login', { email: EMAIL, password: PASS });
const token = jparse(lr)?.token ?? '';
console.log('登录: ' + lr.status + ' token=' + (token ? 'yes' : 'NO ' + lr.body.slice(0, 80)));
if (!token) process.exit(1);

// ── 真实样本 id（路径参数）───────────────────────────────
async function firstOf(urlPath, listKey) {
  const r = await req('GET', urlPath, undefined, token);
  const j = jparse(r);
  const arr = j?.[listKey] ?? [];
  return arr[0] ?? null;
}
const order = await firstOf(PREFIX + '/admin/orders?size=100', 'items');
const product = await firstOf(PREFIX + '/admin/products?size=5', 'items');
const banner = await firstOf(PREFIX + '/admin/banners', 'items');
const user = await firstOf(PREFIX + '/admin/users', 'items');
const oid = order?.order_id ?? order?.id ?? '';
const pid = product?.id ?? '';
const bid = banner?.id ?? '';
const uid = user?.id ?? user?.user_id ?? '';
console.log(
  '样本: order=' +
    oid.slice(0, 12) +
    ' product=' +
    pid.slice(0, 12) +
    ' banner=' +
    String(bid).slice(0, 12) +
    ' user=' +
    String(uid).slice(0, 12),
);

const PATHVAL = { id: oid, productId: pid, refundId: 'rf-does-not-exist', kind: 'orders' };
/** 写路由的路径参数一律用不存在的 id：探得到校验，碰不到真数据。 */
const FAKE_ID = 'fuzz-does-not-exist';
function fillPath(p, write) {
  return p.replace(/\{(\w+)\}/g, (_, k) => {
    if (write && k !== 'kind') return FAKE_ID;
    return PATHVAL[k] !== undefined ? PATHVAL[k] : k === 'id' ? oid : 'x';
  });
}

// ── 校验 ────────────────────────────────────────────────
function check(tag, r, declaredCodes, okSchema) {
  stats.probes++;
  if (r.status === 0) {
    add('P0', tag, '连接失败/超时: ' + r.body);
    return;
  }
  const declared = declaredCodes.map(Number);
  if (declared.length > 0 && !declared.includes(r.status)) {
    add(
      'P1',
      tag,
      '契约漂移：实际 ' +
        r.status +
        ' 不在契约声明集合 [' +
        declared.join(',') +
        '] 内, body=' +
        r.body.slice(0, 90),
    );
  }
  if (r.status >= 500 && !declared.includes(r.status)) {
    add('P0', tag, '5xx: ' + r.body.slice(0, 140));
    return;
  }
  if (!r.ct.includes('application/json') && r.status !== 204) {
    add('P1', tag, 'content-type 非 JSON: ' + (r.ct || '(无)') + ' body=' + r.body.slice(0, 70));
    return;
  }
  const j = r.status === 204 ? null : jparse(r);
  if (j === null && r.status !== 204) {
    add('P0', tag, 'JSON 解析失败: ' + r.body.slice(0, 110));
    return;
  }
  if (r.status >= 400) {
    if (typeof j.code !== 'number') add('P1', tag, '错误体缺数字 code: ' + r.body.slice(0, 90));
    if (typeof j.message !== 'string' || j.message.length === 0)
      add('P1', tag, '错误体缺可读 message: ' + r.body.slice(0, 90));
    if (LEAK.test(r.body)) add('P0', tag, '错误体疑似泄漏内部信息: ' + r.body.slice(0, 150));
  }
  if (r.status >= 200 && r.status < 300 && okSchema) {
    const need = Array.isArray(okSchema.required) ? okSchema.required : [];
    const missing = need.filter((k) => !(k in (j ?? {})));
    if (missing.length > 0) add('P1', tag, '2xx 响应缺契约声明的必回键: ' + missing.join(','));
  }
}

// ── 主循环：遍历契约里每个管理端 op ──────────────────────
console.log('\n开始遍历契约中的管理端接口 …\n');
for (const [rawPath, ops] of Object.entries(spec.paths ?? {})) {
  if (!rawPath.startsWith('/admin')) continue;
  for (const [method, op] of Object.entries(ops)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const write = method !== 'get';
    if (write && !ALLOW_WRITES) {
      stats.skippedWrites++;
      continue;
    }
    stats.ops++;
    const decl = Object.keys(op.responses ?? {}).map(Number);
    const okSchema = deref(
      op.responses?.['200']?.content?.['application/json']?.schema ??
        op.responses?.['201']?.content?.['application/json']?.schema,
    );
    const urlPath = PREFIX + fillPath(rawPath, write);
    const label = method.toUpperCase() + ' ' + rawPath;

    const bodySchema = op.requestBody?.content?.['application/json']?.schema;
    const baseline = bodySchema ? gen(bodySchema) : undefined;

    const cases = [];
    if (bodySchema) {
      const f = topFields(bodySchema);
      const reqd = Array.isArray(deref(bodySchema).required) ? deref(bodySchema).required : [];
      // 缺失每个必填
      for (const k of reqd) {
        const b = { ...baseline };
        delete b[k];
        cases.push(['缺必填 ' + k, b]);
      }
      // 每个必填空串
      for (const k of reqd) {
        const b = { ...baseline };
        b[k] = '';
        cases.push(['空串 ' + k, b]);
      }
      // 每个必填 null
      for (const k of reqd) cases.push(['null ' + k, { ...baseline, [k]: null }]);
      // 字符串字段超长
      for (const k of f.strings) cases.push(['超长 ' + k, { ...baseline, [k]: 'x'.repeat(2000) }]);
      // 数字字段越界
      for (const k of f.numbers) {
        cases.push(['负数 ' + k, { ...baseline, [k]: -1 }]);
        cases.push(['零 ' + k, { ...baseline, [k]: 0 }]);
        cases.push(['浮点 ' + k, { ...baseline, [k]: 1.5 }]);
        cases.push(['超大 ' + k, { ...baseline, [k]: 1e21 }]);
        cases.push(['错型 ' + k, { ...baseline, [k]: 'abc' }]);
      }
      // enum 非法值
      for (const k of f.enums)
        cases.push(['非法枚举 ' + k, { ...baseline, [k]: '__NOT_IN_ENUM__' }]);
      // 整体畸形
      cases.push(['空对象', {}]);
      cases.push(['多余字段', { ...baseline, admin_override: true, force: 'yes' }]);
    }

    for (const [name, body] of cases) {
      const r = await req(method.toUpperCase(), urlPath, body, token);
      check(label + ' ← ' + name, r, decl, okSchema);
    }
    process.stdout.write('.');
  }
}
console.log('\n');

// ── 附加：协议层（不写业务库的通用畸形）───────────────────
console.log('协议层畸形 …');
const protoTarget = PREFIX + '/admin/orders/' + FAKE_ID + '/ship';
const protoCases = [
  ['裸数组体', 'PUT', PREFIX + '/admin/shipping-rates', []],
  ['裸字符串体', 'PUT', PREFIX + '/admin/shipping-rates', 'not-json'],
  ['JSON 语法错误', 'PUT', PREFIX + '/admin/shipping-rates', '{"a":'],
  [
    '超大 body 1MB',
    'PUT',
    PREFIX + '/admin/shipping-rates',
    { zone: 'JP', note: 'x'.repeat(1024 * 1024) },
  ],
  ['写路由发 GET', 'GET', protoTarget, undefined],
  ['写路由发 DELETE', 'DELETE', protoTarget, {}],
  ['只读路由发 DELETE', 'DELETE', PREFIX + '/admin/orders', {}],
  ['伪造 JWT alg=none', 'GET', PREFIX + '/admin/orders', undefined],
  ['超长 URL', 'GET', PREFIX + '/admin/orders?keyword=' + 'a'.repeat(8000), undefined],
];
for (const [name, m, p, body] of protoCases) {
  if (m !== 'GET' && m !== 'DELETE' && !ALLOW_WRITES) continue; // PUT 畸形体：只读模式不发
  const r = await req(
    m,
    p,
    body,
    name.includes('伪造') ? 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.' : token,
  );
  check('协议:' + name, r, [], null);
  if (r.status >= 200 && r.status < 300 && !name.includes('只读路由发 DELETE')) {
    add('P2', '协议:' + name, '畸形请求拿到 ' + r.status + '（应 4xx）: ' + r.body.slice(0, 80));
  }
}

// ── 汇总 ────────────────────────────────────────────────
const rank = { P0: 0, P1: 0, P2: 0 };
for (const f of findings) rank[f.sev] = (rank[f.sev] ?? 0) + 1;
console.log('\n========== 汇总 ==========');
console.log('覆盖接口 ' + stats.ops + ' 个，发出探测 ' + stats.probes + ' 次');
if (stats.skippedWrites > 0)
  console.log(
    '跳过写接口 ' +
      stats.skippedWrites +
      ' 个（只读模式；要探写接口加 --allow-writes，只对模拟库用）',
  );
console.log('P0=' + rank.P0 + '  P1=' + rank.P1 + '  P2=' + rank.P2);
const order2 = ['P0', 'P1', 'P2'];
for (const sev of order2) {
  const same = findings.filter((f) => f.sev === sev);
  const uniq = new Set(
    same.map((f) => f.tag.split(' ← ')[0] + '|' + f.detail.replace(/\d+/g, '#')),
  );
  console.log(
    '\n---- ' + sev + ' （去重后 ' + uniq.size + ' 类 / 原始 ' + same.length + ' 条）----',
  );
  const shown = new Set();
  for (const f of same) {
    const key = f.tag.split(' ← ')[0] + '|' + f.detail.replace(/\d+/g, '#');
    if (shown.has(key)) continue;
    shown.add(key);
    console.log('  [' + sev + '] ' + f.tag + ': ' + f.detail);
  }
}
