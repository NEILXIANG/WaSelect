# 第三轮全量逐行审查 · 分片 OPS3（回调 / 退款拒付 / 管理端路由 / 调度任务）

> 基线：jp_project HEAD `50d490b`（工作区干净）。只读审查，未改任何仓库文件。
> 前缀 OPS3。证据等级：【实测】= 跑过探针 / 用例；【读码确认】= 逐行读码可确定；【推断】= 依赖未实测的外部行为。

## 范围与方法

**逐行读完的源文件**（server/src/app/）：pay-callback.ts、webhook-results.ts、mark-paid.ts、mark-disputed.ts、refund-execution.ts、
close-session-events.ts、daily-reconciliation.ts、daily-heartbeat-watch.ts、scheduler.ts、scheduler-start.ts、internal-jobs-routes.ts、
cleanup-idempotency.ts、login-attempts-cleanup.ts、shutdown-cleanup.ts、http-outbound.ts、business-events.ts、block-user.ts、
admin-order-routes.ts、admin-product-routes.ts、admin-ops-routes.ts、admin-auth-routes.ts、admin-banner-routes.ts、admin-upload-routes.ts、
admin-risk-routes.ts、admin-audit.ts、mount.ts、route-snapshot.ts。

**为判断行为而读的相邻代码**：adapters/orders-admin.ts（退款进度 / markRefunded / releaseDisputeHold 等写路径）、adapters/admin-auth.ts
（claim/clear 额度 SQL）、domain/admin-order-actions.ts（refundGuard / shipGuard）、adapters/event-bus.ts（drain）、app/unit-of-work.ts、
app/pay-routes.ts、main.ts 停机段（180–262）。

**读过的测试**：mark-disputed.db.test.ts（AJ-233 相关用例 196–290、770–805）、pay-callback.unit.test.ts、scheduler.unit.test.ts、
admin-audit.unit.test.ts、admin-banner-routes.db.test.ts（DELETE 段）、shutdown-cleanup.unit.test.ts；grep 核对了退款并发用例（不存在）。

**跑过的**（Node 22.22.2）：
- `npx vitest run --project unit` pay-callback / webhook-results / scheduler / admin-audit / shutdown-cleanup / scheduler-start：6 文件 70 条全过（基线）。
- 探针 `round3/probe-refund-guard.mts`：`refundGuard('refunding', true)` → `{"ok":false,"code":40907,"reason":"dispute_open"}`。
- 探针 `round3/probe-drain-inflight-tick.mts`（真 event-bus + 真 withUnitOfWork + 假 db.begin）：
  输出 `drain_returned_pending=0 -> closeDb -> tick_committed -> subscriber_start -> subscriber_done`。

未跑 db / e2e / gate（按分片规则）。

---

## 发现

### OPS3-01【P2】拒付事件乱序到达时，两条路径都回 200 且不可重试：新拒付被丢、或订单被永久锁死

- **位置**：`server/src/app/mark-disputed.ts:329-335`（进行中时来了新单号 → `dispute_id_conflict`）；`mark-disputed.ts:162-170`（结案先到 → `dispute_not_open`）；
  `server/src/app/pay-callback.ts:360-379`（两个 reason 都在 MISMATCH_REASONS → error + 200，机构不再重发）。
- **问题**：AJ-233 让"上一条**已结案**后来的新单号"能进来，但它的正确性依赖**事件按序到达**。代码自己的前提（`markDisputeClosed` 的 @why：查询函撤回后转正式拒付是**新的** dispute_id）意味着 `charge.dispute.closed(du_1, warning_closed)` 与 `charge.dispute.created(du_2)` 是**同一时刻**产生的一对事件，谁先到是随机的。
- **触发场景**：
  1. 查询函 du_1 已落库（open，has_dispute=true）。机构同时发出 closed(du_1) 与 created(du_2)，**created(du_2) 先到** → du_1 仍是 open → `dispute_id_conflict` → 200。随后 closed(du_1) 到 → withdrawn → `has_dispute=false`。结果：真正的正式拒付 du_2 **不在系统里**，发货/退款闸门全开，风控页看不到，举证期限无人知晓；只剩对账里一条 `mismatch:dispute_id_conflict`。
  2. 结案事件先于开案事件到达（开案首投 5xx、机构退避重试时）→ `dispute_not_open` → 200 不重发；之后开案到达 → `has_dispute=true` 且**永远不会再有结案事件** → 订单永久锁死，只能人工 release（B1b 那个口）。
- **证据**：【读码确认】两条分支都抛带 reason 的 40902，管线对 MISMATCH_REASONS 一律 `status: 200`（pay-callback.ts:374-378）。"机构不保证投递顺序"为【推断】（Stripe 官方口径，未在本仓库实测）。
- **修复方案**：这两个 reason 属"暂时对不上、等另一条事件到了就对得上"，应走**可重试**分支：在管线里把 `dispute_not_open` 与"对方仍 open 的 `dispute_id_conflict`"按 `early` 同口径处理（宽限期内 503 + releaseLease，超期再 200 转对账）；或 mark-disputed 在 conflict 时查 `webhook_events` 是否已有该旧单号的 closed 登记。宽限期要按"机构重试节奏"取，而不是订单早到的 30s 量级。
- **应补测试**（先红）：
  - 管线级：du_1 open → 投 created(du_2) → 断言 `status === 503`（现为 200，红）→ 投 closed(du_1) → 重投 created(du_2) → 断言 `payments.dispute_id === 'du_2' && has_dispute === true`。
  - 管线级：closed(du_1) 先投 → 断言 503 且登记行 `processed_at is null`（现为 200 + `mismatch:dispute_not_open`，红）。

### OPS3-02【P2】AJ-233 引入：败诉（lost）之后接受新单号，新单号一旦 won / withdrawn 就把"已败诉"的锁解开

- **位置**：`mark-disputed.ts:329`（只拒 `existingStatus === 'open'`，lost 放行）、`mark-disputed.ts:365-373`（覆盖 `payments.dispute_*`）、`mark-disputed.ts:212`（结案只看**本条**结果：`has_dispute = (c.result === 'lost')`）。
  测试 `mark-disputed.db.test.ts:242-259` 把"lost 后接受新单号"钉成期望，但没有断言新单号结案之后的状态。
- **问题**：`has_dispute` 的语义是"有未解除的拒付限制（进行中，或**已败诉**）"。lost 之后接受 du_2 时，du_1 的 `lost` 被 du_2 的 `open` 覆盖，库里唯一还能说明"这笔钱已输掉"的只剩 order_events 的 note。du_2 以 won / withdrawn 结案 → `has_dispute=false` → 发货、退款闸门重新打开。AJ-233 之前这条路径是 `dispute_id_conflict`，lost 的锁不会被解开——这是**本轮修复引入的回归**。
- **触发场景**：du_1 lost（has_dispute=true）→ 同一笔钱来了 du_2（created）→ 被接受 → du_2 withdrawn（或 won）→ `has_dispute=false`；运营看到订单可发货就发货 = 钱已被拉回、货又发出（钱货两空）；或点退款 → Stripe `charge_disputed` → 停在 refunding。同时风控列表（读 payments 行）上 du_1 的败诉记录消失。
- **证据**：【读码确认】。"lost 之后同一笔扣款还会出现新 dispute_id"在卡组织层面是否常见属【推断】——但既然代码与用例明确接受它，就必须保证它不解锁。
- **修复方案**（二选一）：① 恢复"上一条 lost 时拒绝新单号"（`existingStatus === 'open' || existingStatus === 'lost'` → conflict），lost 的单已锁着，新单号只需进对账；② 若要接受，结案复位条件改为"本条非 lost **且**该支付行历史上没有 lost"（例如新增 `dispute_lost_at` 列，或结案时查 order_events 是否存在 `dispute_closed` note 以 `:lost` 结尾）。
- **应补测试**（先红）：du_1 open → closed lost → created du_2 → closed(du_2, withdrawn) → 断言 `has_dispute === true`（现为 false，红）；并断言风控列表仍能看到一条 lost。

### OPS3-03【P2】退款在途（refunding）期间来了拒付，再点"退款"（=查询 / 同键重放）被 40907 挡死，订单永久停在 refunding

- **位置**：`server/src/domain/admin-order-actions.ts:77-84`（`hasDispute` 判定在 `status === 'refunding'` 放行之前）；`admin-order-routes.ts:302`；`refund-execution.ts:69-82`（在途单的第二次点击本来只是**查询**，不动钱）。
- **问题**：refunding 状态下的"再点一次"有两种形态：有 pendingRef → 查询机构退款对象；上一次结果未知（provider_error）→ **同一幂等键**重放（KD-4，不会产生第二笔钱）。这两种都不会让钱再动一次，但 refundGuard 对 `has_dispute=true` 一律 40907。拒付在 refunding 期间落库是可能的：refunding 时支付行仍是 `succeeded`，`markOrderDisputed` 照常接受（AJ-233 注释自己写着"退款与拒付在机构侧交叉"是真实形态）。
- **触发场景**：管理员退款 → 机构回 pending（或网络超时记 provider_error）→ 买家不知情发起拒付 → has_dispute=true → 管理员再点"退款"想落定 → 40907 `dispute_open`。机构侧退款实际已成功，我方订单永远 refunding、买家时间线永远"退款中"、`stuck_refunds` 每天报警；若拒付以 lost 结案，锁永远不解，唯一出口是人工 release（B1b）后再点——而那时若查询结果为 failed，代码会**换新键再发起一笔**，对一笔已败诉的扣款发退款。
- **证据**：【实测】`probe-refund-guard.mts`：`refundGuard('refunding', true)` → `{"ok":false,"code":40907,"reason":"dispute_open"}`；其余【读码确认】。
- **修复方案**：refundGuard 对 `refunding` 区分"只查询 / 同键重放"与"换新键重新发起"：`status === 'refunding' && hasDispute` 时放行，但把 `hasDispute` 传进 `executeRefund`，在"查询结果为 failed → 换键重新发起"那一步前拒绝（40907），查询与同键重放照常执行。
- **应补测试**（先红）：db 级：订单 refunding + `refund_pending:re_1` 事件 + has_dispute=true，Stripe stub 查询返回 succeeded → POST refund → 断言 202 且订单 `refunded`（现为 40907，红）；同上但查询返回 failed → 断言 40907 且没有发起新的 refund 调用。

### OPS3-04【P2】AJ-243 的"单个 IP 只能锁住它自己"不成立：邮箱桶计数没有时间窗，一个来源慢慢攒满 30 次就能锁住全部来源

- **位置**：`server/src/adapters/admin-auth.ts:140-155`（`failed_count` 只在"达到上限置锁"或"成功登录清零"时归零，`first_failed_at` 写入后**从未参与判定**）；
  `server/src/app/admin-auth-routes.ts:25-26、53-57`（"单个 IP 只能锁住它自己；要锁死所有人得凑够 6 个来源""30 次 / 15 分钟"）；`docs/自主决策记录.md` AJ-243 依据段同样表述。
- **问题**：邮箱桶（30）是**累计**计数，不是"15 分钟内 30 次"。来源桶锁 15 分钟到期后同一个 IP 又能再试 5 次，每次都给邮箱桶 +1。
- **触发场景**：攻击者只有 1 个 IP、知道管理员邮箱：每 15 分钟试 5 次（恰好也在 IP 限流 5/15min 之内）→ 约 75–90 分钟后邮箱桶到 30 → **所有来源**（包括管理员自己的办公网络）被锁 15 分钟 → 计数归零、继续攒。持续效果：约每 90 分钟锁住管理员 15 分钟；两三个 IP 就能把间隔压到半小时以内。管理员的一次成功登录会把邮箱桶清零，但被锁的那 15 分钟里他登不上。SEC2-01 的"单 IP 可持续影响管理员登录"因此只是被**稀释**，不是 AJ-243 所说的"只能锁住它自己"。
- **证据**：【读码确认】（SQL 的 on conflict 分支无任何基于 `first_failed_at` / `last_failed_at` 的重置；本分片不跑 db 项目，未做库上实测）。
- **修复方案**：给邮箱桶加滑动/固定窗口：`on conflict` 时若 `la.first_failed_at <= now - lockMinutes` 则 `failed_count = 1, first_failed_at = now`（从新窗口起算），来源桶同理；并更正 admin-auth-routes.ts 头注释与 AJ-243 依据段的"6 个来源"论证（约束六：注释与实现不符视为缺陷）。
- **应补测试**（先红）：db 级：同一邮箱、同一来源，按 6 个 16 分钟间隔各失败 5 次（注入时钟推进）→ 断言第 31 次从**另一个来源**用正确口令登录得 200（现为 42901，红）。

### OPS3-05【P3】停机不等在途的调度轮 / daily 作业：tick 在 drain 之后才提交，`order.expired` 的会话作废拿到已关闭的连接池（AJ-237 覆盖面缺口）

- **位置**：`server/src/main.ts:209`（`scheduler.stop()` 只清定时器）、`main.ts:221-226`（`drainEventsThenClose` 只等"已发出的"订阅者）；`scheduler-start.ts:23-25、140-142`（@limitation 二自述"优雅关闭的正确顺序是…等在途请求…"，但 tick 不是请求，没人等它）；`internal-jobs-routes.ts:79-100`（daily 作业 202 之后在进程里跑，同样不被任何停机步骤等待）。
- **问题**：drain 只能等"已经 publish 的事件"。一轮在途 tick（expire-orders）若在 drain 返回 0 之后才提交，它的 `order.expired` 在 `closeDb` 之后才分发，`close-session-events` 的 `voidInitiatedPayment` 与机构会话作废都拿不到连接。
- **触发场景**：部署 / 重启时 SIGTERM 恰好落在一轮 tick 的事务中（tick 每 60s 一轮，关单较多时事务可持续数百毫秒以上）：订单已 expired 并提交，但 Stripe 会话没作废、支付行仍 initiated → 用户在会话自然过期前仍可付款 → `late_payment` → 人工退款；`dangling_initiated_payments` 次日报出。daily 作业若在部署窗口内运行则整轮回滚、当天不再跑，要 26 小时后才被看门狗报出。
- **证据**：【实测】`probe-drain-inflight-tick.mts`：`drain_returned_pending=0 -> closeDb -> tick_committed -> subscriber_start`（真事件总线与 unit-of-work，db 用假 begin；真实连接池下订阅者的查询在 `end()` 之后会被拒，该点为【推断】）。
- **修复方案**：`SchedulerHandle` 增加 `stopAndWait()`（记住当前 tick 的 Promise）；daily 端点把句柄登记到同一个"在途作业集合"；停机流改为 `await scheduler.stopAndWait(); await dailyJobs.wait(budget); drainEventsThenClose(...)`，预算纳入 SHUTDOWN 总预算。
- **应补测试**（先红）：`scheduler-start.unit.test.ts`：tick 的 unitOfWork 卡在 gate 上时调用 `stopAndWait()`，断言它在 gate 释放、事件发出之后才 resolve；`shutdown-cleanup.unit.test.ts` 断言顺序 `['tick_done','drain','closeDb']`。

### OPS3-06【P3】退款"确认失败"次数按事件行计数，并发点击时同一单号被记两次，下一把幂等键被跳过

- **位置**：`server/src/adapters/orders-admin.ts:531-533`（`confirmedFailures = count(refund_failed where note like 'provider_failed%')`，不去重）；`refund-execution.ts:84-96`（查询确认失败时先写事件再 `attempt += 1`）；两次请求在第一段事务提交后并行进入第二段，没有互斥。
- **触发场景**：订单 refunding、最新事件 `refund_pending:re_1`。两位管理员（或同一人双击，前端未拦住时）同时点"退款"：两边都查到 re_1 failed → 各写一条 `provider_failed:re_1` → 各用 attempt=k+1 发起（同键，机构只执行一次）。若这次结果未知（超时，记 provider_error），KD-4 要求下一次**沿用同一把键**，但此时 `confirmedFailures = k+2` → 下一次用新键 k+2 发起。对全额退款 Stripe 会以"超过可退金额"拒绝（不会真退两次），订单停在 refunding 等人工；对将来接入的其他通道则取决于通道侧有没有额度校验。
- **证据**：【读码确认】（无并发用例；grep 确认 stripe-golden-chain / orders-admin-write 均无 Promise.all 的退款用例）。
- **修复方案**：`confirmedFailures` 改为按**不同单号**计数（`count(distinct note)`）；更彻底的做法是第二段开始前 `select … for update` 一条"退款进度"行或用 advisory lock（`refund:<orderId>`）把同一单的第二段串行化。
- **应补测试**（先红）：`orders-admin-write.db.test.ts`：插两条 `refund_failed / provider_failed:re_1` → 断言 `findRefundProgress().confirmedFailures === 1`（现为 2，红）。

### OPS3-07【P3】拒付的两个领域事件没有任何订阅者，注释却写"事件会进日志"

- **位置**：`mark-disputed.ts:393`（"⚠️ 只带单号：事件会进日志"）；`business-events.ts:31-36`（LOGGED_EVENTS 不含 `order.dispute_opened` / `order.dispute_closed`）；全仓 `subscribe(` 只有 business-events 与 close-session-events 两处。
- **问题**：两个事件 emit 出去即落空；注释与事实相反（约束六），也让"拒付何时落库"只能从回调管线的 `pay_callback_handled` 反推，不在业务事件流里（约束七：关键路径要能还原）。
- **证据**：【读码确认】（`grep -rn "name: 'order\.\|subscribe("`）。
- **修复方案**：把两个事件加进 LOGGED_EVENTS（payload 只有 dispute_id / result，无 PII）；或删掉 emit 并改注释。
- **应补测试**：`business-events` 用例断言 LOGGED_EVENTS ⊇ 全仓 emit 的事件名（从源码扫 `name: 'order.` 得出集合），缺一个即红。

### OPS3-08【P3】Banner DELETE：不可逆删除不留改前值，删不存在的 id 也写一行审计

- **位置**：`admin-banner-routes.ts:155-165`（未 `setAuditBefore`，0 行命中也 204）；`admin-audit.ts:8-9`（"有审计行 ⇔ 改动真的发生了"）、`admin-audit.ts:23-24`（不可逆操作才取改前值）。
- **触发场景**：运营误删首页 banner → admin_audit 里只有 `DELETE /admin/banners/:id`、target、after=null，答不出被删的是哪张图、链到哪（与运费整表替换同一类"之前是多少"问题）；双击删除 → 两行审计都声称删了，与中间件自述的等价关系不符。
- **证据**：【读码确认】。
- **修复方案**：删除前读出行并 `setAuditBefore(res, toBanner(row))`；0 行命中时 `setAuditBefore(res, null)` 并在 after 里标注 `noop`，或把 0 行命中改为不写审计（中间件支持路由显式 `res.locals.adminAuditSkip`）。
- **应补测试**：db 级：删除存在的 banner → 断言 admin_audit.before.image_key 等于原值（现为 null，红）。

---

## 看过、确认没有问题的高风险点（不展开）

- 回调幂等：claim → new/retry 才处理；handled → 200 duplicate；inflight → 503；早到交还租约（pay-callback.ts:192-314）。
- `paid` 后迟到 `checkout.session.expired`：outcome=expired 无落账器 → `ignored:expired`，不改订单（pay-callback.ts:251-270）。
- 关单后到账：expired / cancelled 统一 `late_payment`（mark-paid.ts:201-207），对账扫得到。
- 同一退款重复落定：`markRefunded` 带 `status='refunding'` 条件，重复 settle 为 no-op。
- webhook result 词长：所有已用 reason 拼上前缀均 ≤ 32（最长 `mismatch:dispute_result_conflict` = 32）。
- 管理端每条路由都挂了 `requireRole('admin')`；审计中间件先于全部管理端路由挂载（mount.ts:232）；内部作业端点 timingSafeEqual 且无头先拒。
- AJ-243 的"自己这次 claim 置上的锁可由自己清"（R-02 修复）在两层桶上都正确传递了 `ownLockUntil`。
- AJ-233 的"已结案拒付重放不重新上锁"（mark-disputed.ts:349）与"refunded 支付行可落拒付"均有用例覆盖。

## 统计

| 级别 | 条数 | 编号 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 4 | OPS3-01、OPS3-02、OPS3-03、OPS3-04 |
| P3 | 4 | OPS3-05、OPS3-06、OPS3-07、OPS3-08 |

其中由上轮修复引入 / 修复不完整：OPS3-02（AJ-233 回归）、OPS3-01（AJ-233 只覆盖按序到达）、OPS3-04（AJ-243 论证不成立）、OPS3-05（AJ-237 覆盖面缺口）。

## 上轮遗留状态（本分片文件范围内）

- B2（已付单第二笔付款记成 `paid:already`，对账不扫）：仍存在（mark-paid.ts:208-210、pay-callback.ts:380-397、daily-reconciliation.ts:153）。
- B1b（人工解除拒付限制不看拒付状态）：仍存在（admin-order-routes.ts:438-453、orders-admin.ts:594-597）。
- B21（上传文件流无 `'error'` 监听，畸形 multipart 可致进程退出）：仍存在（admin-upload-routes.ts:73-79）。
- B29（大像素图 OOM）：仍存在（未见像素上限，admin-upload-routes.ts:108）。
- SEC2-02（两段式退款 5xx 时不留审计）：仍存在（admin-audit.ts:84）。
- SEC2-04（未配密钥时带任意头即可刷 error）：仍存在（internal-jobs-routes.ts:63-68）。
- SEC2-09（`setAuditBefore` 的值不经脱敏）：仍存在（admin-audit.ts:91）。
- PAY2-01 / PAY2-02：位于 Stripe 适配器，不在本分片文件内，未复核。
