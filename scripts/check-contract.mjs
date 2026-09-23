#!/usr/bin/env node
/**
 * 职责：契约漂移检查——shared 里的错误码与状态枚举，必须在 api-contract.yaml 中出现。
 * 逻辑：按文本匹配（不解析 YAML），避免为一个检查引入 YAML 依赖；改 yaml 而漏改 shared（或反之）即报红。
 *
 * @why 契约文件**必须在本仓库内**：曾经脚本硬编码读 `../jp/50-产品与技术/技术架构/api-contract.yaml`，
 *      后果是 ① CI / 新同事克隆本仓库时该路径不存在 → `npm run gate` 直接崩（门禁形同虚设）；
 *      ② 检查是否跑过取决于"隔壁仓库恰好在旁边且没动过"，属于隐式环境依赖。
 *      现在默认读 `contracts/api-contract.yaml`（随代码一起版本化），
 *      仍可用 `CONTRACT_PATH` 指向别处（例如文档库的权威副本）做对账。
 *
 * @limitation 一：文本匹配会漏掉"yaml 里写了但 shared 没登记"的方向（只查单向漂移）；
 *              反向检查需要解析 YAML，等 F2 接入 openapi-typescript 时一并做。
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
console.log(`  契约来源：${contractPath}`);
