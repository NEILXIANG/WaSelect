/**
 * 职责：幂等执行器的**实现**（F8）——同一个 Idempotency-Key 只真正执行一次，重放返回首次结果。
 * 边界：只管"执行一次"这件事；key 从哪个头来、哪些路由需要幂等，由路由层决定。
 * 对外只暴露 {@link createIdempotencyExecutor}；契约与语义常量在 `../ports/idempotency.ts`。
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
 *           过期清理交给**调度器**（{@link IDEMPOTENCY_TTL_HOURS} = 24h），不在此处做 TTL。
 *           ⚠️ 2026-09-25 之前那句"过期清理交给调度器"是**假的**：全仓没有一条
 *           `delete from idempotency_keys`、也没有对应 job（三审欠账 ①），
 *           于是"24h 后同键可以重新执行"从未成立——键一旦写过就永久重放。
 *           现在清理 SQL 在 {@link deleteExpiredIdempotencyKeys}，job 在
 *           `app/cleanup-idempotency.ts`，接线在 `main.ts`。
 *
 * @see ../ports/idempotency.ts（契约与语义常量）；技术文档 v0.5 §3（idempotency_keys）；
 *      docs/地基搭建清单.md F8；D-29；评审 D3/D4；
 *      docs/二审意见甄别报告-2026-09-23.md §1 N1（栅栏令牌）/ N2（单事务模式）；
 *      migrations/004_idempotency_fencing.sql
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { withTransaction, type Db } from './db.js';
import {
  DEFAULT_LEASE_MS,
  requestFingerprint,
  type HandlerResult,
  type IdempotencyArgs,
  type IdempotencyExecutor,
  type IdempotencyResult,
} from '../ports/idempotency.js';

/** 占位行的状态码：0 表示"抢到了但还没执行完"，不是真实 HTTP 状态。 */
const PENDING_STATUS_CODE = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 以幂等方式执行 handler（非事务模式）。
 *
 * @throws {AppError} 40903（重复提交）：首次请求仍在执行（租约未过期）且超过 `waitMs` 未出结果
 * @throws {AppError} 40908（幂等键复用但内容不同）：同一个键传了不一样的请求——客户端的 bug。
 *         无论占位是已完成还是仍在执行中都立即抛：指纹不符时那行的结果永远不可能合法重放给我们，
 *         等超时再给 40903 只是拖延，还把"客户端 bug"误报成"服务端忙"。
 * @throws {AppError} 50000（idempotency_lease_lost）：handler 执行期间租约被接管，
 *         本次结果写不回（写了会覆盖新持有者）——租约易主是并发事故，调用方应重试
 */
async function withIdempotency<T>(
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
                 response = ${(args.persist ? args.persist(result.body) : result.body) as never},
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
      // 三审 P3-4：执行器自己核对用户，不只靠调用方 scopeKey——跨用户撞键与"同键不同内容"同码
      if (row.user_id !== (args.userId ?? null)) {
        throw new AppError(40908, { key: args.key, route: args.route, reason: 'user_mismatch' });
      }
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
async function withIdempotencyTx<T>(
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
    // 三审 P2-2：只有**占位那一步**的 55P03 才是"别人正在做"；handler 内部的 55P03 是它自己
    //    在等别的行锁，必须原样抛出——否则 handler 会被静默重跑（内存副作用不随事务回滚）。
    let inHandler = false;
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
        inHandler = true;
        const result = await handler(tx);
        await tx`
          update idempotency_keys
             set status_code = ${result.status},
                 response = ${(args.persist ? args.persist(result.body) : result.body) as never},
                 completed_at = now()
           where key = ${args.key}
        `;
        return { kind: 'executed', result };
      });
    } catch (e) {
      // 占位那一步等锁超时（55P03）不是失败，是"别人还在做"——落到冲突路径按等待/超时处理。
      // handler 内部的 55P03 **不在此列**（inHandler=true）：曾经一律当占位冲突再走一轮，
      //    DB 副作用虽随事务回滚，handler 闭包里的内存副作用（收集的领域事件、已打的日志、
      //    已消耗的单号）不会——"executor 外收集事件再 publishAll"的形态会发出幽灵事件
      //    （三审 P2-2，用例「handler 内部 55P03 → 原样抛出且只执行一次」）。
      if (isLockTimeout(e) && !inHandler) {
        outcome = { kind: 'conflict' };
      } else {
        throw e;
      }
    }
    if (outcome.kind === 'executed') return { ...outcome.result, replayed: false };

    // 冲突路径：要么已有结果（重放），要么别人正在做（等到出结果或超时）
    const row = await readRow(db, args.key);
    if (row !== undefined) {
      // 三审 P3-4：执行器自己核对用户，不只靠调用方 scopeKey——跨用户撞键与"同键不同内容"同码
      if (row.user_id !== (args.userId ?? null)) {
        throw new AppError(40908, { key: args.key, route: args.route, reason: 'user_mismatch' });
      }
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
        // 同 claim()：续期的到期时刻也用 DB 时钟算，避免"写入用应用时钟、判定用 DB 时钟"
        const rows = await db`
          update idempotency_keys
             set locked_until = now() + ${leaseMs} * interval '1 millisecond'
           where key = ${args.key} and lease_token = ${token}
          returning key
        `;
        // ⚠️ 条件里**不带** `completed_at is null`（三审 P3-1）：handler 恰在续期 RTT 内完成时，
        //    带该条件会命中 0 行 → 误报"易主"，把真信号淹掉；对已完成行续期无害，0 行只剩"令牌变了"一种含义。
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
 * @limitation 本函数的 `insert` **没有**设 `lock_timeout`：若另一个请求正用
 *              {@link withIdempotencyTx} 持有同名占位（事务未提交），ON CONFLICT 会阻塞到它提交/回滚，
 *              最坏要等到连接级 `statement_timeout`（15s，D20）才放手。
 *              MVP 里两种模式不混用（业务路由走单事务模式），所以现状可接受；
 *              将来若同一批接口两种模式并存，应在这里按剩余等待预算 `SET LOCAL lock_timeout`
 *              （与单事务模式一致的做法），否则会表现为"偶发请求挂十几秒"。
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
  const token = randomUUID();
  // ⚠️ locked_until **必须由 DB 时钟计算**（`now() + leaseMs`），不能用 `new Date(Date.now() + leaseMs)`。
  //    判定过期用的也是 DB 的 now()（下面的 `locked_until < now()`）——写与判若来自两个时钟，
  //    租约长度就会被时钟偏移扭曲：应用时钟偏快 → 崩溃遗留的占位迟迟不能被接管；
  //    偏慢 → 正常执行的 handler 被误接管。Render 上应用与 Postgres 是不同实例，差几秒很常见。
  //    （2026-09-23 自查发现；用例「租约到期时刻由 DB 时钟决定」钉住）
  const inserted = await db`
    insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until, lease_token)
    values (${args.key}, ${args.userId ?? null}, ${args.route}, ${PENDING_STATUS_CODE}, '{}'::jsonb, ${hash},
            now() + ${leaseMs} * interval '1 millisecond', ${token})
    on conflict (key) do nothing
    returning lease_token
  `;
  if (inserted.length > 0) return String(inserted[0]?.lease_token);

  const taken = await db`
    update idempotency_keys
       set locked_until = now() + ${leaseMs} * interval '1 millisecond',
           request_hash = ${hash}, lease_token = ${token}
     where key = ${args.key}
       and completed_at is null
       and (locked_until is null or locked_until < now())
       and (request_hash = '' or request_hash = ${hash})
       and user_id is not distinct from ${args.userId ?? null}
     returning lease_token
  `;
  return taken.length > 0 ? String(taken[0]?.lease_token) : undefined;
}

interface IdempotencyRow {
  /** 占位时的用户；与本次 `args.userId` 不符 = 跨用户撞键（三审 P3-4）。 */
  user_id: string | null;
  status_code: number;
  response: unknown;
  request_hash: string;
  completed_at: Date | null;
  locked_until: Date | null;
}

/** 读整行（含指纹与租约）；不存在返回 undefined。 */
async function readRow(db: Db, key: string): Promise<IdempotencyRow | undefined> {
  const rows = await db`
    select status_code, response, request_hash, completed_at, locked_until, user_id
      from idempotency_keys where key = ${key}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    user_id: (row.user_id as string | null) ?? null,
    status_code: Number(row.status_code),
    response: row.response,
    request_hash: String(row.request_hash),
    completed_at: row.completed_at as Date | null,
    locked_until: row.locked_until as Date | null,
  };
}

/**
 * 造一个幂等执行器：把连接池绑定成 {@link IdempotencyExecutor}。
 *
 * @why 走工厂而不是直接导出两个函数：直接导出意味着业务侧要自己持有 `db` 再传进去，
 *      于是"业务认识数据库"这件事又从后门回来了——目录分了，依赖没变（AJ-44 的原话）。
 *      工厂把 `db` 收在闭包里，业务只拿到"能执行幂等"的对象。
 * @why 返回类型是 `IdempotencyExecutor<Db>` 而不是更抽象的形态：
 *      事务句柄的形状目前只能是 postgres.js 的 `Db`，因为 `runInTx` 的 handler
 *      要在这个事务里写业务 SQL。把它伪装成别的类型只会让业务侧多一层 cast，
 *      cast 之后"业务不认识 SQL"依然是假的——不如把不彻底写在明处
 *      （@see ../ports/idempotency.ts @limitation 一）。
 */
/**
 * 幂等键的保留时长（小时）。
 *
 * @why 24h 取自审计口径（"24h 后同键可重新执行"），也是客户端重试的现实上界：
 *      比它短，"用户隔天点了一次重试"会被当成新请求重复执行；比它长，
 *      这张表会一直涨——它每一行都是一次真实请求的响应快照。
 * @limitation 它是**代码常量而不是配置项**：改它要动的是业务语义（多久之后允许重做），
 *      不是运营参数。真要可调时再进 config.ts（届时要同步 `.env.example`、
 *      `render.yaml` 与 `config.contract.test.ts`，三处一起）。
 */
export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * 删掉早于 `cutoff` 的幂等键，返回**删除行数**（0 = 无事可做，不是失败）。
 *
 * @why `delete` 而不是 `update ... 标记过期`：标记之后"过期"这件事还要有人来解释，
 *      而解释它的地方就是下一个会漏掉的地方。删掉之后表里剩下的每一行都还在有效期内，
 *      "这张表有多大"直接等于"最近 24h 有多少次写请求"——可观测性也顺带好了。
 * @limitation **只删已经完成的**（`completed_at is not null`）：还在执行的行由栅栏/租约保护，
 *      清理任务在任何实例上跑，早删一步就等于替另一个实例把租约抹掉。
 *      ⚠️ 副作用：崩溃遗留的"占位但未完成"行不会被本函数清掉——那些行靠租约过期
 *      让下一个同键请求接管，属于既有设计，不在这里引入第二种清理语义。
 */
/**
 * 由"当前时刻"推出清理截止点：`now - {@link IDEMPOTENCY_TTL_HOURS}`。
 *
 * @why 这个换算**必须住在 adapters 层**：业务侧（app / domain）被 F10 规则禁止自己
 *      `new Date()`（时间一律由 `ports/clock.ts` 注入），而"由注入进来的时间派生一个更早的时间"
 *      在语法上同样是 `new Date(...)`——规则是 AST 级的，分不出"取当前时间"与"派生"。
 *      于是把派生收在这里（边界层本就是"进程外时间"该住的地方），
 *      业务侧只传 `ctx.startedAt`，既守住了规则，也让 TTL 口径只有一个来源。
 * @limitation 只做减法、且只按整小时回退：TTL 是"多久之后允许重做"的业务语义
 *      （{@link IDEMPOTENCY_TTL_HOURS}），不是运营参数，不进 config。
 */
export function idempotencyCutoff(now: Date): Date {
  return new Date(now.getTime() - IDEMPOTENCY_TTL_HOURS * 3_600_000);
}

export async function deleteExpiredIdempotencyKeys(db: Db, cutoff: Date): Promise<number> {
  const rows = await db`
    delete from idempotency_keys
     where created_at < ${cutoff}
       and completed_at is not null
    returning key
  `;
  return rows.length;
}

export function createIdempotencyExecutor(db: Db): IdempotencyExecutor<Db> {
  return {
    run: <T>(args: IdempotencyArgs, handler: () => Promise<HandlerResult<T>>) =>
      withIdempotency(db, args, handler),
    runInTx: <T>(args: IdempotencyArgs, handler: (tx: Db) => Promise<HandlerResult<T>>) =>
      withIdempotencyTx(db, args, handler),
  };
}
