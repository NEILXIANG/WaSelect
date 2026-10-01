/**
 * 职责：管理端写接口的**操作审计中间件**（流 B，ADR-29；F-02 / AJ-183）——挂在 `/api/v1/admin` 前缀上，
 *       对每一次**成功的**管理端写操作（POST / PUT / PATCH / DELETE → 2xx）往 `admin_audit` 追加一行。
 *
 * @why 一个入口覆盖全部管理端写接口（而不是每条路由各写一行 insert）：
 *      ① 新增一条管理端写路由**自动**被审计，不靠"记得去写"——漏写审计不会报任何错，只会在出事那天查不到；
 *      ② 审计的形状（actor / action / target / 脱敏）只有一份实现，不会在第二份里漂移。
 * @why 在响应 **`prefinish`** 之后写（不是 `finish`）、只写 2xx：此时业务事务已提交，
 *      "有审计行"⇔"改动真的发生了"；4xx / 5xx 不写（没有发生的改动不该出现在审计里；失败原因在运行日志里）。
 *      ⚠️ `finish` 是"响应已交给操作系统"的意思：客户端在**业务已提交之后**断开（管理员关页签、
 *      网络断开、Cloudflare 524）时它**不触发**（B15 / AJ-206）。退款要同步调 Stripe（最长约 6 秒），
 *      这正是它最容易发生的场景——钱已经退了，审计里却一行都没有，而审计是 append-only、
 *      事后补不回来。`prefinish` 在 `end()` 之后立即触发，与客户端死活无关。
 * @why **刻意不再挂 `close` 兜底**（与访问日志不同，见 http.ts）：审计的前提是"业务已提交且回了 2xx"，
 *      而"回了 2xx"必然经过 `end()` ⇒ `prefinish` 必然触发，与客户端死活无关——没有需要兜的洞。
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
 *      不需要改任何一条路由的事务边界。反过来的错误（审计了但没改）不会发生（只写 2xx）。
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

/** 路由提供"改前值"（只对不可逆操作用，见文件头 @why）。 */
export function setAuditBefore(res: Response, before: unknown): void {
  res.locals[AUDIT_BEFORE_KEY] = before;
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
    // 上下文在进入时取（prefinish 回调不保证还在同一条异步链上）
    const { trace_id: traceId, req_id: reqId } = currentContext();

    res.on('prefinish', () => {
      const principal = req.auth;
      const routePath = (req.route as { path?: unknown } | undefined)?.path;
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      if (principal?.role !== 'admin' || typeof routePath !== 'string') return;
      // 路由显式声明"这次没有改动发生"（OPS3-08；@see skipAudit 的 @why）
      if (res.locals[AUDIT_SKIP_KEY] === true) return;
      const id = req.params['id'];
      const entry = {
        actor: `admin:${principal.sub}`,
        action: `${req.method} ${routePath.replace(/^\/api\/v1/, '')}`,
        target: typeof id === 'string' ? id : null,
        before: res.locals[AUDIT_BEFORE_KEY],
        after: auditPayload(req.body),
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
    });
    next();
  };
}
