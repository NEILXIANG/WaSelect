/**
 * 职责：`app/admin-audit.ts` 的单测——审计 after 的**脱敏**（F-02 / AJ-183）与
 *       审计**生命周期**（B15 / AJ-206：客户端断开时审计不能跟着消失）。
 *
 * @why admin_audit 没有保留期（append-only、永久）：PII 一旦原样落进去就再也删不掉
 *      （触发器拒 UPDATE/DELETE），而"该审没审上"同样补不回来。所以这里钉两头：
 *      ① 落进去的**内容**不能含 PII；② 该落的**时机**不能依赖客户端还活着。
 */
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import type { AdminAuditEntry, AdminAuditStore } from '../ports/admin-audit.js';
import {
  adminAuditMiddleware,
  auditPayload,
  markAuditCommitted,
  setAuditBefore,
} from './admin-audit.js';
import { createInflightJobs } from './inflight-jobs.js';

describe('auditPayload（审计 after 脱敏）', () => {
  /**
   * @why 邮编**必须**被脱敏（`postal_code` 曾因为清单里没有它而原样落库，B16 / AJ-207）。
   *      美国地址行 + 邮编 + 姓氏即可指向具体住户，而排查订单问题靠的是 order_id 与 trace_id，
   *      从不需要在审计里看到完整邮编——所以这里钉的是"邮编没了"，不是"邮编还在"。
   */
  it('改址请求体：收件人 / 电话 / 街道 / **邮编** 全部脱敏，州 / 城市 / 国家保留（排查够用）', () => {
    expect(
      auditPayload({
        recipient: 'Jane Doe',
        phone: '+14155550123',
        line1: '1 Infinite Loop',
        line2: 'Apt 2',
        city: 'Cupertino',
        state: 'CA',
        postal_code: '95014',
        country: 'US',
      }),
    ).toEqual({
      recipient: 'J***',
      phone: '***0123',
      line1: '***',
      line2: '***',
      city: 'Cupertino',
      state: 'CA',
      postal_code: '***',
      country: 'US',
    });
  });

  it('ZIP+4 与大小写变体同样脱敏（清单曾经只认全小写的 7 个键名）', () => {
    const out = auditPayload({
      postal_code: '78701-1234',
      PostalCode: '78701-1234',
      contactEmail: 'buyer@example.com',
      Password: 'S'.repeat(12),
      openid: 'o6_bmjrPTlm6_2sgVt7hMZOPfL2M',
      api_key: 'sk_live_abcdefghijklmnop',
      accessToken: 'tok-1234567890',
    }) as Record<string, unknown>;
    expect(out['postal_code']).toBe('***');
    expect(out['PostalCode']).toBe('***');
    expect(out['contactEmail']).toBe('b***@example.com');
    expect(out['Password']).toBe('***');
    expect(out['api_key']).toBe('***');
    expect(out['accessToken']).toBe('***');
    // openid 只留尾 4 位数字（redact 的 IDENTIFIER 口径）：对账排障要对得上号
    expect(String(out['openid'])).not.toContain('bmjrPTlm6');
  });

  it('嵌套对象与数组也脱敏；口令 / 邮箱在任何层级都不落库', () => {
    expect(
      auditPayload([{ carrier: 'EMS', meta: { email: 'a@b.c', password: 'x'.repeat(12) } }]),
    ).toEqual([{ carrier: 'EMS', meta: { email: 'a***@b.c', password: '***' } }]);
  });

  it('非对象（undefined / 字符串 / Buffer 之外的 multipart 空体）→ null', () => {
    expect(auditPayload(undefined)).toBeNull();
    expect(auditPayload('raw')).toBeNull();
    expect(auditPayload(null)).toBeNull();
  });

  /**
   * 防复发（B16 / AJ-207）：脱敏**不得**有第二份键名清单。
   * @why 断言源码而不是断言行为：行为断言只能证明"现在这几个键是对的"，
   *      而缺陷的形态是"有人另起一份清单"——那在加进来的那一刻行为断言全是绿的
   *      （新清单会照着当下的需求写全），只有等它漂移才暴露，而审计表**删不掉**。
   * @limitation 扫描前先剥注释行（§2 第 54 条：注释里的同款字符串会让断言假绿）。
   */
  it('本模块不自带键名清单（脱敏全委托 redact.ts）', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./admin-audit.ts', import.meta.url), 'utf8'),
    );
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    // 判据是"**键名**不出现在本模块里"：另起一份清单必然要写这些字面量，
    // 而"加一个敏感键名"恰恰是这类缺陷的唯一形态（行为断言在它加进来的那天是全绿的）。
    for (const key of [
      'password',
      'phone',
      'email',
      'recipient',
      'line1',
      'line2',
      'postal_code',
      'openid',
      'token',
    ]) {
      expect(code.includes(`'${key}'`), `本模块不得自带键名清单：${key}`).toBe(false);
    }
    expect(code).toContain("from '../redact.js'");
  });
});

/**
 * B15 / AJ-206：审计挂在 **`prefinish`** 上，而不是 `finish`。
 *
 * @why `finish` 表示"响应已交给操作系统"。客户端在**业务已提交之后**断开
 *      （管理员关页签 / 网络断开 / Cloudflare 524）时它不触发：钱已经退了，
 *      审计里一行都没有，而 append-only 的事后补不回来。
 *      这条必须用**真实 socket + 真实中断**验：只测逻辑分支证明不了
 *      "Node 在这种情况下到底触不触发这个事件"。
 */
describe('审计生命周期（B15 / AJ-206）', () => {
  let server: Server | undefined;

  afterEach(async () => {
    // 可能有"/hang"这类永不响应的连接——不等 keep-alive，直接销毁，否则 vitest 残留 open handle
    server?.closeAllConnections?.();
    await new Promise<void>((r) => {
      if (server === undefined) return r();
      server.close(() => r());
    });
    server = undefined;
  });

  /** 起一个真的管理端写接口；`respond`=false 时 handler 永不 end（模拟请求被中断）。 */
  async function startAdminApp(opts: { delayMs: number; respond: boolean }): Promise<{
    port: number;
    sink: MemorySink;
    entries: AdminAuditEntry[];
    /** handler 已开始执行时兑现——中断以它为准，不以"固定等 50ms"为准（AJ-223）。 */
    entered: Promise<void>;
  }> {
    let fire: () => void = () => undefined;
    const entered = new Promise<void>((r) => {
      fire = r;
    });
    const sink = new MemorySink();
    const logger = createLogger({ env: 'test', destination: sink });
    const entries: AdminAuditEntry[] = [];
    const store: AdminAuditStore = {
      append: async (e) => {
        entries.push(e);
      },
    };
    const app = express();
    app.use(adminAuditMiddleware({ store, logger, jobs: createInflightJobs() }));
    // 模拟 requireRole('admin')：审计只认 2xx + 管理员
    app.use((req, _res, next) => {
      req.auth = { sub: 'u-1', role: 'admin' };
      next();
    });
    app.post('/api/v1/admin/refund', (_req, res) => {
      fire();
      setTimeout(() => {
        if (opts.respond) res.status(200).json({ ok: true });
      }, opts.delayMs);
    });
    const s = await new Promise<Server>((resolve) => {
      const created = app.listen(0, '127.0.0.1', () => resolve(created));
    });
    server = s;
    const address = s.address();
    if (address === null || typeof address === 'string') throw new Error('无法获取端口');
    return { port: address.port, sink, entries, entered };
  }

  /**
   * 发一个请求，等 handler 已开始执行（`handlerEntered`）后**摧毁连接**（不等响应）。
   * @why 用原始 socket 而不是 fetch().abort()：中断必须发生在**服务端已提交业务、
   *      但还没把响应写完**的窗口里，fetch 的取消时序不受控。
   */
  function postThenAbort(port: number, handlerEntered: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write('POST /api/v1/admin/refund HTTP/1.1\r\nHost: t\r\nContent-Length: 2\r\n\r\n{}');
      });
      sock.on('error', () => undefined); // 中断后的 ECONNRESET 不是用例关心的事
      void handlerEntered.then(() => {
        sock.destroy();
        resolve();
      });
    });
  }

  it('客户端在业务提交后断开 → 审计**仍然**落一行（finish 会丢，prefinish 不会）', async () => {
    // @measured 时序：handler 200ms 后响应，客户端 50ms 时断开——
    // 事件发生的顺序是「客户端先断、服务端后 end」，正是生产里"退款已执行、页签已关"的形状。
    // 实测 `close` 在 50ms 就触发（此时 statusCode 还是默认 200），`prefinish` 在 200ms 触发。
    const { port, entries, sink, entered } = await startAdminApp({ delayMs: 200, respond: true });
    await postThenAbort(port, entered);
    // 等"出现了"而不是"等够久"（AJ-223：固定等待在机器忙时会先于事件到期）
    await vi.waitFor(() => expect(entries).toHaveLength(1), { timeout: 3_000, interval: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('POST /admin/refund');
    expect(entries[0]?.actor).toBe('admin:u-1');
    // 且不产生任何 error 级日志：这一条正是"退款成功但管理员关了页签"，
    // 若按"close 就该告警"的写法，它会被误报成"该审没审上"（@measured，见 admin-audit.ts 文件头）
    expect(sink.rows().filter((r) => r.level === 'error')).toHaveLength(0);
  });

  it('handler 从未 end（请求卡住）→ 不写审计，也不告警（没有 2xx 就没有"已发生的改动"）', async () => {
    const { port, sink, entries, entered } = await startAdminApp({
      delayMs: 5_000,
      respond: false,
    });
    await postThenAbort(port, entered);
    await new Promise((r) => setTimeout(r, 300));
    expect(entries).toHaveLength(0);
    expect(sink.find('admin_audit_skipped_aborted')).toHaveLength(0);
  });

  it('响应正常结束 → 恰好一条审计，且没有任何 error 级日志', async () => {
    const { port, sink, entries } = await startAdminApp({ delayMs: 20, respond: true });
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(entries).toHaveLength(1);
    expect(sink.find('admin_audit_skipped_aborted')).toHaveLength(0);
    expect(sink.find('admin_audit_write_failed')).toHaveLength(0);
  });

  /**
   * 直接驱动事件回调（不经过网络）：钉住"触发了之后我们判得对不对"。
   * @why 网络用例证明的是"Node 会不会触发"，这一条证明的是判定本身——
   *      尤其是 4xx / 非管理员不该产生任何审计或告警。
   */
  it('4xx 与非管理员请求：不写审计，也不告警', () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'test', destination: sink });
    const entries: AdminAuditEntry[] = [];
    const mw = adminAuditMiddleware({
      store: {
        append: async (e) => {
          entries.push(e);
        },
      },
      logger,
      jobs: createInflightJobs(),
    });
    const makeRes = (status: number): Response & EventEmitter => {
      const res = new EventEmitter() as unknown as Response & EventEmitter;
      // 同上：`end` 是真 `ServerResponse` 的一部分，桩必须提供
      Object.assign(res, { statusCode: status, locals: {}, end: () => res });
      return res;
    };
    const fire = (status: number, auth: unknown): void => {
      const res = makeRes(status);
      const req = {
        method: 'POST',
        route: { path: '/api/v1/admin/x' },
        // router 派发每一层之前都会写 `req.params`（没有路径参数时是 `{}`）⇒ 真请求里它一定存在。
        // 桩不给的话，中间件读 `params['id']` 会抛——那是桩不完整，不是中间件该加容错分支。
        params: {},
        auth,
      } as unknown as Request;
      mw(req, res, () => undefined);
      res.emit('prefinish');
      res.emit('close');
    };
    fire(400, { role: 'admin', sub: 'u-1' });
    fire(200, { role: 'user', sub: 'u-9' });
    fire(200, undefined);
    expect(entries).toHaveLength(0);
    expect(sink.find('admin_audit_skipped_aborted')).toHaveLength(0);
  });

  /**
   * @why 审计写在响应**之后**，而停机排空只认"响应已 end"（AJ-274）：不登记的话，
   *      进程在这段窗口里关掉连接池，这一行就永久丢失（`admin_audit` append-only，补不回来）。
   *      所以钉的不是"它最终会成功"，而是**停机等待的那张表看得到它**。
   * @limitation 这里只验登记与等待，不验"排空真的会调 wait"——那是 main.ts 的用例
   *      （`main.db.test.ts`）与 `inflight-jobs.unit.test.ts` 各自的职责。
   */
  it('审计写入登记为在途作业：停机的排空等得到它（AJ-274）', async () => {
    const jobs = createInflightJobs();
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const entries: AdminAuditEntry[] = [];
    const mw = adminAuditMiddleware({
      store: {
        append: async (e) => {
          await gate;
          entries.push(e);
        },
      },
      logger: createLogger({ env: 'test', destination: new MemorySink() }),
      jobs,
    });

    const res = new EventEmitter() as unknown as Response & EventEmitter;
    // ⚠️ `end` 必须有：中间件会包一层 `res.end` 作为 `prefinish` 的兜底（SEC2-03）。
    //    真的 `http.ServerResponse` 一定有这个方法——缺它是**这个桩不完整**，
    //    不是中间件该为它加一条容错分支（那会在生产里留下一个永不执行的判断）。
    Object.assign(res, { statusCode: 200, locals: {}, end: () => res });
    const req = {
      method: 'POST',
      route: { path: '/api/v1/admin/x' },
      params: { id: 'o-1' },
      auth: { role: 'admin', sub: 'u-1' },
      body: {},
    } as unknown as Request;
    mw(req, res, () => undefined);
    res.emit('prefinish');

    // 写入还没落地 ⇒ 登记表里必须看得见它（`wait()` 才等得到）
    expect(jobs.pending, '审计写入没登记进在途表').toBe(1);
    const waiting = jobs.wait(2_000);
    release();
    await expect(waiting).resolves.toMatchObject({ settled: true, pending: 0 });
    expect(entries).toHaveLength(1);
    expect(jobs.pending).toBe(0);
  });
});

/**
 * AJ-294：`before` 必须和 `after` 一样走 redact。
 *
 * @why 现有两个调用点（运费整表替换、banner）**恰好**都不含 PII，所以"不脱敏"在今天完全是绿的——
 *      这条断言防的不是现状，是**将来**：某条改订单路由把订单对象传进 `setAuditBefore` 的那一天，
 *      `address_snapshot` 会永久落进 append-only 表（触发器拒 UPDATE/DELETE，事后补不回来）。
 *      AJ-207 在 `after` 上踩过同一个洞，这里是它的另一侧。
 */
describe('审计 before 脱敏（AJ-294）', () => {
  it('setAuditBefore 传入的收件人 / 电话 / 街道 / 邮编，落库时与 after 同口径被脱敏', async () => {
    const entries: AdminAuditEntry[] = [];
    const mw = adminAuditMiddleware({
      store: {
        append: async (e) => {
          entries.push(e);
        },
      },
      logger: createLogger({ env: 'test', destination: new MemorySink() }),
      jobs: createInflightJobs(),
    });

    const res = new EventEmitter() as unknown as Response & EventEmitter;
    // ⚠️ `end` 必须有：中间件会包一层 `res.end` 作为 `prefinish` 的兜底（SEC2-03）。
    //    真的 `http.ServerResponse` 一定有这个方法——缺它是**这个桩不完整**，
    //    不是中间件该为它加一条容错分支（那会在生产里留下一个永不执行的判断）。
    Object.assign(res, { statusCode: 200, locals: {}, end: () => res });
    setAuditBefore(res, {
      recipient: 'Jane Doe',
      phone: '+14155550123',
      line1: '1 Infinite Loop',
      postal_code: '95014',
      city: 'Cupertino',
    });
    const req = {
      method: 'PATCH',
      route: { path: '/api/v1/admin/orders/:id' },
      params: { id: 'o-1' },
      auth: { role: 'admin', sub: 'u-1' },
      body: {},
    } as unknown as Request;
    mw(req, res, () => undefined);
    res.emit('prefinish');

    await vi.waitFor(() => expect(entries).toHaveLength(1), { timeout: 2_000, interval: 5 });
    // 与 auditPayload 的口径逐字一致（同表对比，不是另写一份期望值）
    expect(entries[0]?.before).toEqual({
      recipient: 'J***',
      phone: '***0123',
      line1: '***',
      postal_code: '***',
      city: 'Cupertino',
    });
  });

  /**
   * @why 脱敏只放在**唯一落库点**（中间件），不在 `setAuditBefore` 里再脱一次：
   *      `redact` 对 `pii-name` 类是 `` `${value[0]}***` ``（保留首字母），**不幂等**——
   *      `{recipient:'***'}` 二次脱敏会得到 `'****'`，随调用次数一直长。
   *      这条钉的是"脱敏恰好发生一次"，它同时是 ③（两处都做）被否掉那一条的回归哨兵。
   */
  it('脱敏只发生一次：姓名不会被二次加工成 ****（redact 对 pii-name 不幂等）', async () => {
    const entries: AdminAuditEntry[] = [];
    const mw = adminAuditMiddleware({
      store: {
        append: async (e) => {
          entries.push(e);
        },
      },
      logger: createLogger({ env: 'test', destination: new MemorySink() }),
      jobs: createInflightJobs(),
    });
    const res = new EventEmitter() as unknown as Response & EventEmitter;
    // ⚠️ `end` 必须有：中间件会包一层 `res.end` 作为 `prefinish` 的兜底（SEC2-03）。
    //    真的 `http.ServerResponse` 一定有这个方法——缺它是**这个桩不完整**，
    //    不是中间件该为它加一条容错分支（那会在生产里留下一个永不执行的判断）。
    Object.assign(res, { statusCode: 200, locals: {}, end: () => res });
    setAuditBefore(res, { recipient: 'Jane Doe' });
    const req = {
      method: 'PATCH',
      route: { path: '/api/v1/admin/orders/:id' },
      params: { id: 'o-1' },
      auth: { role: 'admin', sub: 'u-1' },
      body: {},
    } as unknown as Request;
    mw(req, res, () => undefined);
    res.emit('prefinish');
    await vi.waitFor(() => expect(entries).toHaveLength(1), { timeout: 2_000, interval: 5 });
    expect(entries[0]?.before).toEqual({ recipient: 'J***' });
    expect((entries[0]?.before as { recipient: string }).recipient).not.toBe('****');
  });
});

/**
 * SEC2-02：两段式写操作（如退款）——第一段事务**已经提交**、第二段调机构失败回 5xx。
 *
 * @why 这是全表最需要留痕的一类请求：**钱可能已经退了、我们不知道**。
 *      而"只写 2xx"会让它在 `admin_audit` 里**一行都没有**，且这条表 append-only、事后补不回来。
 * @why 同时钉住反方向：不是"5xx 都写"。没有 `markAuditCommitted` 的 5xx 仍然不写——
 *      否则等价关系变成"有审计行 ⇔ 有人点了一次"，而"审计了但没做成"比"没审"更坏
 *      （事后回溯会把一次失败的退款读成成功的）。
 * @why `status_code` 必须落库：有了它，两种情形在同一张表里可区分，且都不丢（迁移 025）。
 */
describe('SEC2-02：已提交但回非 2xx 的请求也要留痕（status_code 记着它没成）', () => {
  const setup = () => {
    const entries: AdminAuditEntry[] = [];
    const mw = adminAuditMiddleware({
      store: {
        append: async (e) => {
          entries.push(e);
        },
      },
      logger: createLogger({ env: 'test', destination: new MemorySink() }),
      jobs: createInflightJobs(),
    });
    const res = new EventEmitter() as unknown as Response & EventEmitter;
    Object.assign(res, { statusCode: 500, locals: {}, end: () => res });
    const req = {
      method: 'POST',
      route: { path: '/api/v1/admin/orders/:id/refund' },
      params: { id: 'o-1' },
      auth: { role: 'admin', sub: 'u-1' },
      body: { reason: '缺货' },
    } as unknown as Request;
    return { entries, mw, req, res };
  };

  it('🔴 声明了 markAuditCommitted 的 5xx → 写审计，且 status_code = 500', async () => {
    const { entries, mw, req, res } = setup();
    mw(req, res, () => undefined);
    markAuditCommitted(res); // 路由在第一段事务提交之后调用
    res.emit('prefinish');
    await vi.waitFor(() => expect(entries).toHaveLength(1), { timeout: 2_000, interval: 5 });
    expect(entries[0]?.statusCode).toBe(500);
    expect(entries[0]?.target).toBe('o-1');
    expect(entries[0]?.action).toContain('refund');
    // after 仍是脱敏后的请求体（不是 null）——"管理员要把它改成什么"照样要留
    expect(entries[0]?.after).toEqual({ reason: '缺货' });
  });

  it('🔴 没声明的 5xx 仍然不写（不把"审计了但没做成"这个方向打开）', async () => {
    const { entries, mw, req, res } = setup();
    mw(req, res, () => undefined);
    res.emit('prefinish');
    await new Promise((r) => setTimeout(r, 20));
    expect(entries).toHaveLength(0);
  });
});

/**
 * SEC2-03：文件头曾经写"`prefinish` 必然触发，没有需要兜的洞"——**这句话是错的**。
 *
 * @measured(第二轮审查 SEC2-03 的探针，express 5.2.1 / Node 25.3)：
 *   同一连接上**管线化**的第二个请求，在第一个响应写完之前连接断开时，
 *   handler 照常执行 `res.json()`，但它的 response 从未拿到 socket，
 *   `prefinish` / `finish` / `close` **一个都不触发** ⇒ 业务已提交、审计无行。
 * @why 这里不重造"管线化 + 中断"那种场景（它依赖 socket 时序，做成用例必然偶发红），
 *      而是直接钉住那个**机制**：即使 `prefinish` 一次都不触发，只要 `end()` 被调用，
 *      审计就必须写。`end()` 被调用这件事与 socket 是否就位无关——这正是选它做兜底的理由。
 */
describe('SEC2-03：prefinish 不触发时，end() 兜底仍要写审计', () => {
  it('🔴 只调 end()（不 emit prefinish）→ 审计照样写，且只写一次', async () => {
    const entries: AdminAuditEntry[] = [];
    const mw = adminAuditMiddleware({
      store: {
        append: async (e) => {
          entries.push(e);
        },
      },
      logger: createLogger({ env: 'test', destination: new MemorySink() }),
      jobs: createInflightJobs(),
    });
    let endCalls = 0;
    const res = new EventEmitter() as unknown as Response & EventEmitter;
    Object.assign(res, {
      statusCode: 202,
      locals: {},
      end: () => {
        endCalls += 1;
        return res;
      },
    });
    const req = {
      method: 'POST',
      route: { path: '/api/v1/admin/orders/:id/refund' },
      params: { id: 'o-1' },
      auth: { role: 'admin', sub: 'u-1' },
      body: {},
    } as unknown as Request;
    mw(req, res, () => undefined);
    // 模拟"handler 调了 end()，但 prefinish 从未触发"（管线化 + 连接断开）
    res.end();
    await vi.waitFor(() => expect(entries).toHaveLength(1), { timeout: 2_000, interval: 5 });
    expect(entries[0]?.statusCode).toBe(202);
    // 兜底路径不能把 end 本身弄坏：原方法仍然被调用了一次，返回值也透传
    expect(endCalls).toBe(1);
    // 再补一次 prefinish：fired 保证不会写第二行
    res.emit('prefinish');
    await new Promise((r) => setTimeout(r, 20));
    expect(entries).toHaveLength(1);
  });
});
