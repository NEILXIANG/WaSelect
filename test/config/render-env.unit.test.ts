/**
 * 职责：`render.yaml` ↔ 配置 schema 的**三项一致性**（F16 部署底座的守卫）。
 *
 * @why 部署配置最危险的一类失效不是"配错了值"，而是"**平台上的清单和代码对不上**"，
 *      而且两个方向都不会报错：
 *      ① **漏配**：代码新增了一个必填变量，平台上没配 → 本机永远发现不了（本机 `.env` 里有），
 *         只在**部署之后启动失败**时才暴露，那时已经是一次失败的发布；
 *         更糟的是失败形态是"服务起不来"，排查时最容易误判成代码问题。
 *      ② **拼错**：平台上写了 `JWT_SECRECT` → zod 默认 strip 未知键，
 *         **静默忽略**并回落到默认值（@see server/src/config.ts @limitation 一）。
 *         服务照样起来，密钥却是最初的那个——这类"看起来一切正常"的错最难发现。
 *      ③ **密钥进仓库**：`render.yaml` 是提交进仓库的文件，给它写一个 `value: sk_live_...`
 *         等于把密钥交给所有能读仓库的人（含 CI 日志）。
 *      这三类都不是 bug，是"人对不上清单"，所以只能靠集合比对自动兜住。
 *
 * @how 纯 fs + 极简行解析：只认我们自己写的那一种缩进风格（`- key: X` + 缩进属性行），
 *      不引 YAML 依赖（`js-yaml` 在当前只是**间接依赖**，依赖它等于把门禁挂在别人的依赖树上）。
 *
 * @limitation 一：解析器只认 `- key: X` 这一种写法；换成内联流式的 YAML 会扫不到。
 *              @why 扫不到会立刻表现为"范围断言红"（里头必须含 `NODE_ENV`），
 *              不会静默变绿——这是刻意的设计：**让解析器失效以红灯的形式暴露**。
 * @limitation 二：只比对**键名**，不比对取值范围与是否合理（例如 `plan` 是不是该用 starter）；
 *              后者是人的判断，机器只能保证"没漏、没拼错、没把密钥写进来"。
 * @limitation 三：`REQUIRED_ENV_KEYS` 的判据是"单字段能否接受 undefined"，不含跨字段规则
 *              （"生产启用 stripe 时 CHECKOUT_BASE_URL 必填"那一类）。
 *              那几条的组合依赖其它字段的取值，无法离线枚举，靠 `config.unit.test.ts` 覆盖。
 *
 * @see ../../render.yaml；../../server/src/config.ts；docs/地基搭建清单.md F16
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, REQUIRED_ENV_KEYS, SECRET_KEYS } from '../../server/src/config.js';

const root = resolve(import.meta.dirname, '../..');
const renderYaml = readFileSync(resolve(root, 'render.yaml'), 'utf8');

/**
 * 平台上写、但**不由应用 schema 读取**的变量白名单。
 * @why 每条都必须写清原因，否则白名单会变成"懒得解释"的垃圾桶，机制就失效了。
 */
const PLATFORM_KEYS: Readonly<Record<string, string>> = {
  NODE_VERSION: 'Render 平台的运行时版本开关，由平台自身读取，不属于应用配置',
  DAILY_JOB_TARGET:
    'cron 服务专用：由平台 fromService(property: hostport) 注入的 web 服务内网地址，只给 startCommand 用，应用不读（AJ-176）',
  DEPLOY_TARGET:
    '构建期哨兵（B2）：admin-web 静态站构建时由本清单显式声明，`scripts/assert-admin-deploy-env.ts` ' +
    '只在它存在时才要求 VITE_API_BASE_URL 是 https 公网地址——删掉它等于把那道闸关掉',
  VITE_API_BASE_URL:
    'admin-web 专用构建期变量（Vite 只注入 VITE_ 前缀），由 admin-web/src/api/config.ts 读取；' +
    '不进服务端 schema，所以不在 CONFIG_KEYS 里',
};

interface EnvEntry {
  key: string;
  /** 这一条是否带了字面量 `value:`（密钥类绝不允许）。 */
  literal: boolean;
}

/**
 * 抽出 `render.yaml` 里声明的环境变量（`envVars` 的 `- key: …` 条目）。
 * @see @limitation 一
 */
function parseEnvEntries(yaml: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  let inEnv = false;
  let current: EnvEntry | undefined;
  for (const raw of yaml.split('\n')) {
    // 顶格 = 顶层结构键（`services:` / `databases:`）→ 环境变量段结束
    if (/^\S/.test(raw)) {
      inEnv = false;
      current = undefined;
      continue;
    }
    if (/^\s*envVars:\s*$/.test(raw)) {
      inEnv = true;
      current = undefined;
      continue;
    }
    // ⚠️ 只收 `envVars` 段里的条目：`databases` 段里的 `- name:` 之类不是环境变量
    //    （这是自检逼出来的——第一版不分段，把 `databases` 下的条目也收进来了）
    const head = /^\s*-\s*key:\s*([A-Za-z0-9_]+)\s*$/.exec(raw);
    if (head && inEnv) {
      current = { key: head[1] as string, literal: false };
      out.push(current);
      continue;
    }
    if (current !== undefined && /^\s+value:/.test(raw)) current.literal = true;
  }
  return out;
}

const declared = parseEnvEntries(renderYaml);
const declaredKeys = new Set(declared.map((e) => e.key));

/**
 * Blueprint 规范里 `databases[]` 条目允许的键（render.com/docs/blueprint-spec，2026-09-25 核对）。
 * @why 三审 P2-1：原文件写的是 `postgresVersion`，不是规范键名 `postgresMajorVersion`。
 *      这类错**不报错**——平台忽略未知键，建出默认版本的库；代码闸门 `assertPostgresMajor(>=16)`
 *      放行，CI 与生产的版本从此悄悄错位。和 envVars 的"拼错被 zod strip"是同一形态，所以同一守法。
 * @limitation 名单是人抄的；规范新增键时这里会误红（改名单即可，误红比漏配便宜）。
 */
const DATABASE_KEYS = new Set([
  'name',
  'plan',
  'region',
  'postgresMajorVersion',
  'databaseName',
  'user',
  'ipAllowList',
  'diskSizeGB',
  'highAvailability',
  'readReplicas',
  'previewPlan',
]);

interface DatabaseEntry {
  keys: Map<string, string>;
}

/**
 * 抽出 `databases:` 段里每个 `- name:` 条目的**键 → 原始值**（去掉行尾注释）。
 * @see @limitation 一（同样只认我们自己的缩进风格）
 */
function parseDatabases(yaml: string): DatabaseEntry[] {
  const out: DatabaseEntry[] = [];
  let inDb = false;
  let current: DatabaseEntry | undefined;
  for (const raw of yaml.split('\n')) {
    if (/^databases:\s*$/.test(raw)) {
      inDb = true;
      current = undefined;
      continue;
    }
    if (/^\S/.test(raw)) {
      inDb = false;
      current = undefined;
      continue;
    }
    if (!inDb) continue;
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const item = /^\s*-\s*([A-Za-z]+):\s*(.*)$/.exec(line);
    if (item) {
      current = { keys: new Map([[item[1] as string, item[2] as string]]) };
      out.push(current);
      continue;
    }
    const prop = /^\s+([A-Za-z]+):\s*(.*)$/.exec(line);
    if (prop && current) current.keys.set(prop[1] as string, prop[2] as string);
  }
  return out;
}

const databases = parseDatabases(renderYaml);

/**
 * 按 `  - type:` 切出每个服务块（只认我们自己的缩进风格，与上面两个解析器同口径）。
 * @why 静态站的形态断言需要一个"服务级"视角：envVars 是**跨服务汇总**的，
 *      只看汇总集合能证明"键存在"，证明不了"它挂在正确的服务上"
 *      ——而 `DEPLOY_TARGET` 挂在 web 服务上毫无意义（那里没有 admin 构建）。
 */
function parseServices(yaml: string): { header: string; body: string }[] {
  const lines = yaml.split('\n');
  const starts = lines.map((l, i) => (/^\s{2}-\s*type:\s*/.test(l) ? i : -1)).filter((i) => i >= 0);
  return starts.map((s, k) => {
    // 两个边界都算：下一个 `- type:`（同段内），以及**顶格键**（`databases:` = 服务段结束）。
    // ⚠️ 少了后者会把 databases 段也算进最后一个服务——那正是"越界"最可能的形态。
    let sectionEnd = lines.length;
    for (let i = s + 1; i < lines.length; i += 1) {
      if (/^\S/.test(lines[i] as string)) {
        sectionEnd = i;
        break;
      }
    }
    const next = k + 1 < starts.length ? (starts[k + 1] as number) : lines.length;
    const end = Math.min(sectionEnd, next);
    return { header: lines[s] as string, body: lines.slice(s, end).join('\n') };
  });
}

const services = parseServices(renderYaml);
const adminService = services.find((s) => /^\s*name:\s*waselect-admin\s*$/m.test(s.body));

describe('render.yaml ↔ 配置 schema 一致', () => {
  it('两边都非空，且含各自最关键的那几个键（防"空对空"永远绿）', () => {
    // @why 本项目第三次以上踩同一形态：解析失效 / 目录改名会让集合变空，
    //      于是下面的"没有缺项""没有拼错"全部永真。钉住真实存在的锚点键。
    expect(REQUIRED_ENV_KEYS.length).toBeGreaterThan(0);
    expect(REQUIRED_ENV_KEYS).toContain('DATABASE_URL');
    expect(REQUIRED_ENV_KEYS).toContain('JWT_SECRET');
    expect(declaredKeys.size).toBeGreaterThan(10);
    expect(declaredKeys.has('NODE_ENV')).toBe(true);
  });

  it('每个"无默认值"的变量都在 render.yaml 里声明了（漏配 = 部署后启动失败）', () => {
    const missing = REQUIRED_ENV_KEYS.filter((k) => !declaredKeys.has(k));
    expect(
      missing,
      `这些变量没有默认值、部署时却没配（本机 .env 里有，平台上没有 → 部署后才炸）：\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('render.yaml 里每个键都被配置层认得（拼错会被 zod 静默忽略）', () => {
    const unknown = [...declaredKeys].filter(
      (k) => !CONFIG_KEYS.includes(k) && PLATFORM_KEYS[k] === undefined,
    );
    expect(
      unknown,
      `这些键配置层不认识（zod 默认 strip 未知键 → 配了等于没配，且不报错）：\n${unknown.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * B1：生产**能不能上传**取决于这一个键在不在清单里。
   *
   * @why R2 适配器落地之后，生产仍然不上传的唯一原因就是"平台上没这个开关"：
   *      装配层看见 `STORAGE_DRIVER` 未配置 → `storage=null` → 上传 50000。
   *      这是**本机永远发现不了**的一类漏配（本机是 fs/memory），只有部署后运营录第一个
   *      商品时才暴露，而那时它长得像"上传功能坏了"。钉住键的存在，让它变成部署前的问题。
   * @why 同时要求四个 `R2_*` 都在：只声明开关而缺凭据是**更坏**的组合——
   *      config 跨字段规则 1d-2 会**拒绝启动**，失败形态是"服务起不来"，
   *      排查时最容易误判成代码问题。四个一起钉，等价于钉住"这个开关只能整体启用"。
   */
  it('必须声明 STORAGE_DRIVER 且四个 R2_* 同时声明（缺一 = 生产不能上传或启动被拒）', () => {
    expect(
      declaredKeys.has('STORAGE_DRIVER'),
      'render.yaml 缺 STORAGE_DRIVER：生产装配层会拿到 storage=null，商品图上传一律 50000',
    ).toBe(true);
    const missing = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
    ].filter((k) => !declaredKeys.has(k));
    expect(
      missing,
      `STORAGE_DRIVER 已声明，但缺这些凭据（config 规则 1d-2 会拒绝启动）：\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * B2：admin-web 的部署目标（此前"编译了但没有服务承载产物" ⇒ 运营进不去后台）。
   *
   * @why 形态断言而不是"存在性断言"：只断言 `waselect-admin` 存在的话，
   *      把 `runtime: static` 写成 `runtime: node`（平台会去 `npm start` 一个静态目录）
   *      或者把 `staticPublishPath` 指错目录（发布一个空站点）——两种都照样绿，
   *      上线后却不工作。四条一起钉，才等于"这个服务真的会发布 admin-web 的产物"。
   * @why SPA 回落那条单独钉：没有 `/* → /index.html` rewrite 时，
   *      根路径能开、深链接与刷新一律 404——表现为"点进去能用，刷新就白屏"，
   *      是最容易被误判成前端路由 bug 的一类部署缺口。
   * @measured(docs.render.com/blueprint-spec 与 deploy-create-react-app，2026-10-01)：
   *      静态站 = `runtime: static` + `staticPublishPath`；SPA 回落 = rewrite `/*` → `/index.html`。
   */
  it('admin-web 静态站：形态正确（runtime=static / 发布 dist / SPA 回落 / 构建带 --include=dev）', () => {
    expect(adminService, 'render.yaml 里找不到名为 waselect-admin 的服务').toBeDefined();
    const body = adminService?.body ?? '';
    expect(body).toMatch(/^\s*runtime:\s*static\s*$/m);
    expect(/^\s*staticPublishPath:\s*(\S+)/m.exec(body)?.[1]).toBe('./admin-web/dist');
    // SPA 回落：三个字段必须成套出现（少了 destination 就是"重写到自己"）
    expect(body).toMatch(/^\s*routes:\s*$/m);
    // ⚠️ 允许行尾注释：否则在 `- type: rewrite` 后面写一句说明就会让断言红，
    //    而那是"注释写得对、断言写得太严"——与 parseEnvEntries 只认裸 `- key: X` 不是一回事
    expect(body).toMatch(/^\s*-\s*type:\s*rewrite\s*(?:#.*)?$/m);
    expect(body).toMatch(/^\s*source:\s*\/\*\s*$/m);
    expect(body).toMatch(/^\s*destination:\s*\/index\.html\s*$/m);
    // 构建必须含 devDependencies：vite / tsx / tsc 全是 devDependencies
    expect(/^\s*buildCommand:\s*(.+)$/m.exec(body)?.[1]).toMatch(/npm ci --include=dev/);
    // 静态站不需要实例数/扩缩容（它不是常驻进程）；写上说明误当成 web 服务了
    expect(body).not.toMatch(/^\s*(numInstances|scaling):/m);
  });

  /**
   * @why `DEPLOY_TARGET` 是 admin-web 部署闸门的**唯一开关**（`scripts/assert-admin-deploy-env.ts`）。
   *      它不在服务端 schema 里（也不是平台变量），所以"键存在"这类断言救不了它——
   *      只有显式钉"这个服务上有它"，才防得住有人为了消掉一条构建告警把它删掉。
   *      删掉的后果是：`VITE_API_BASE_URL` 漏配时构建照样成功，产物里烤着 localhost。
   */
  it('admin-web 静态站声明了 DEPLOY_TARGET 与 VITE_API_BASE_URL（前者是部署闸门的开关）', () => {
    const body = adminService?.body ?? '';
    expect(body).toMatch(/^\s*-\s*key:\s*DEPLOY_TARGET\s*$/m);
    expect(body).toMatch(/^\s*-\s*key:\s*VITE_API_BASE_URL\s*$/m);
    // 密钥/域名不得写字面值（本文件进仓库）
    expect(body).not.toMatch(/-\s*key:\s*VITE_API_BASE_URL\s*\n\s*value:/);
  });

  it('解析器自检：服务块能按 `- type:` 切开、且互不越界（防"静态站断言读到 web 服务的字段"）', () => {
    // @why 上面两条全靠 parseServices。它一旦把块边界切错（例如把 cron 也算进 web），
    //      `staticPublishPath` 可能从别的服务里读到，断言就变成假绿灯。
    const sample = [
      'services:',
      '  - type: web',
      '    name: api',
      '    runtime: node',
      '  - type: cron',
      '    name: daily',
      '  - type: web',
      '    name: admin',
      '    runtime: static',
      '    staticPublishPath: ./dist',
      'databases:',
      '  - name: pg',
    ].join('\n');
    const parsed = parseServices(sample);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.body).toContain('name: api');
    expect(parsed[0]?.body).not.toContain('name: daily');
    expect(parsed[2]?.body).toContain('staticPublishPath: ./dist');
    expect(parsed[2]?.body).not.toContain('name: pg');
  });

  it('白名单里的键确实只属于平台（防止白名单写错而永久放水）', () => {
    for (const key of Object.keys(PLATFORM_KEYS)) {
      expect(declaredKeys.has(key), `${key} 已不在 render.yaml 里，白名单该删了`).toBe(true);
      expect(CONFIG_KEYS).not.toContain(key);
    }
  });

  it('NODE_ENV 必须显式写 production（schema 默认值是 development，漏配则生产校验全部不生效）', () => {
    // @why 这一条单独拎出来是因为它的失效形态特别隐蔽：
    //      服务**照样起得来、照样能下单**，只是 `crossField` 里所有 `isProd` 规则都不跑——
    //      https 要求、必填要求、CORS 要求全跳过。表现为"生产环境比预发宽松"，且没人会觉得是配置丢了。
    const entry = declared.find((e) => e.key === 'NODE_ENV');
    expect(entry).toBeDefined();
    expect(entry?.literal).toBe(true);
    expect(/^\s*value:\s*production\s*$/m.test(renderYaml)).toBe(true);
  });

  it('密钥类变量不得在 render.yaml 里写字面值（本文件进仓库，写了等于泄露）', () => {
    // ⚠️ 放宽成 `readonly string[]` 是**故意**的：`SECRET_KEYS` 是字面量元组（`as const`），
    //    用它去 `.includes()` 一个 `string` 是类型错误——但这里要查的是"任意键是不是密钥"，
    //    本来就是运行时判断。元组类型保护的是"新增密钥必须写进名单"那一侧，不是这一侧。
    const secretKeys: readonly string[] = SECRET_KEYS;
    const leaked = declared
      .filter((e) => secretKeys.includes(e.key) && e.literal)
      .map((e) => e.key);
    expect(
      leaked,
      `这些是密钥，却带了字面 value（应改成 sync: false 并在控制台填）：\n${leaked.join('\n')}`,
    ).toEqual([]);
  });

  it('databases 段：键名都在 Blueprint 规范内，且显式钉住 Postgres 大版本（三审 P2-1）', () => {
    expect(databases.length).toBeGreaterThan(0);
    for (const db of databases) {
      const unknown = [...db.keys.keys()].filter((k) => !DATABASE_KEYS.has(k));
      expect(
        unknown,
        `databases[${db.keys.get('name')}] 有规范外的键（平台会静默忽略）：${unknown.join(', ')}`,
      ).toEqual([]);
      // 大版本必须显式写、且写成带引号的字符串（规范类型是 string；裸数字 16 会被 YAML 解析成整数）
      expect(db.keys.get('postgresMajorVersion')).toMatch(/^'(1[6-9]|[2-9]\d)'$/);
    }
  });

  it('服务与数据库都不得用免费档 / 规范外档位名（冷启动会让支付回调超时；数据库 30 天过期）', () => {
    // @why `starter` 曾在本文件里写了两处——它不是 Blueprint 的档位名，平台会拒绝或回落。
    //      合法值形如 `0.5c-512mb`（web）/ `0.5c-1g`（db）；只校验形状，不校验价格是否合理。
    const plans = [...renderYaml.matchAll(/^\s*plan:\s*(\S+)/gm)].map((m) => m[1] as string);
    expect(plans.length).toBeGreaterThanOrEqual(2);
    for (const p of plans) expect(p).toMatch(/^\d+(\.\d+)?c-\d+(mb|g)$/);
  });

  it('web 服务：构建必须显式装 devDependencies，且发布前有迁移步骤（全量审计 P1）', () => {
    // @why NODE_ENV=production 被注入到构建期，npm 默认 omit=dev（@measured 见 render.yaml 注释）；
    //      迁移此前没有任何生产执行点——两条都是"服务能起来、第一次请求才炸"的形态，只能靠清单钉住。
    const build = /^\s*buildCommand:\s*(.+)$/m.exec(renderYaml)?.[1] ?? '';
    expect(build).toMatch(/npm ci --include=dev/);
    const pre = /^\s*preDeployCommand:\s*(.+)$/m.exec(renderYaml)?.[1] ?? '';
    expect(pre).toMatch(/npm run db:migrate/);
  });

  it('web 服务固定单实例 numInstances: 1（F-07 / AJ-183：三处进程内状态依赖它）', () => {
    /**
     * @why 下面三处都只在**单进程**里成立，扩成多实例不会报任何错，只会静默失效：
     *      ① 限流计数（rate-limit-memory.ts）：每个实例各数各的，5 次/15 分钟变成 5×N 次；
     *      ② 身份缓存与拉黑即时作废（identity.ts withIdentityCache / invalidate）：只作废本实例，
     *         被拉黑者在其它实例上继续用最多 60 秒；
     *      ③ 常驻调度器（D-43）：每个实例一个空转调度器抢同一把锁。
     *      这条断言让"改 numInstances"先在 CI 红——逼人先把这三处换成共享实现，而不是扩了才发现。
     */
    const web =
      /^\s*-\s*type:\s*web\s*$([\s\S]*?)(?=^\s*-\s*type:|^\S)/m.exec(renderYaml)?.[1] ?? '';
    expect(web).not.toBe('');
    expect(/^\s*numInstances:\s*(\d+)/m.exec(web)?.[1]).toBe('1');
    expect(web).not.toMatch(/^\s*scaling:/m); // 自动扩缩容同样会破坏上面三处前提
  });

  it('每日作业：声明了 cron 服务调 /api/v1/internal/jobs/daily，密钥与内网地址取自 web 服务（一致性审计 C1，AJ-176）', () => {
    // @why 技术文档 §6.1 / 工程框架文档 / D-43③ 都写"Render Cron Job 调 POST /internal/jobs/daily"，
    //      但本清单只有 web + db：生产上每日对账（含调度心跳看门狗、卡住的回调 KD-2）**永不执行**，
    //      而 0.5.4 起 /healthz 已不再承担看门狗——tick 停摆将没有任何告警。
    const cron =
      /^\s*-\s*type:\s*cron\s*$([\s\S]*?)(?=^\s*-\s*type:|^\S)/m.exec(renderYaml)?.[1] ?? '';
    expect(cron).not.toBe('');
    expect(cron).toMatch(/^\s*schedule:\s*'[^']+'/m);
    expect(cron).toMatch(/\/api\/v1\/internal\/jobs\/daily/);
    expect(cron).toMatch(/x-internal-job-secret/i);
    // 密钥不写字面值：取 web 服务同名变量（fromService），且与 web 同区域（内网只在同区域可达）
    expect(cron).toMatch(/-\s*key:\s*INTERNAL_JOB_SECRET\s*\n\s*fromService:/);
    expect(cron).toMatch(/property:\s*hostport/);
    expect(cron).toMatch(/^\s*region:\s*oregon/m);
  });

  it('生产库名必须与开发默认库名不同，且含 prod（全量审查 B31：同名会让 seed 闸门②永不触发）', () => {
    /**
     * @why 2026-09-29 全量审查 B31：`render.yaml` 的 `databaseName: japan_shop` 与
     *      `scripts/seed-lib.ts` 的 `defaultDevUrl()` **同名**。后果是两道闸门同时失效：
     *      · 闸门①只挡"非 localhost"，而"把生产库端口转发到 localhost:15432"是排查生产问题
     *        时的**常规操作**，转发之后 host 就是 localhost，闸门①放行；
     *      · 闸门②"库名含 prod 就拒"因为库名里没有 prod，**永远不触发**。
     *      于是 `npm run db:seed`（默认 TRUNCATE 全部业务表）对着生产库跑，数据不可逆丢失，
     *      而 `order_events` / `admin_audit` 的 append-only 触发器挡不住 TRUNCATE。
     * @why 判据要同时钉"不同名"与"含 prod"两条：只钉"不同名"的话，有人改成
     *      `japan_shop_2` 也能绿，而闸门②照样不触发——两条一起才等于"闸门②真的能拦"。
     * @limitation 这条只能守住"名字"这一层，守不住"有人手动给了 `--allow-remote`"
     *      （那需要交互确认，见 seed-lib.ts @limitation 三）。纵深防御靠那里的**内容闸门**。
     */
    const prodName = databases[0]?.keys.get('databaseName') ?? '';
    expect(prodName, 'databases[0] 解析不出 databaseName（解析器坏了或键名改了）').not.toBe('');
    expect(prodName).not.toBe('japan_shop');
    expect(prodName).toMatch(/prod/i);
  });

  it('解析器自检：databases 段解析出键值且不吃注释、不越段', () => {
    const sample = [
      'services:',
      '  - type: web',
      '    plan: 0.5c-512mb',
      'databases:',
      '  - name: pg-a',
      '    region: oregon # 注释里的 plan: free 不该被读到',
      '    # plan: starter',
      "    postgresMajorVersion: '16'",
      '  - name: pg-b',
      '    plan: 0.5c-1g',
      'other:',
      '  - name: not-a-db',
    ].join('\n');
    const parsed = parseDatabases(sample);
    expect(parsed.map((d) => [...d.keys.entries()])).toEqual([
      [
        ['name', 'pg-a'],
        ['region', 'oregon'],
        ['postgresMajorVersion', "'16'"],
      ],
      [
        ['name', 'pg-b'],
        ['plan', '0.5c-1g'],
      ],
    ]);
  });

  it('解析器自检：键、字面值标记、段落边界都解析正确（防"解析器坏了 → 全绿"）', () => {
    // @why 上面六条全部依赖 parseEnvEntries。它一旦写坏（或 YAML 换了写法），
    //      最可能的后果不是报错，而是**扫出空集合 → 所有断言永真**。
    //      所以必须对解析器本身做一次红灯能力验证。
    const sample = [
      'services:',
      '  - type: web',
      '    envVars:',
      '      - key: NODE_ENV',
      '        value: production',
      '      - key: JWT_SECRET',
      '        sync: false',
      '      - key: DATABASE_URL',
      '        fromDatabase:',
      '          name: waselect-pg',
      'databases:',
      '  - name: waselect-pg',
      '      - key: NOT_IN_ENV_SECTION',
      '        value: should-not-appear',
    ].join('\n');
    const parsed = parseEnvEntries(sample);
    expect(parsed.map((e) => e.key)).toEqual(['NODE_ENV', 'JWT_SECRET', 'DATABASE_URL']);
    expect(parsed.map((e) => e.literal)).toEqual([true, false, false]);
  });
});
