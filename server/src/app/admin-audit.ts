/**
 * 职责：管理端写接口的**操作审计中间件**（流 B，ADR-29；F-02 / AJ-183）——挂在 `/api/v1/admin` 前缀上，
 *       对每一次**成功的**管理端写操作（POST / PUT / PATCH / DELETE → 2xx）往 `admin_audit` 追加一行。
 *
 * @why 一个入口覆盖全部管理端写接口（而不是每条路由各写一行 insert）：
 *      ① 新增一条管理端写路由**自动**被审计，不靠"记得去写"——漏写审计不会报任何错，只会在出事那天查不到；
 *      ② 审计的形状（actor / action / target / 脱敏）只有一份实现，不会在第二份里漂移。
 * @why 在响应 **`prefinish`** 之后写（不是 `finish`）：此时业务事务已提交，
 *      "有审计行"⇔"改动真的发生了"。
 *      ⚠️ `finish` 是"响应已交给操作系统"的意思：客户端在**业务已提交之后**断开（管理员关页签、
 *      网络断开、Cloudflare 524）时它**不触发**（B15 / AJ-206）。退款要同步调 Stripe（最长约 6 秒），
 *      这正是它最容易发生的场景——钱已经退了，审计里却一行都没有，而审计是 append-only、
 *      事后补不回来。`prefinish` 在 `end()` 之后立即触发，与客户端死活无关。
 *      ⚠️⚠️ 但 `prefinish` 也**不是**必然触发（SEC2-03，2026-10-03 补）：
 *          同一连接上**管线化**的第二个请求、在第一个响应写完之前连接断开时，
 *          handler 照常 `res.json()`，但那个 response 从未拿到 socket，
 *          `prefinish` / `finish` / `close` 一个都不触发。所以本中间件**另外**包了一层 `res.end`
 *          作兜底（调用 `end()` 与 socket 是否就位无关），两条路径由 `fired` 保证只写一次。
 *          旧注释曾写"必然经过 `end()` ⇒ `prefinish` 必然触发，没有需要兜的洞"——那是错的。
 * @why 只写 2xx —— **除**路由显式调用 `markAuditCommitted` 声明"改动已提交"的那些（SEC2-02）：
 *      两段式写操作（退款）第一段事务提交后、第二段调机构失败 ⇒ 回 5xx 但改动已发生，
 *      那种请求必须留痕；落库时把最终状态码写进 `status_code`（迁移 025）以区分"成了/没成"。
 *      普通 4xx / 5xx 不写（没有发生的改动不该出现在审计里；失败原因在运行日志里）。
 * @why **刻意不再挂 `close` 兜底**（与访问日志不同，见 http.ts）：
 *      ⚠️ 本条**原来**写的是"审计的前提是'业务已提交且回了 2xx'，而'回了 2xx'必然经过 `end()`
 *      ⇒ `prefinish` 必然触发，与客户端死活无关——没有需要兜的洞"。**前提对，结论错**（SEC2-03）：
 *      `end()` 确实必然经过，但 `prefinish` 是**事件**，依赖 socket（见上面那段 ⚠️⚠️）；
 *      "必然经过 `end()`"能推出的是"`end()` 兜底必然生效"，推不出"`prefinish` 必然触发"。
 *      反过来，若 handler 真的没跑到 `end()`（卡住、崩溃），那本来就没有"已发生的改动"可审。
 *      @measured 实测：客户端在 50ms 断开、handler 200ms 后 `res.json()`，
 *      `close` 在 50ms 就触发（此时 statusCode 还是默认的 200、路由与身份都已就位），
 *      挂 `close` 会对每一次"退款成功但管理员关了页签"**误报一次 error**——
 *      那恰恰是本条最想覆盖的场景，误报等于把真信号淹掉。
 * @why action 用**路由模板**（`PATCH /admin/products/:id/status`）而不是实际路径：按动作检索
 *      （"谁改过价"）不必做字符串模式匹配；具体对象在 target。
 * @why after = 请求体（脱敏后）：它就是管理员"要把它改成什么"。before 只有路由**显式**提供时才有
 *      （setAuditBefore）：取改前值要额外读库，只对**不可逆**的操作做（运费整表替换、汇率追加）。
 * @tradeoff 审计写入**不与业务同事务**：极少数情况下（库在两次写之间断开）会出现"改了但没审计"，
 *      这时打 error 级 `admin_audit_write_failed`（带 action / target）让它可见。换来的是零侵入：
 *      不需要改任何一条路由的事务边界。
 *      ⚠️ 反过来的错误（审计了但没改）**曾经**靠"只写 2xx"保证不发生；SEC2-02 之后这条要写得精确：
 *      非 2xx 也会写，但**只**写那些路由显式声明了"改动已提交"的（`markAuditCommitted`），
 *      且把最终状态码一起落库（`status_code`）。于是"审计了但没改"仍然不会发生——
 *      写了审计就一定有已提交的改动——而"改了、但后续步骤失败"这一类也不再丢。
 * @why 写入虽然是"发出去不管"，但要**登记为在途作业**（OPS3-05 / AJ-274）。
 *      @why 它落在响应之后，而 `server.close()` 的排空只认"响应已 end"——请求算结束了，
 *      审计的 insert 可能还在路上。这一段窗口里进程一旦往下走（关连接池），这一行就永久丢失；
 *      而 `admin_audit` 是 append-only，事后补不回来。文件头 @why 担心的是
 *      "客户端断开 ⇒ 钱退了却没审计"，**服务端这一侧同样成立**，只是概率低到平时看不见。
 *      @limitation 登记**不改变**"审计可能晚于响应"这件事：客户端拿到 200 时不保证审计已落库
 *      （要那个保证就得让每个写接口多等一次库往返，代价与"审计失败该不该让请求失败"的
 *      两难一起进来）。这里补的是"进程别在这段窗口里退出"，不是"响应前必须落库"。
 * @limitation 一：登录（/auth/admin/login）不在 /admin 前缀下，不进本表——登录成败在运行日志（admin_login_*）。
 * @limitation 二：multipart 上传的请求体不是 JSON，after 记为 null（上传结果的 key 在运行日志里）。
 * @limitation 三：脱敏**直接复用 `redact.ts`**（全库唯一实现），本模块**没有**自己的键名清单。
 *      `before` 与 `after` **都**走 `auditPayload`（AJ-294）：脱敏只放在**唯一落库点**（中间件里），
 *      不在 `setAuditBefore` 里再脱一次——`redact` 对 `pii-name` 类是 `` `${value[0]}***` ``（保留首字母），
 *      **不幂等**，重复调用会让 `'***'` 变成 `'****'` 并随次数增长。
 *              曾经另起一份 `PII_KEYS`（7 个键名，B16 / AJ-207），于是 `postal_code` / `openid` /
 *              `api_key` / `token` 全部**原样**落进 append-only 的审计表——改一次址就把买家 ZIP+4
 *              永久写进去，而这张表没有保留期、触发器拒 UPDATE/DELETE，APPI/CCPA 的删除请求无法兑现。
 *              名单制唯一的维护方式是"在 redact.ts 里加词 + 加断言"（redact.ts 文件头 @limitation 一），
 *              第二份清单必然漂移（约束九）。
 * @limitation 四：自由文本（退款理由 `reason`、备注）只能靠 redact 的**文本层**（邮箱 / 国际电话 /
 *              openid / 凭证形状 / 卡号），按键名脱敏管不到字符串内部；长文本里的地址行仍会原样落库。
 *              这是"审计要留痕"与"审计不可删"之间的已知缺口：**理由与备注不写 PII** 是操作规范层面的要求。
 *
 * @see ports/admin-audit.ts；adapters/admin-audit.ts；migrations/002_hardening.sql（表 + append-only 触发器）；
 *      app/inflight-jobs.ts（OPS3-05：审计写入的等待方）；docs/自主决策记录.md AJ-274
 */
import type { RequestHandler, Response } from 'express';
import type { Logger } from '../logger.js';
import type { AdminAuditStore } from '../ports/admin-audit.js';
import type { InflightJobs } from './inflight-jobs.js';
import { currentContext } from '../context.js';
import { redact } from '../redact.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUDIT_BEFORE_KEY = 'adminAuditBefore';
const AUDIT_SKIP_KEY = 'adminAuditSkip';
const AUDIT_COMMITTED_KEY = 'adminAuditCommitted';
const AUDIT_TARGET_KEY = 'adminAuditTarget';
const AUDIT_AFTER_KEY = 'adminAuditAfter';

/** 路由提供"改前值"（只对不可逆操作用，见文件头 @why）。 */
export function setAuditBefore(res: Response, before: unknown): void {
  res.locals[AUDIT_BEFORE_KEY] = before;
}

/**
 * 路由**显式**提供审计的 after（AJ-401）；不调用时 after = 请求体（文件头 @why 的默认口径）。
 *
 * @why 批量写（`POST /admin/orders/ship-batch`）允许部分成功：请求体是"要发哪些"，
 *      而审计要回答的是"**发成了哪些**"。照默认记请求体，一行失败的单也会以"已发货"的面目
 *      永久留在 append-only 的表里——事后回溯会把失败读成成功（与 markAuditCommitted 防的是同一个方向）。
 * @why 同样走唯一落库点的 {@link auditPayload}（不在这里脱敏，理由见 @limitation 三：redact 不幂等）。
 * @limitation 只给"结果与请求不是同一件事"的路由用；普通单对象写操作请求体就是事实，不必调。
 */
export function setAuditAfter(res: Response, after: unknown): void {
  res.locals[AUDIT_AFTER_KEY] = after;
}

/**
 * 路由**显式**声明"这次操作的对象是谁"（SEC-12 / AJ-344）。
 *
 * @why target 默认取路径里的 `:id`，而**新建**类写操作没有 `:id`——建商品、建 Banner、
 *      上传图片、追加汇率，它们的审计行 target 一律是 NULL。
 *      后果是这些行**只能回答"谁在什么时候建了东西"，回答不了"建了什么"**：
 *      想查"这个商品是谁建的 / 什么时候建的"必须去别的表按时间猜，
 *      而审计表存在的唯一理由就是不用猜。
 * @why 由路由在**拿到新对象标识之后**声明（不是之前）：对象标识是服务端生成的，
 *      声明早了只能写"打算建"，而"打算建"不是审计该记的东西（见 markAuditCommitted 的同一条理由）。
 * @limitation 优先级**高于**路径 `:id`（`res.locals[AUDIT_TARGET_KEY] ?? targetId ?? null`）：
 *      两者同时存在时以显式声明为准——路径 id 是"路由的形状"，显式声明是"这次操作实际动了什么"。
 */
export function setAuditTarget(res: Response, target: string): void {
  res.locals[AUDIT_TARGET_KEY] = target;
}

/**
 * 路由**显式**声明"这次改动**已经提交**，即使最后回的不是 2xx 也要写审计"（SEC2-02 / AJ-339）。
 *
 * @why 两段式写操作打破了"只写 2xx"那条等价关系：管理端退款的第一段事务把订单迁到
 *      `refunding` 并**提交**，第二段调机构，超时 / 结果未知时抛 5xx。
 *      于是最需要留痕的那一次退款（"钱可能已经退了、我们不知道"）在 `admin_audit` 里
 *      **一行都没有**，而管理员若不再重试，这一行永远不会补上（表是 append-only）。
 * @why 做成显式声明而不是"5xx 也写"：后者的等价关系变成"有审计行 ⇔ 有人点了一次"，
 *      于是"审计了但没做成"这个**更坏**的方向被打开——事后回溯会把失败读成成功。
 *      声明了已提交的请求才写，且把最终状态码一起记进 `status_code`（迁移 025），
 *      两种情形在同一张表里可区分，且都不丢。
 * @why 由路由在**事务提交之后**调用（不是之前）：它是"改动已发生"的证据，
 *      调用点必须能证明这一点；放在事务里等于声明了一件可能回滚的事。
 */
export function markAuditCommitted(res: Response): void {
  res.locals[AUDIT_COMMITTED_KEY] = true;
}

/**
 * 路由**显式**声明"这次 2xx 没有改动发生，不要写审计"（OPS3-08）。
 *
 * @why 文件头那条等价关系（有审计行 ⇔ 改动真的发生了）在**幂等写**上会被打破：
 *      `DELETE /admin/banners/{id}` 对不存在的 id 也回 204（幂等，@limitation 二），
 *      于是"双击删除"会留下**两行**审计，而第二行声称的删除**根本没有发生**——
 *      事后按审计回溯"什么时候删的、删了什么"，会数出两次删除。
 *      审计是 append-only（触发器拒 UPDATE/DELETE），写进去就删不掉，所以只能不写。
 * @why 做成显式的"跳过"而不是让中间件去猜（比如"before 为 null 就不写"）：
 *      猜会让"真的删了但改前值取不到"这种情况**静默丢一行审计**——
 *      而那正是最需要留痕的一类（删了什么说不清）。跳过必须是路由明说的。
 */
export function skipAudit(res: Response): void {
  res.locals[AUDIT_SKIP_KEY] = true;
}

/**
 * 请求体 → 审计 after：整值走 {@link redact}（全库唯一的脱敏实现）；非对象 → null。
 *
 * @why 不再自己判键名（B16 / AJ-207）：自己判就得自己维护一份名单，
 *      而这张表**删不掉**（append-only 触发器），漏一个键名就是永久事故。
 * @limitation `redact` 面向日志设计，掩码口径（IDENTIFIER 保留尾 4 位 / URL 保留 origin+路径）
 *      比"整值 `[redacted]`"更宽松——审计表同样满足"不可反推个人"，且保住了排障要的关联线索。
 */
export function auditPayload(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return null;
  return redact(body);
}

export function adminAuditMiddleware(deps: {
  store: AdminAuditStore;
  logger: Logger;
  /** 在途作业登记表（OPS3-05）：审计写在响应之后，必须让停机排空等得到它（文件头 @why）。 */
  jobs: InflightJobs;
}): RequestHandler {
  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) {
      next();
      return;
    }
    // 上下文在进入时取（写审计的回调不保证还在同一条异步链上）
    const { trace_id: traceId, req_id: reqId } = currentContext();

    /**
     * 审计行的 target（路径里的 `id`）——**必须在 `next()` 返回后立刻取快照**，
     * 不能在写审计的回调里现取（SEC2-02 附带发现，AJ-341）。
     *
     * @why router 在派发结束时把 `req.params` **还原**成上一层的值
     *      （router@2.2.0 `index.js`：`restore(callback, req, 'baseUrl', 'next', 'params')`），
     *      而**错误**路径上还原先于最终响应：`next(err)` 冒泡出这一层 router 之后才由上层
     *      处理并 `res.end()` ⇒ 那时读 `req.params['id']` 是 `undefined`，审计行落库成
     *      target = NULL。成功的路径读得到（async handler 那条分支不调用 `next`，
     *      还原根本不发生）——这正是它一直没人发现的原因：**只有失败的写操作才丢 target**，
     *      而 SEC2-02 之前失败根本不写审计。
     * @why 丢了 target 的审计行几乎没法用：能查出"谁在什么时候点过退款"，
     *      查不出**退的是哪一单**——而后者才是退款审计唯一要回答的问题。
     * @why 快照取在 `next()` 返回**之后**（不是之前）：此刻 Express 已同步走到匹配上的那条路由，
     *      而路由层是在**调用 handler 之前**写 `req.params` 的，所以拿得到最终值；
     *      若响应在这一步之内就发完了，writeAudit 已经先跑过一次并写下了快照，这里不再改它
     *      （`undefined` 的判断就是"还没取过"）。
     * @limitation 只快照 `id`：本中间件能写进 target 的只有路径参数，而全库管理端路由
     *      的路径参数一律叫 `id`（路由模板已经在 action 里，两者合起来才定位到一次操作）。
     */
    let targetId: string | null | undefined;
    const captureTarget = (): void => {
      if (targetId !== undefined) return;
      const id = req.params['id'];
      targetId = typeof id === 'string' ? id : null;
    };

    /** 只跑一次：`prefinish` 与下面的 `end` 兜底是同一件事的两条路径（SEC2-03）。 */
    let fired = false;
    const writeAudit = (): void => {
      if (fired) return;
      captureTarget();
      const principal = req.auth;
      const routePath = (req.route as { path?: unknown } | undefined)?.path;
      // 2xx ⇒ 写；非 2xx ⇒ 只有路由显式声明"改动已提交"才写（SEC2-02 / AJ-339）
      const committed = res.locals[AUDIT_COMMITTED_KEY] === true;
      if (!committed && (res.statusCode < 200 || res.statusCode >= 300)) return;
      if (principal?.role !== 'admin' || typeof routePath !== 'string') return;
      // 路由显式声明"这次没有改动发生"（OPS3-08；@see skipAudit 的 @why）
      if (res.locals[AUDIT_SKIP_KEY] === true) return;
      fired = true;
      const entry = {
        actor: `admin:${principal.sub}`,
        action: `${req.method} ${routePath.replace(/^\/api\/v1/, '')}`,
        // 显式声明（新建类操作）优先于路径 id；后者用快照而不是现取 `req.params`
        // （错误路径上它已经被还原成空，见 captureTarget 的 @why）
        target: (res.locals[AUDIT_TARGET_KEY] as string | undefined) ?? targetId ?? null,
        // AJ-294：before 与 after **同口径**走 redact。这里是唯一落库点——
        // 路由给什么就存什么的话，将来任何一条"改订单"路由传进来的 address_snapshot
        // 会永久锁进 append-only 表（AJ-207 踩过同一个洞，只是当时在 after 上）。
        before: auditPayload(res.locals[AUDIT_BEFORE_KEY]),
        // AJ-401：路由显式给了 after（批量写的逐单结果）就记它，否则记请求体
        after: auditPayload(AUDIT_AFTER_KEY in res.locals ? res.locals[AUDIT_AFTER_KEY] : req.body),
        // SEC2-02：把最终状态码一起落库——"提交了但后续失败"与"成功"必须能在同一张表里分开，
        // 否则审计会把一次失败的退款说成成功的（那是比没有审计更坏的方向）。
        statusCode: res.statusCode,
        traceId: traceId ?? null,
        reqId: reqId ?? null,
      };
      // ⚠️ 不是"发出去不管"：`run()` 把这条 insert 登记进在途表，停机的排空会等它（AJ-274）。
      void deps.jobs.run('admin_audit', deps.store.append(entry)).catch((e: unknown) => {
        deps.logger.error('admin_audit_write_failed', {
          result: 'failed',
          err: e,
          ctx: { action: entry.action, target: entry.target },
        });
      });
    };

    res.on('prefinish', writeAudit);
    /**
     * ⚠️ `end()` 兜底（SEC2-03）：文件头曾经写"`prefinish` 必然触发，与客户端死活无关
     *    ——没有需要兜的洞"，**这句话是错的**。实测（express 5.2.1 / Node 25.3 探针）：
     *    同一连接上**管线化**的第二个请求，在第一个响应写完之前连接断开时，
     *    handler 照常执行 `res.json()`，但它的 response 从未拿到 socket，
     *    `prefinish` / `finish` / `close` **一个都不触发** ⇒ 业务已提交、审计无行、访问日志也无行。
     *    经反代时一般不会把管线化透传到源站（生产大概触发不了），
     *    但它是"持有管理员 token 的人想做一次不留痕的写操作"的可构造路径。
     * @why 兜底挂在 `end()` 而不是再加一个事件：调用 `end()` 这件事与 socket 是否就位**无关**，
     *      而任何"响应已写完"的事件都依赖 socket。`fired` 保证两条路径只写一次。
     */
    const originalEnd = res.end.bind(res);
    res.end = ((...args: Parameters<typeof originalEnd>) => {
      const out = originalEnd(...args);
      writeAudit();
      return out;
    }) as typeof res.end;

    next();
    // ⚠️ 同步派发已经走完（路由层写 `req.params` 在调用 handler 之前）⇒ 这里拿得到最终值；
    //    再晚一步（错误路径上 `next(err)` 冒泡出去之后）就被还原成空了（captureTarget @why）。
    captureTarget();
  };
}
