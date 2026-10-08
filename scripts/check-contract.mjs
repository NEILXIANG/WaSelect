#!/usr/bin/env node
/**
 * 职责：契约漂移检查——shared 里的错误码与状态枚举，必须与 api-contract.yaml 一致（登记表双向，其余整词存在）。
 * 逻辑：按文本匹配（不解析 YAML），避免为一个检查引入 YAML 依赖；改 yaml 而漏改 shared（或反之）即报红。
 *
 * @why 契约文件**必须在本仓库内**：曾经脚本硬编码读 `../jp/50-产品与技术/技术架构/api-contract.yaml`，
 *      后果是 ① CI / 新同事克隆本仓库时该路径不存在 → `npm run gate` 直接崩（门禁形同虚设）；
 *      ② 检查是否跑过取决于"隔壁仓库恰好在旁边且没动过"，属于隐式环境依赖。
 *      现在默认读 `contracts/api-contract.yaml`（随代码一起版本化），
 *      仍可用 `CONTRACT_PATH` 指向别处（例如文档库的权威副本）做对账。
 *
 * @limitation 一：错误码与契约 `x-error-codes.codes` 登记表做**双向**集合比对（一致性审计 C7，AJ-176；
 *              此前只查单向且是全文子串匹配）；枚举对 ENUM_TO_CONTRACT_KEY 登记的三组做**双向**集合比对，
 *              其余枚举只查整词存在性（三审 P2-3）。字段 / 响应码层面的完整比对等 F2 接入
 *              openapi-typescript 时一并做（路由的"方法+路径"已由 routes.contract.test 双向守住）。
 * @limitation 二：仓库内这份副本与文档库（jp）的副本是**两份文件**，存在漂移可能。
 *              缓解：若本机存在 jp 的那一份，脚本会比对内容，不一致即报红并给出同步命令。
 *              根治方案是把权威源迁到本仓库、文档库改为引用——涉及跨仓库约定，待确认后执行。
 *
 * @see docs/地基搭建清单.md F2；由 `npm run check:contract` 调用并进 `npm run gate`
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = resolve(root, 'contracts/api-contract.yaml');
const docRepoCopy = resolve(root, '../jp/50-产品与技术/技术架构/api-contract.yaml');

const contractPath = process.env.CONTRACT_PATH ? resolve(process.env.CONTRACT_PATH) : vendored;
if (!existsSync(contractPath)) {
  console.error(`找不到契约文件：${contractPath}`);
  console.error('提示：默认读取 contracts/api-contract.yaml；可用 CONTRACT_PATH 指定其它位置');
  process.exit(1);
}
const contract = readFileSync(contractPath, 'utf8');
const errorsSrc = readFileSync(resolve(root, 'packages/shared/src/errors.ts'), 'utf8');
const enumsSrc = readFileSync(resolve(root, 'packages/shared/src/enums.ts'), 'utf8');

const problems = [];

// 双副本漂移检测：只在文档库副本存在时生效（CI 上没有 jp 仓库，自动跳过）
if (contractPath !== docRepoCopy && existsSync(docRepoCopy)) {
  const docText = readFileSync(docRepoCopy, 'utf8');
  if (docText !== contract) {
    problems.push(
      `契约双副本不一致：\n      工程库 ${contractPath}\n      文档库 ${docRepoCopy}\n` +
        `      同步命令：cp "${docRepoCopy}" "${vendored}"`,
    );
  }
}

const codes = [...errorsSrc.matchAll(/^\s{2}(\d{5}): \{/gm)].map((m) => m[1]);
if (codes.length === 0) problems.push('errors.ts 里没有解析到任何错误码（正则失效？）');

// ── 错误码：与契约 `x-error-codes.codes` 登记表做**双向集合相等**（一致性审计 C7，AJ-176）──────
// 旧实现：`contract.includes(code)` 全文子串匹配。实测漏洞：40402 / 40403 / 40910 / 40911 四个码
// 只出现在版本变更说明的正文里、从未进登记表，检查照样通过——"登记表是唯一真源"这句注释是假的。
// 现在：只认登记表段（`x-error-codes:` 下 `codes:` 的 `NNNNN: 文案` 行，到下一个顶层键为止）。
function contractErrorCodes(text) {
  const block = /^x-error-codes:\n([\s\S]*?)(?=^\S)/m.exec(text)?.[1] ?? '';
  const codesPart = /^\s+codes:\n([\s\S]*)$/m.exec(block)?.[1] ?? '';
  return [...codesPart.matchAll(/^\s+(\d{5}):/gm)].map((m) => m[1]);
}
const registered = contractErrorCodes(contract);
if (registered.length === 0) {
  problems.push('契约 x-error-codes.codes 登记表没有解析到任何码（格式变了？扫描器不能空跑）');
}
for (const code of codes) {
  if (!registered.includes(code))
    problems.push(`错误码 ${code} 在 shared 有、契约 x-error-codes 登记表里没有`);
}
for (const code of registered) {
  if (!codes.includes(code))
    problems.push(`错误码 ${code} 在契约登记表有、shared/errors.ts 里没有`);
}

// ── 枚举漂移（三审 P2-3 重写）────────────────────────────────────────────────
// 旧实现：把 enums.ts 里的值逐个 `contract.includes(value)` 子串匹配，且正则只认小写。
// 后果（三审实测注入）：从契约 OrderStatus 枚举行删掉 `shipped`，`shipped_at` 仍命中 → 检查通过；
// CURRENCY / COUNTRY 这类大写枚举根本不在扫描面内。
// 现在：① 解析 enums.ts 里**每一个** `export const X = [...] as const`（单行/多行/任意大小写）；
//       ② 有对应契约 schema 的枚举做**双向集合相等**（契约多一个、shared 少一个都红）；
//       ③ 没有对应 schema 的枚举退化为**整词**匹配（`\bpaid\b` 不再命中 `paid_amount` / `unpaid`）；
//       ④ 自检：enums.ts 里 `as const` 数组的个数必须等于解析到的个数（扫描器自己不能漏）。

/** enums.ts 里所有 `export const NAME = [...] as const` → { NAME: [values] } */
function parseSharedEnums(src) {
  const out = new Map();
  for (const m of src.matchAll(/export const ([A-Z_]+) = \[([\s\S]*?)\] as const/g)) {
    const values = [...(m[2] ?? '').matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
    out.set(m[1], values);
  }
  return out;
}

/**
 * 取契约里某个枚举的值集合（只取第一处）。支持两种形态：
 *   ① schema 形态 — `<key>: {…enum: [a, b, c]…}`（key 可带片段前缀，见 COMPLIANCE_TAG）
 *   ② 登记表形态 — 顶层 `x-<key>:` 字段下的 `keys: [a, b, c]`（key 以 `x-` 开头即走这条）
 *
 * @why 形态 ② 是为 D-59 加的：`channel` 的 OpenAPI `enum` 必须去掉（D-56 要求新增支付方式不改契约），
 *      但"shared 的 PAYMENT_CHANNEL ↔ 契约登记"这一层防漂移不能跟着丢——
 *      于是锚点从 schema 枚举换成顶层登记表 `x-payment-channels.keys`，双向比对照旧。
 * @tradeoff 锚点不再是请求体的 schema，意味着"契约的登记表与请求体 schema 是否还讲同一件事"
 *           靠注释维系，机器不校验；换来的是新增通道不必改 schema（D-56 的硬要求）。
 */
function contractEnum(text, key) {
  const re = key.startsWith('x-')
    ? new RegExp(`^${key}:[\\s\\S]*?^\\s+keys: \\[([^\\]]*)\\]`, 'm')
    : new RegExp(`\\b${key}: \\{[^{}]*?\\benum: \\[([^\\]]*)\\]`);
  const m = text.match(re);
  if (!m) return undefined;
  return m[1]
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * shared 枚举 → 契约里对应的枚举位置（key 名）。**没有对应位置的枚举只做整词存在性检查**。
 * @why 显式列出而不是猜：CURRENCY 在契约里没有"全集"枚举（PaymentIntent.charge.currency 只列扣款币，
 *      Display 的 CNY/USD 又是另一种形态），硬对集合会把契约设计问题误报成漂移。
 */
const ENUM_TO_CONTRACT_KEY = {
  ORDER_STATUS: 'OrderStatus',
  // D-59：不再指向 schema 里的 `channel` enum（那已是任意字符串），改指向顶层登记表。
  PAYMENT_CHANNEL: 'x-payment-channels',
  COMPLIANCE_TAG: 'compliance_tags: {type: array, items',
  // 0.6.50（AJ-409）：埋点三张白名单——事件名、页面键、放弃原因
  BEACON_EVENT: 'BeaconEventName',
  BEACON_PAGE: 'BeaconPage',
  BEACON_ABANDON_REASON: 'BeaconAbandonReason',
};

const sharedEnums = parseSharedEnums(enumsSrc);
const asConstCount = (enumsSrc.match(/\] as const/g) ?? []).length;
if (sharedEnums.size === 0) problems.push('enums.ts 里没有解析到任何枚举（正则失效？）');
if (sharedEnums.size !== asConstCount) {
  problems.push(
    `枚举扫描器覆盖面不完整：enums.ts 有 ${asConstCount} 个 \`as const\` 数组，只解析到 ${sharedEnums.size} 个（扫描器自身必须被扫到）`,
  );
}
for (const name of Object.keys(ENUM_TO_CONTRACT_KEY)) {
  if (!sharedEnums.has(name))
    problems.push(`shared 缺少枚举 ${name}（ENUM_TO_CONTRACT_KEY 登记了但 enums.ts 没有）`);
}

let enumValueCount = 0;
for (const [name, values] of sharedEnums) {
  if (values.length === 0) {
    problems.push(`枚举 ${name} 解析到 0 个值（正则失效？）`);
    continue;
  }
  enumValueCount += values.length;
  const contractKey = ENUM_TO_CONTRACT_KEY[name];
  if (contractKey !== undefined) {
    const inContract = contractEnum(contract, contractKey);
    if (inContract === undefined) {
      problems.push(`契约里找不到 ${name} 对应的枚举（key: ${contractKey}）`);
      continue;
    }
    const a = [...values].sort().join(',');
    const b = [...inContract].sort().join(',');
    if (a !== b) {
      problems.push(`枚举 ${name} 与契约不一致：shared=[${a}] contract=[${b}]`);
    }
    continue;
  }
  for (const v of values) {
    if (!new RegExp(`\\b${v}\\b`).test(contract)) {
      problems.push(`枚举值 ${name}.${v} 未在 api-contract.yaml 中出现（整词匹配）`);
    }
  }
}
const states = { length: enumValueCount };

if (problems.length > 0) {
  console.error('契约漂移检查失败：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(
  `契约漂移检查通过：${codes.length} 个错误码、${sharedEnums.size} 个枚举（${states.length} 个值）与契约一致`,
);
console.log(`  契约来源：${contractPath}`);
