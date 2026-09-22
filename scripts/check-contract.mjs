#!/usr/bin/env node
/**
 * 职责：契约漂移检查——shared 里的错误码与状态枚举，必须在 api-contract.yaml 中出现。
 * 逻辑：按文本匹配（不解析 YAML），避免为一个检查引入 YAML 依赖；改 yaml 而漏改 shared（或反之）即报红。
 * @see docs/地基搭建清单.md F2；由 `npm run check:contract` 调用并进 `npm run gate`
 * @limitation 文本匹配会漏掉"yaml 里写了但 shared 没登记"的方向（只查单向漂移）；
 *             反向检查需要解析 YAML，等 F2 接入 openapi-typescript 时一并做。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = readFileSync(resolve(root, '../jp/50-产品与技术/技术架构/api-contract.yaml'), 'utf8');
const errorsSrc = readFileSync(resolve(root, 'packages/shared/src/errors.ts'), 'utf8');
const enumsSrc = readFileSync(resolve(root, 'packages/shared/src/enums.ts'), 'utf8');

const problems = [];

const codes = [...errorsSrc.matchAll(/^\s{2}(\d{5}): \{/gm)].map((m) => m[1]);
if (codes.length === 0) problems.push('errors.ts 里没有解析到任何错误码（正则失效？）');
for (const code of codes) {
  if (!contract.includes(code)) problems.push(`错误码 ${code} 未在 api-contract.yaml 中出现`);
}

const states = [...enumsSrc.matchAll(/^\s+'([a-z_]+)',$/gm)].map((m) => m[1]);
for (const state of states) {
  if (!contract.includes(state)) problems.push(`枚举值 ${state} 未在 api-contract.yaml 中出现`);
}

if (problems.length > 0) {
  console.error('契约漂移检查失败：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`契约漂移检查通过：${codes.length} 个错误码、${states.length} 个枚举值都在契约中`);
