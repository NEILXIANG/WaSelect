/**
 * 职责：**路由快照与契约比对**（I1-U1）——从 Express 应用内省出"代码实际挂了哪些路由"，
 *       从契约文本解析出"契约承诺了哪些路由"，两者做**双向**集合比对。
 *
 * @why 契约-代码漂移是全库最高雪崩风险（三次全量审查）：错误码/枚举面有 check-contract.mjs
 *      守着，但**路由面**长期靠人肉。I1 要新增十余条路由，每加一条都可能"代码挂了契约没写"
 *      （前端按契约写就 404）或"契约写了代码没做"（前端调了 404）。本模块把这件事变成
 *      gate 里的一条红灯。
 *
 * @why 用 Express 内省（`app.router.stack`）而不是静态正则扫源码：扫源码看到的是"字符串字面量"，
 *      看不到"真的挂上了没有"（路径常量拼接、条件挂载、前缀归一都是运行时事实）。
 *      内省拿到的是**运行时真相**——与生产收到请求时走的路由表是同一份。
 *
 * @why 比对是纯函数（`diffRoutes`），与"怎么采集"分开：纯函数可以被缺陷注入式用例直接喂
 *      脏输入（多一条/少一条/豁免失效），采集层只负责拿到真实数据。
 *      这也是本文件的自检形态：**比对器自己先被测**，然后才轮到它去测别人。
 *
 * @limitation 一：只比"方法 + 路径形状"，不比请求体/响应体 schema。形状级的比对能抓住
 *              "有没有这条路由"，抓不住"这条路由的字段变了"——后者留给 openapi-typescript
 *              类型的完整契约校验（地基清单 F2 后续项），不在本模块承诺内。
 * @limitation 二：契约解析是**文本解析**（不引入 YAML 依赖，与 check-contract.mjs 同口径）。
 *              它认死了本仓库契约的缩进约定（paths 下 2 空格路径、4 空格方法）；
 *              契约改用别的排版（如把方法压成 flow 风格单行）会让解析漏掉——
 *              由"解析结果数量必须大于阈值"的健全性断言兜底（漏解析 = 红灯，不是假绿）。
 * @limitation 三：路径参数名不参与比对（`:id` 与 `{id}` 都归一成 `{}`）。
 *              参数名不一致（`:orderId` vs `{id}`）不会被抓——这是刻意的：
 *              参数名是文档语义，改它不破环调用；要抓也属于 schema 级校验（同 @limitation 一）。
 *
 * @see server/src/routes.contract.test.ts（比对策略与豁免/未实现清单的**唯一登记处**）；
 *      scripts/check-contract.mjs（错误码/枚举面的同类机制）；docs/I1阶段开发实施方案.md §3.1
 */
import type { Express } from 'express';

/** 一条路由的"形状"：方法 + 归一化路径（参数位 `{}`，不带 `/api/v1` 前缀）。 */
export interface RouteRef {
  method: string;
  /** 归一化后的路径，如 `/pay/callback/{}`、`/orders`。 */
  path: string;
}

/**
 * 业务路由的统一前缀。**唯一出处**——契约 paths 不带它，代码路由带它，比对前两边的归一都靠它。
 * @why 写成常量而不是两处各写一遍字符串：前缀若改（/api/v2），只改这里；
 *      散落在比对器和装配层两份，迟早一边改了另一边没改，比对结果全红却查不出原因。
 */
export const API_PREFIX = '/api/v1';

/**
 * 归一化路径：去 `API_PREFIX`，参数位统一成 `{}`（Express 的 `:id` 与契约的 `{id}` 都算）。
 * 导出的原因：比对策略（测试侧）登记"未实现清单"时可以直接写契约原文 `{id}`，由它归一。
 */
export function normalizeRoutePath(path: string): string {
  const stripped = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) || '/' : path;
  return stripped.replace(/:[^/]+/g, '{}').replace(/\{[^}/]+\}/g, '{}');
}

/** Express 5 的路由层形状（只取本模块需要的字段；完整类型 @types/express 未导出）。 */
interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
}

/**
 * 从 Express 应用内省出全部已挂载路由（归一化后）。
 *
 * @why 只收 `layer.route` 层：中间件层（`app.use`）没有 route 属性，天然被跳过——
 *      404 兜底、错误兜底、CORS 这些"不是业务路由"的层不会混进来。
 * @limitation 不展开嵌套 Router（`app.use('/x', router)`）：本仓库路由全部直接挂在 app 上
 *              （见各 mount* 模块）。将来若引入嵌套 Router，这里需要递归——
 *              届时"嵌套层有 route 之外的 stack"这一事实会让路由数变少，健全性断言会先红。
 */
export function collectAppRoutes(app: Express): RouteRef[] {
  const stack =
    (app as unknown as { router?: { stack?: readonly RouteLayer[] } }).router?.stack ?? [];
  const out: RouteRef[] = [];
  for (const layer of stack) {
    if (layer.route === undefined) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: normalizeRoutePath(layer.route.path) });
    }
  }
  return out;
}

const CONTRACT_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/**
 * 从契约 YAML 文本解析 paths 段（方法 + 归一化路径）。
 *
 * @why 文本解析而不引 YAML 库：为一个门禁引一个依赖，得到的是"依赖自身的供应链风险 +
 *      版本漂移面"，与本检查的收益不成比例（与 check-contract.mjs 同一个判断，AJ 既有口径）。
 * @limitation 依赖缩进约定（paths: 顶格、路径 2 空格、方法 4 空格），见文件头 @limitation 二。
 */
export function parseContractRoutes(yaml: string): RouteRef[] {
  const out: RouteRef[] = [];
  let inPaths = false;
  let currentPath: string | null = null;
  for (const line of yaml.split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    // 下一个顶层键（components: 等）= paths 段结束
    if (inPaths && /^[a-zA-Z_]/.test(line)) break;
    if (!inPaths) continue;
    const pathMatch = /^ {2}(\/\S+):\s*$/.exec(line);
    if (pathMatch !== null) {
      currentPath = pathMatch[1] ?? null;
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete|head|options):\s*/.exec(line);
    if (methodMatch !== null && currentPath !== null) {
      const method = (methodMatch[1] ?? '').toUpperCase();
      if ((CONTRACT_METHODS as readonly string[]).includes(method.toLowerCase())) {
        out.push({ method, path: normalizeRoutePath(currentPath) });
      }
    }
  }
  return out;
}

/** 代码侧豁免：允许"挂了但不在契约里"的路由（每条必须给理由；失效即红）。 */
export interface CodeExemption {
  pattern: RegExp;
  reason: string;
}

/** 契约侧未实现登记：允许"契约写了但还没实现"的路由（每条必须给理由；实现后必须移除）。 */
export interface NotImplementedRoute {
  method: string;
  path: string;
  reason: string;
}

export interface DiffRoutesOptions {
  codeExemptions: readonly CodeExemption[];
  notImplemented: readonly NotImplementedRoute[];
}

function routeKey(r: RouteRef): string {
  return `${r.method} ${r.path}`;
}

/**
 * 双向比对（纯函数）。返回问题清单；空数组 = 一致。
 *
 * 五条规则，每条对应一种真实的漂移形态：
 *  ① 代码有、契约没有 → 前端按契约写会 404（且这条路由在文档里"不存在"，review 面外）；
 *  ② 契约有、代码没有、也未登记 → 前端调它会 404；
 *  ③ 代码豁免**失效**（没有路由再匹配它）→ 豁免是漏网清单，失效不删等于给未来开暗门；
 *  ④ 未实现清单里的路由**已实现** → 清单不删，下一次"契约删了这条路由"会被清单挡住真相；
 *  ⑤ 未实现清单条目**不在契约里** → 清单与契约各自漂移（契约改了路径，清单还在守旧路径）。
 *
 * @why ③④⑤ 是"清单自身的防漂移"：豁免与未实现清单是**逃生舱**，逃生舱如果没有自洁机制，
 *      半年后就变成第二份没人敢动的隐式路由表——那正是本模块要消灭的东西。
 */
export function diffRoutes(
  code: readonly RouteRef[],
  contract: readonly RouteRef[],
  opts: DiffRoutesOptions,
): string[] {
  const problems: string[] = [];
  const contractKeys = new Set(contract.map(routeKey));
  const codeKeys = new Set(code.map(routeKey));

  const usedExemptions = new Set<number>();
  for (const r of code) {
    if (contractKeys.has(routeKey(r))) continue;
    const idx = opts.codeExemptions.findIndex((e) => e.pattern.test(routeKey(r)));
    if (idx >= 0) {
      usedExemptions.add(idx);
      continue;
    }
    problems.push(`代码路由未在契约登记：${routeKey(r)}`);
  }

  const normalizedNI = opts.notImplemented.map((n) => ({
    ...n,
    path: normalizeRoutePath(n.path),
  }));
  const niKeys = new Set(normalizedNI.map(routeKey));
  for (const c of contract) {
    if (codeKeys.has(routeKey(c))) continue;
    if (niKeys.has(routeKey(c))) continue;
    problems.push(`契约路由未实现且未登记到未实现清单：${routeKey(c)}`);
  }

  opts.codeExemptions.forEach((e, i) => {
    if (!usedExemptions.has(i)) {
      problems.push(
        `代码侧豁免已失效（没有路由再匹配），请删除：${e.pattern.source}（${e.reason}）`,
      );
    }
  });
  for (const n of normalizedNI) {
    if (codeKeys.has(routeKey(n))) {
      problems.push(
        `未实现清单中的路由已实现，请移除该条目：${routeKey(n)}（原登记理由：${n.reason}）`,
      );
    }
    if (!contractKeys.has(routeKey(n))) {
      problems.push(`未实现清单条目不在契约中：${routeKey(n)}（原登记理由：${n.reason}）`);
    }
  }
  return problems;
}
