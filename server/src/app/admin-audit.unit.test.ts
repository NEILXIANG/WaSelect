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
import { adminAuditMiddleware, auditPayload } from './admin-audit.js';
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
      Object.assign(res, { statusCode: status, locals: {} });
      return res;
    };
    const fire = (status: number, auth: unknown): void => {
      const res = makeRes(status);
      const req = {
        method: 'POST',
        route: { path: '/api/v1/admin/x' },
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
    Object.assign(res, { statusCode: 200, locals: {} });
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
