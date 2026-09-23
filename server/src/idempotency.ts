/**
 * 职责：幂等执行器（F8）——同一个 Idempotency-Key 只真正执行一次，重放返回首次结果。
 * 边界：只管"执行一次"这件事；key 从哪个头来、哪些路由需要幂等，由路由层决定。
 * 两种模式：**单事务**（{@link withIdempotencyTx}，handler 只做 DB 写入，首选）
 * 与**非事务**（{@link withIdempotency}，handler 含外部副作用时用）。
 *
 * @why 支付链路里重试是常态：网络抖动、用户狂点、前端超时重发。
 *      没有幂等，一次"用户以为没成功"的重试就会建出第二张单、扣第二次款——
 *      跨境场景下退款要跨机构、跨币种，纠错成本远高于下单时多写几十行代码。
 *
 * @limitation 一：并发靠**唯一约束抢占位**（status_code=0 的占位行）而不是分布式锁。
 *              第二个请求进来时若占位行还在且未完成，它只能"轮询等结果"；等不到就返回 40903。
 *              后果：极慢的首次请求（超过 `waitMs`）会让并发的第二次拿到 40903 而不是结果——
 *              这是刻意的：宁可让前端明确提示"处理中"，也不要让它重复下单。
 * @limitation 二：handler 抛错时会**删掉占位行**，让同 key 可以重试。
 *              代价：如果 handler 已经产生了副作用（比如已调通支付机构）才抛错，重试会造成重复调用。
 *              约定：handler 必须自身可重入（用 provider 侧的幂等键），本层只保证"不留下毒记录"。
 * @limitation 三：`response` 存 JSONB，因此 handler 的返回必须是可序列化对象（不能是流/函数）。
 * @limitation 四：**租约到期后的接管不保证"原持有者已经死了"**（D3 的固有代价）。
 *              若首次请求只是慢（而非崩溃），租约一到第二个请求就会接管并**再执行一次** handler。
 *              这是"永久卡死"与"偶发重复"之间的取舍：前者必然发生且不可逆，后者只在
 *              "handler 超过租约时长"时才发生，且可以通过把租约设得比 handler 的最坏耗时更长来避免。
 *              真要杜绝仍需 handler 自身可重入（同 @limitation 二）。
 *              缓解手段有两层，都已实现：① 续期（活着的 handler 每 leaseMs/3 刷新租约，
 *              把"慢"和"死"区分开）；② 栅栏令牌（lease_token，接管后旧持有者的写/删 0 行命中，
 *              落 `idempotency_lease_lost` error 日志——二审 N1：曾按 key 定位删掉新持有者的占位）。
 *
 * @tradeoff 用数据库行而不是 Redis：多一个 DB 往返，换来零额外组件（Render 上没有托管 Redis）。
 *           过期清理交给调度器（idempotency_keys.created_at 24h），不在此处做 TTL。
 *
 * @see 技术文档 v0.5 §3（idempotency_keys）；docs/地基搭建清单.md F8；D-29；评审 D3/D4；
 *      docs/二审意见甄别报告-2026-09-23.md §1 N1（栅栏令牌）/ N2（单事务模式）；
 *      migrations/004_idempotency_fencing.sql
 */
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { withTransaction, type Db } from './db.js';
import type { Logger } from './logger.js';

/** 占位行的状态码：0 表示"抢到了但还没执行完"，不是真实 HTTP 状态。 */
const PENDING_STATUS_CODE = 0;

/**
 * 占位行的**租约时长**（毫秒）：超过这个时间还没完成的占位，允许被下一个请求接管。
 *
 * @why 没有租约时，进程在"抢到占位之后、写回结果之前"崩溃，那行就永远停在占位态——
 *      同一个幂等键**永久**返回 40903，用户再也下不了这一单（复现缺陷 D3）。
 *      崩溃在小内存实例上是常态（OOM、平台重启、部署），所以这不是理论风险。
 * @why 30 秒而不是更短：必须显著大于 handler 的最坏耗时（下单含运费计算 + 建单 + 写事件，
 *      正常 <1s，最坏几秒）。租约短于 handler 耗时会触发"接管 → 重复执行"这一坏事
 *      （见 @limitation 四），所以宁长勿短。
 */
export const DEFAULT_LEASE_MS = 30_000;

/**
 * 稳定序列化：对象键按字典序排列。
 * @why 直接用 `JSON.stringify` 会让**键顺序不同但内容相同**的两个请求算出不同指纹，
 *      于是"客户端复用幂等键"这个真 bug 抓不到，反而会在正常重放时误报 40908。
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * 请求指纹：任意可序列化入参 → 64 位十六进制串。
 * @why 幂等键只回答"是不是同一件事的重复提交"，回答不了"是不是**同一件事**"（D4）。
 *      客户端复用键（bug 或刻意）时，若不比对内容就直接返回首次结果，
 *      用户会以为自己下了第二单——而实际上第二单从未创建，钱也没收。
 *      这种"静默成功"比报错危险得多：它在日志里长得跟正常重放一模一样。
 */
export function requestFingerprint(payload: unknown): string {
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}

export interface IdempotencyArgs {
  /** 幂等键（服务端按 `user_id + route + 客户端 key` 作用域拼接后传入）。 */
  key: string;
  userId?: string | undefined;
  route: string;
  /**
   * 参与指纹的请求素材（通常是 body，含影响结果的关键 query）。
   * @why 不传就**不做指纹校验**——给"确实没有入参"的接口留口子，
   *      但默认应该是传：不传等于放弃 D4 那层保护。
   */
  request?: unknown;
  /** 并发时等待首次结果的时长（毫秒，默认 2000）。 */
  waitMs?: number;
  /** 轮询间隔（毫秒，默认 50）。 */
  pollMs?: number;
  /** 占位租约时长（毫秒，默认 {@link DEFAULT_LEASE_MS}）。测试里设短值来验证接管。 */
  leaseMs?: number;
  /**
   * 租约续期开关（默认开）。handler 执行期间每 `leaseMs/3` 刷新一次 `locked_until`，
   * 把"慢"和"死"区分开：活着的 handler 不会被接管，死掉的才轮到别人。
   * 测试里设 `false` 模拟"事件循环卡死导致续期停滞"（栅栏令牌防的正是这种场景）。
   */
  renew?: boolean;
  /**
   * 日志器：租约易主（`idempotency_lease_lost`）等异常必须落 error——
   * 它意味着"两个持有者同时认为自己是主人"，是并发事故的信号，不能静默。
   * 可选只是因为本层拿不到装配期的 logger；生产调用方（skeleton/业务路由）必须传。
   */
  logger?: Logger;
}

export interface IdempotencyResult<T> {
  status: number;
  body: T;
  /** true = 本次是重放（handler 未执行）；false = 本次真正执行了。 */
  replayed: boolean;
}

/** handler 的返回：HTTP 状态 + 可序列化的响应体。 */
export interface HandlerResult<T> {
  status: number;
  body: T;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 以幂等方式执行 handler。
 *
 * @throws {AppError} 40903（重复提交）：首次请求仍在执行（租约未过期）且超过 `waitMs` 未出结果
 * @throws {AppError} 40908（幂等键复用但内容不同）：同一个键传了不一样的请求——客户端的 bug。
 *         无论占位是已完成还是仍在执行中都立即抛：指纹不符时那行的结果永远不可能合法重放给我们，
 *         等超时再给 40903 只是拖延，还把"客户端 bug"误报成"服务端忙"。
 * @throws {AppError} 50000（idempotency_lease_lost）：handler 执行期间租约被接管，
 *         本次结果写不回（写了会覆盖新持有者）——租约易主是并发事故，调用方应重试
 */
export async function withIdempotency<T>(
  db: Db,
  args: IdempotencyArgs,
  handler: () => Promise<HandlerResult<T>>,
): Promise<IdempotencyResult<T>> {
  const waitMs = args.waitMs ?? 2000;
  const pollMs = args.pollMs ?? 50;
  const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
  const hash = args.request === undefined ? '' : requestFingerprint(args.request);
  const deadline = Date.now() + waitMs;

  for (;;) {
    // ① 抢占位（新键）或接管过期占位（崩溃遗留）——两条路径都可能拿到执行权。
    //    拿到执行权的同时拿到本次的栅栏令牌（lease_token），之后所有写/删都凭令牌进行。
    const token = await claim(db, args, hash, leaseMs);
    if (token !== undefined) {
      const stopRenew = args.renew === false ? undefined : startRenewal(db, args, token, leaseMs);
      // 结果写回时若令牌已易主，走另一条抛出路径，不进"删占位"分支（会重复打日志）
      let leaseLost = false;
      try {
        const result = await handler();
        // 栅栏（N1）：update 携带 lease_token。0 行命中 = 执行期间租约被接管，
        // 此时**绝不能**按 key 覆盖（会把新持有者的状态冲掉）。
        const written = await db`
          update idempotency_keys
             set status_code = ${result.status},
                 response = ${result.body as never},
                 completed_at = now(),
                 locked_until = null
           where key = ${args.key} and lease_token = ${token}
          returning key
        `;
        if (written.length === 0) {
          leaseLost = true;
          args.logger?.error('idempotency_lease_lost', {
            route: args.route,
            result: 'result_not_written',
            ctx: { key: args.key },
          });
          throw new AppError(50000, { reason: 'idempotency_lease_lost', route: args.route });
        }
        return { ...result, replayed: false };
      } catch (e) {
        if (!leaseLost) {
          // 删占位行：否则一次失败会把这个 key 永久毒化（@limitation 二）。
          // 栅栏（N1）：同样携带 lease_token——迟到失败的旧持有者**不准**删新持有者的占位。
          // 0 行命中 = 租约已易主，那行数据不归我们管，只准落日志。
          const deleted = await db`
            delete from idempotency_keys
             where key = ${args.key} and lease_token = ${token} and completed_at is null
            returning key
          `;
          if (deleted.length === 0) {
            args.logger?.error('idempotency_lease_lost', {
              route: args.route,
              result: 'placeholder_not_deleted',
              ctx: { key: args.key },
            });
          }
        }
        throw e;
      } finally {
        stopRenew?.();
      }
    }

    // ② 没抢到：要么已有结果（重放），要么别人正在做（等到租约过期或超时）
    const row = await readRow(db, args.key);
    if (row !== undefined) {
      // 指纹不符 = 客户端拿同一个键发了**另一个**请求：无论那行完成与否都必须报错（D4）。
      // 未完成时等下去也只有两个结局：完成后因指纹不符 40908，或超时 40903——
      // 两个结局都比"立即 40908"差，所以提前抛。
      if (hash !== '' && row.request_hash !== '' && row.request_hash !== hash) {
        throw new AppError(40908, { key: args.key, route: args.route });
      }
      if (row.completed_at !== null) {
        return { status: row.status_code, body: row.response as T, replayed: true };
      }
    }
    if (Date.now() >= deadline) {
      throw new AppError(40903, { key: args.key, route: args.route, waited_ms: waitMs });
    }
    await sleep(pollMs);
  }
}

/**
 * 单事务幂等（N2）：占位、业务写入、结果写回在**同一个事务**里完成。
 *
 * @why 非事务模式（withIdempotency）里"handler 的业务事务"和"结果写回"是两个事务，
 *      进程在两者之间崩溃 → 业务已提交（单建了）、幂等行还停在占位态 →
 *      同一键的后续请求要么接管再执行一次（重复建单），要么永久 40903。
 *      单事务模式把崩溃语义变成最朴素的一种：**崩溃 = 整体回滚**——
 *      占位从未存在过，键自动释放，不存在两个事务之间的窗口。
 *
 * @why 并发靠 `INSERT ... ON CONFLICT DO NOTHING` 撞上**未提交**冲突行时的阻塞实现自然串行：
 *      第二个请求阻塞到第一个提交（→ 读到结果重放）或回滚（→ 自己拿到占位执行）。
 *      阻塞时长由事务内 `SET LOCAL lock_timeout` 约束（取剩余等待预算），
 *      超时抛 55P03 → 走冲突路径 → 超过 waitMs 给 40903，与 withIdempotency 外部语义一致。
 *      @measured lock_timeout 对 ON CONFLICT 的**投机插入等待**确实生效（PG16 实测：
 *      持有方事务内 pg_sleep(1)，等待方预算 200ms → 准时抛 55P03 而非阻塞到对方提交；
 *      测试「lock_timeout 到点放手」）。这条曾是我的不确定点——投机插入等待走不走
 *      lock 管理器不能只凭记忆下结论。
 *
 * @limitation 一：**handler 里禁止再开事务**（`withTransaction(tx, …)` 会抛 "db.begin is not a function"），
 *              需要嵌套单元时用 `withSavepoint(tx, …)`。
 * @limitation 二：**handler 必须只做 DB 写入**。调外部服务（创建支付单、发邮件）不要放进这里——
 *              那会把 DB 事务和行锁架在一次 HTTP 调用上（连接被占、锁被拉长、对方抖动直接放大成
 *              本库压力）。有外部副作用的 handler 用 {@link withIdempotency}（非事务模式）。
 * @limitation 三：`leaseMs` / `renew` 参数在本模式下**无意义**（事务本身就是栅栏，
 *              回滚即释放，不存在"过期占位"）；传了也不会生效。同理本模式不产生
 *              `idempotency_lease_lost`——读到过期占位只可能来自非事务模式的写入，等超时后 40903。
 * @limitation 四：handler 内的慢语句仍受连接级 `statement_timeout`（15s，D20）约束；
 *              `lock_timeout` 只管"等锁"，不管"执行慢"。
 *
 * @see docs/二审意见甄别报告-2026-09-23.md §1 N2；migrations/003_idempotency_and_identity.sql
 */
export async function withIdempotencyTx<T>(
  db: Db,
  args: IdempotencyArgs,
  handler: (tx: Db) => Promise<HandlerResult<T>>,
): Promise<IdempotencyResult<T>> {
  const waitMs = args.waitMs ?? 2000;
  const pollMs = args.pollMs ?? 50;
  const hash = args.request === undefined ? '' : requestFingerprint(args.request);
  const deadline = Date.now() + waitMs;

  type Outcome = { kind: 'executed'; result: HandlerResult<T> } | { kind: 'conflict' };

  for (;;) {
    let outcome: Outcome;
    try {
      outcome = await withTransaction(db, async (tx): Promise<Outcome> => {
        // 等锁预算 = 剩余的等待额度：占不到锁（别人正在执行）到点放手，走 40903 路径
        const remaining = Math.max(1, Math.floor(deadline - Date.now()));
        await tx`select set_config('lock_timeout', ${String(remaining)}, true)`;
        // 占位与后续的业务写、结果写在同一事务：任何一步失败/进程崩溃 = 整体回滚
        const claimed = await tx`
          insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until, lease_token)
          values (${args.key}, ${args.userId ?? null}, ${args.route}, ${PENDING_STATUS_CODE}, '{}'::jsonb, ${hash}, null, ${randomUUID()})
          on conflict (key) do nothing
          returning key
        `;
        if (claimed.length === 0) return { kind: 'conflict' };
        const result = await handler(tx);
        await tx`
          update idempotency_keys
             set status_code = ${result.status},
                 response = ${result.body as never},
                 completed_at = now()
           where key = ${args.key}
        `;
        return { kind: 'executed', result };
      });
    } catch (e) {
      // 等锁超时（55P03）不是失败，是"别人还在做"——落到冲突路径按等待/超时处理
      if (isLockTimeout(e)) {
        outcome = { kind: 'conflict' };
      } else {
        throw e;
      }
    }
    if (outcome.kind === 'executed') return { ...outcome.result, replayed: false };

    // 冲突路径：要么已有结果（重放），要么别人正在做（等到出结果或超时）
    const row = await readRow(db, args.key);
    if (row !== undefined) {
      if (hash !== '' && row.request_hash !== '' && row.request_hash !== hash) {
        throw new AppError(40908, { key: args.key, route: args.route });
      }
      if (row.completed_at !== null) {
        return { status: row.status_code, body: row.response as T, replayed: true };
      }
    }
    if (Date.now() >= deadline) {
      throw new AppError(40903, { key: args.key, route: args.route, waited_ms: waitMs });
    }
    await sleep(pollMs);
  }
}

/**
 * postgres.js 的错误对象在 `.code` 上带 SQLSTATE；55P03 = lock_not_available。
 * @why 不写进 message 匹配：`message` 的措辞随 PG 版本变，SQLSTATE 是协议级稳定标识
 *      （§2 诚实清单第 3 条：SQLSTATE 只在 .code 上，message 里没有）。
 */
function isLockTimeout(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '55P03';
}

/**
 * 租约续期：handler 执行期间每 `leaseMs/3` 刷新一次 `locked_until`。
 *
 * @why 没有续期时，凡是 handler 超过租约时长的**正常**请求都会被接管、重复执行——
 *      租约设多长是在"崩溃后多快恢复"和"正常请求被误接管"之间做交易。
 *      续期把这个交易解掉：活着的 handler 持续证明"我还活着"，租约只需覆盖
 *      "续期间隔 + 一次 DB 往返"的抖动，而不是 handler 的最坏耗时。
 * @limitation 续期只能减少接管、不能杜绝：事件循环卡死超过一个租约时长（长 GC、同步阻塞），
 *             续期本身也跑不动。所以栅栏令牌（lease_token）仍然是最后一道防线，两者是
 *             "减少发生"与"发生了不出错"的关系，缺一不可。
 * @tradeoff 续期是**尽力而为**：续不上（0 行命中 = 已易主）只打 warn 不打断 handler——
 *           handler 已经在跑了，打断它也撤销不了已产生的副作用；
 *           结果写回时的栅栏检查会兜住"易主"这件事（0 行命中 → 50000 + error 日志）。
 */
function startRenewal(db: Db, args: IdempotencyArgs, token: string, leaseMs: number): () => void {
  const intervalMs = Math.max(50, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void (async () => {
      try {
        const rows = await db`
          update idempotency_keys
             set locked_until = ${new Date(Date.now() + leaseMs)}
           where key = ${args.key} and lease_token = ${token} and completed_at is null
          returning key
        `;
        if (rows.length === 0) {
          args.logger?.warn('idempotency_lease_renew_lost', {
            route: args.route,
            result: 'lease_lost_during_renew',
            ctx: { key: args.key },
          });
        }
      } catch (e) {
        args.logger?.warn('idempotency_lease_renew_failed', {
          route: args.route,
          result: 'renew_failed',
          err: e instanceof Error ? e.message : String(e),
          ctx: { key: args.key },
        });
      }
    })();
  }, intervalMs);
  // unref：测试/CLI 场景里不退出的定时器会拖住进程；续期的存亡不该决定进程存亡
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * 抢执行权：插入新占位，或接管"已完成时间为空且租约已过期"的遗留占位。
 * 抢到返回本次的**栅栏令牌**（lease_token），抢不到返回 undefined。
 *
 * @why 接管用 `UPDATE ... WHERE ... RETURNING` 而不是"先查再插"：后者两步之间有竞态，
 *      两个等待者可能同时判定"租约过期"然后都去执行。Postgres 的 UPDATE 在
 *      `locked_until < now()` 这一行条件上是原子的，第二个 UPDATE 匹配不到行（租约已被刷新）。
 * @why 接管时校验既有指纹（`request_hash = '' or request_hash = hash`）：
 *      旧占位登记的请求内容若与新请求不同，这是"客户端复用了幂等键"，
 *      必须走 40908（在 readRow 分支抛出）而不是覆盖指纹后执行——
 *      覆盖指纹等于销毁"键被复用过"的证据（二审 N1 的另一半）。
 */
async function claim(
  db: Db,
  args: IdempotencyArgs,
  hash: string,
  leaseMs: number,
): Promise<string | undefined> {
  const lockedUntil = new Date(Date.now() + leaseMs);
  const token = randomUUID();
  const inserted = await db`
    insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until, lease_token)
    values (${args.key}, ${args.userId ?? null}, ${args.route}, ${PENDING_STATUS_CODE}, '{}'::jsonb, ${hash}, ${lockedUntil}, ${token})
    on conflict (key) do nothing
    returning lease_token
  `;
  if (inserted.length > 0) return String(inserted[0]?.lease_token);

  const taken = await db`
    update idempotency_keys
       set locked_until = ${lockedUntil}, request_hash = ${hash}, lease_token = ${token}
     where key = ${args.key}
       and completed_at is null
       and (locked_until is null or locked_until < now())
       and (request_hash = '' or request_hash = ${hash})
     returning lease_token
  `;
  return taken.length > 0 ? String(taken[0]?.lease_token) : undefined;
}

interface IdempotencyRow {
  status_code: number;
  response: unknown;
  request_hash: string;
  completed_at: Date | null;
  locked_until: Date | null;
}

/** 读整行（含指纹与租约）；不存在返回 undefined。 */
async function readRow(db: Db, key: string): Promise<IdempotencyRow | undefined> {
  const rows = await db`
    select status_code, response, request_hash, completed_at, locked_until
      from idempotency_keys where key = ${key}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    status_code: Number(row.status_code),
    response: row.response,
    request_hash: String(row.request_hash),
    completed_at: row.completed_at as Date | null,
    locked_until: row.locked_until as Date | null,
  };
}

/** 按 `用户 + 路由 + 客户端 key` 拼作用域，防止跨用户/跨接口撞键。 */
export function scopeKey(parts: { userId?: string; route: string; clientKey: string }): string {
  return [parts.userId ?? 'anon', parts.route, parts.clientKey].join(':');
}
