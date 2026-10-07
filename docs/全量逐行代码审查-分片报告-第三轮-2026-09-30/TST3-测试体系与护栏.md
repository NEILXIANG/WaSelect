# TST3 分片：测试体系与护栏（第三轮全量逐行审查，HEAD 50d490b）

## 范围与方法

- **读过的文件**：`vitest.config.mts`、`vitest.coverage-gates.ts`、`test/db/test-db.ts`（+ `test-db.unit.test.ts` 相关段）、`test/setup/network-guard.ts` / `install-network-guard.ts`、`test/factories/manifest/engine.ts` / `us-address.ts` / `us-address.unit.test.ts`、`test/factories/catalog.ts`（地址池与反例段）、`test/factories/stripe.ts`（头部与豁免名单）、`test/factories/rng.ts`、`test/lint/decision-log.lint.test.ts`、`test/lint/idempotency-request.lint.test.ts`、`test/config/coverage-threshold.unit.test.ts`、`test/config/test-file-placement.unit.test.ts`、`server/src/config.contract.test.ts`、`server/src/adapters/db.db.test.ts`（结构不变量段）、`miniprogram/vm-guard.unit.test.ts`、`nav-param-guard.unit.test.ts`、`review-wording-guard.unit.test.ts`、`test/e2e/harness.ts`（appliers 段）、`test/helpers/seed-order.ts`、`scripts/pre-commit`、`package.json` scripts；抽查 `mark-disputed.db.test.ts`、`admin-auth-routes.db.test.ts`、`stripe-golden-chain.db.test.ts`（退款 F-03 段）、`auto-fulfilment.db.test.ts`、`test/db/migrations.db.test.ts`；对照 `docs/自主决策记录.md`、第一轮 TSA/TSB 分片、第二轮总报告与 DB 分片（DB2-09）。
- **探针（均在 scratchpad，未改仓库任何文件）**：
  - `decision-probe.mjs`：统计决策台账里有多少条目落在 lint 的解析范围之外、查全文重复编号。
  - `decision-mutate.mjs`：复刻 `decision-log.lint.test.ts` 的五条判定，对只读副本做 4 种变异。
  - `addr-pool-probe.ts`（`npx tsx`）：把形态清单守护的地址池喂给应用层 `parseAddressInput` 和小程序 `formErrors`，再模拟 FX5 回归（50 州白名单）。
  - `vitest related server/src/app/auth.ts --project unit`：看 `test:fast`（pre-commit）会不会触发扫描型守卫。
  - 读取仓库已有的覆盖率产物 `coverage/coverage-summary.json`（11:43 生成，HEAD 提交时间 11:50），算全局阈值的余量。
- **跑过的测试**：`npx vitest run --project lint test/lint/decision-log.lint.test.ts` → 5/5 通过（在全文有重复编号的情况下）。**没有**跑 db / e2e / gate。

---

## 一、新发现

### TST3-01【P2】决策台账 lint 只解析 §1，AJ-200～AJ-244 共 46 条完全不受检查；全文已有重复编号 AJ-225，门禁仍然是绿的

- **位置**：`test/lint/decision-log.lint.test.ts:39-48`（`doc.split(/^## 2\./m)[0]`）、`:88-95`；`docs/自主决策记录.md:7034`（`## 2.`）、`:7419` 起（AJ-200 以后的条目全部追加在 §4 之后）、`:8602` 与 `:8646`（两条 `### AJ-225`）、`:7405`（§4.1 表格）。
- **问题**：
  1. `entries()` 只取 `## 2.` 之前的文本。从 AJ-200 起，新条目都追加在文件末尾（§2 / §3 / §4 之后），违反了 §4 自己写的“§1 末尾追加”。结果是这 46 条的七项字段、依据长度、编号唯一这三项检查全部不执行。
  2. 全文已有两条 `### AJ-225`（一条是支付跳转参数名，一条是复核回归 R-03），与 CLAUDE.md 抬头“编号重复……都会红”的说法矛盾。
  3. §3 的存在检查用 `doc.toContain('仍然需要人拍板')`。§4.1 的红灯验证表格（7405 行）里恰好写着“把「仍然需要人拍板」改名”，于是 §3 标题被改名或删掉内容后，这个子串仍然能在表格里匹配到。表格里声称的那次“红 ✅”，现在已经不再成立。
- **触发场景**：下一条 AJ 缺「反向风险」或「回滚」、依据只写两个字，或者再撞一次号，只要它追加在文件末尾（当前所有新条目都在末尾），`npm run test:lint` 和 gate 都是绿的。CLAUDE.md 列为“有机器校验”的这条自主决策入档要求，实际对最近 46 条没有任何强制。
- **证据【实测】**：
  - `decision-probe.mjs`：lint 解析到的 §1 条目 198 条，全文 AJ 条目 244 条，**§1 之外 46 条（AJ-200～AJ-244）**，全文重复编号 `['AJ-225']`。
  - `decision-mutate.mjs`：原文 → 绿；M1 把 §3 标题改成「其它」→ **绿**（被 §4.1 表格掩盖）；M2 在文末追加一条七项全缺的 `### AJ-245` → **绿**；对照组 M4 在 §1 内部撞号（AJ-199→AJ-198）→ 红 `dupid`。另有 M3：把 AJ-199 改成与 §1 之外条目同号的 AJ-230 → 绿，说明跨区撞号也查不到。
  - 真实 lint 运行：`decision-log.lint.test.ts` 5 passed。
- **修复方案**：
  - 解析改为全文所有 `^### AJ-\d+` 标题块，不再依赖章节位置。
  - 同时加一条位置断言：所有 AJ 块必须位于 `## 1.` 与 `## 2.` 之间。要么把 AJ-200～244 挪回 §1，要么改写 §4 的位置约定，二者选一，并记入决策记录。
  - §2 / §3 的检查改为直接匹配标题行：`/^## 2\. 被实测推翻的判断/m`、`/^## 3\. 仍然需要人拍板/m`。
  - 把两条 AJ-225 中较晚的一条改号，并在 §2 记一笔。
- **应补测试**：在 lint 文件里加自检用例，对内存副本做上述 M1 / M2 / M3 三种变异并断言必红，防止解析范围再次悄悄缩小。

### TST3-02【P2】形态清单守护的地址池只喂给了 DB CHECK，应用层与小程序两道真正拦用户的校验从没见过军邮、属地、PO Box；FX5（州码白名单误杀军邮）重犯时全绿

- **位置**：`test/factories/manifest/us-address.ts`（清单）；`test/factories/addresses.db.test.ts:100-160`（整个仓库唯一消费 `US_ADDRESSES` 全量的地方，只插表）。对照被测的两道校验：`server/src/domain/address-input.ts:104`（服务端 40002）和 `miniprogram/utils/address-form.js:44-48,117`（前端预检）。它们的用例：`address-input.unit.test.ts`、`address-routes.db.test.ts`、`address-form.unit.test.ts`。
- **问题**：约束三和 H2 把形态清单当作“边界维度不漏”的机制，`us-address.ts` 头注释也把 FX5「州码白名单会误杀军邮码」列为这份清单抓到的成果。但清单只保证样本池里有这些形态。池子只被 `addresses.db.test.ts` 用来撞 DB 约束，从没经过 `parseAddressInput`、`POST /addresses` 或小程序的 `formErrors`。这两处校验的现有用例里，合法州码只出现过 `CA` / `NY`，邮编只有 `95014` / `94102-1234` 这类，没有任何一条是 AA / AE / AP / PR、以 0 开头的邮编、PO Box 或公司收件人。
- **触发场景**：有人在 `address-input.ts` 或 `address-form.js` 里把 `^[A-Z]{2}$` 收紧成 50 州 + DC 白名单。这是 FX5 的原始形态，而且看起来更严谨。现有全部用例保持绿；上线后，驻日美军基地（APO/FPO，AE/AP）和波多黎各的买家在填地址这一步就被拒（40002 或前端红字），下不了单。
- **证据【实测】**（`addr-pool-probe.ts`）：
  - 当前两道校验对池子 18 条全部放行：应用层拒 0，前端拒 0。所以补测试不需要改生产代码。
  - 注入 50 州白名单后：现有用例的样本被拒 **0** 条，也就是全绿；池子被拒 `AE, AP, AA, PR`。
- **修复方案**：把 `US_ADDRESSES` 全量接进另外两道校验，形成三层同池：
  - `address-input.unit.test.ts` 与 `address-form.unit.test.ts` 各加一条 `for (const a of US_ADDRESSES)`，断言都能通过。
  - `US_ADDRESS_INVALID` 同样逐条喂两层，断言被拒。
  - 在 `manifest/engine.ts` 的 `@limitation` 里写明：清单只管池子，池子要被哪些消费方吃掉，需要逐一登记。
- **应补测试**：见上。做缺陷注入时，把 `address-input.ts:104` 改成 50 州白名单，新用例必须红。

### TST3-03【P2】覆盖率只有全局汇总阈值、没有逐文件下限：新增一个几百行、零测试的模块 gate 照样绿；`admin-web/src/api/endpoints.ts` 目前就是 0%

- **位置**：`vitest.coverage-gates.ts:68-72`（全局 85 × 4，没有 `perFile`）；`test/config/coverage-threshold.unit.test.ts`（只验阈值键能命中文件，不验每个文件都有覆盖）。
- **问题**：vitest 的全局阈值是按全体汇总来比较的。当前汇总余量很大，能吸收大量零覆盖代码。约束一“无测试不前进”在机器层面只剩逐文件 100% 名单那 40 余个文件；名单以外的新文件，零测试也能过 gate。
- **触发场景**：新写一个 150 行的路由或 Provider 方法、完全不写测试，`npm run gate` 仍然全绿。现成的例子是 `admin-web/src/api/endpoints.ts`（管理端登录与响应形状校验，55 行）：lines / branches / functions 都是 **0**，全仓没有任何测试 import 它；`admin-web-client.e2e.test.ts:15` 的 `@limitation 一` 还写着“登录服务端尚未实现”，实际早已实现。它的“契约漂移按 NETWORK_ERROR_CODE 硬失败”这条防线从未被执行过。
- **证据【实测】**（读取已有 `coverage/coverage-summary.json`，171 个文件）：全局 branches 4175/4544（91.87%）。在不跌破 85% 的前提下，还能再加 **367 个零覆盖分支 / 737 行 / 191 个函数 / 768 条语句**。`endpoints.ts` 在同一份产物里是 0 / 0 / 0，而第二轮报告记录的最后一轮 gate 是 `gate-exit=0`。
- **修复方案**：
  - 加一条逐文件下限：vitest 的 `perFile` 设一个较低的底线（例如 lines ≥ 60），或者在 `coverage-threshold.unit.test.ts` 旁边加一步脚本，读取 `coverage-summary.json`，断言 include 范围内每个文件 lines > 0，豁免名单逐条写原因。
  - `endpoints.ts` 补单测（形状错时报 NETWORK_ERROR_CODE、traceId 贯穿），并更正 e2e 的过时 limitation。
- **应补测试**：对“每个文件 > 0”的检查本身做注入：新建一个无测试的 `.ts`，检查必须红。

### TST3-04【P3】扫描型守卫在提交钩子（`test:fast --changed`）里触发不了；`coverage-threshold.unit.test.ts` 的 `@limitation 三`（“提交时就能拦住”）不成立

- **位置**：`scripts/pre-commit`（只跑 `test:fast` = `vitest run --project unit --changed HEAD~1`）；`test/config/coverage-threshold.unit.test.ts:20-21`；同类守卫：`miniprogram/vm-guard.unit.test.ts`、`test/config/test-file-placement.unit.test.ts`、`nav-param-guard`、`review-wording-guard`。
- **问题**：`--changed` 只运行 import 图上与改动文件相关的测试。上面这些守卫都是用 `readdirSync` / `readFileSync` 扫文件，不 import 被守的源码，所以真正会触发它们的改动（搬走 `auth.ts`、新建 `index.vm.js`、新写一个孤儿测试文件）不会让它们在提交时运行。
- **触发场景**：R2-1 那次真实事故（把 `auth.ts` 搬进 `app/`，阈值键静默失效）如果重演，提交钩子是绿的，只有跑完整 gate 才会发现。注释承诺的“提交时拦住”不存在。
- **证据【实测】**：`vitest related server/src/app/auth.ts --run --project unit` 只命中 4 个文件：`auth.unit.test.ts`、`rate-limit.unit.test.ts`、`http.unit.test.ts`、`main.unit.test.ts`。**不含** `coverage-threshold.unit.test.ts`。
- **修复方案**：在 `test:fast` 之后固定追加一次 `vitest run --project unit test/config miniprogram/*-guard.unit.test.ts`（都是毫秒级）；同时更正那条 `@limitation 三`。

### TST3-05【P3】DB 结构不变量“任何 status 列都有域约束”按列名精确匹配 `status`、按表粒度做子串判断：`payments.dispute_status` 不在覆盖内，且同表任何含 status 字样的 CHECK 都能掩盖主状态列缺约束

- **位置**：`server/src/adapters/db.db.test.ts:505-538`（`a.attname = 'status'`；`checks.filter(def.includes('status'))` 按表归并）；`migrations/001_init.sql:159`（`dispute_status VARCHAR(16)`，无 CHECK）。
- **问题**：
  1. `dispute_status` 决定 `has_dispute` 是否复位，是状态机列，但因为列名不是 `status` 而不进不变量。`mark-disputed.ts:190,368` 写入的是 `open / won / lost / withdrawn`，库层没有任何域约束。
  2. 判定是“这张表上**任意** CHECK 的定义里出现 `status` 子串”。一旦有人给 `payments` 加 `CHECK (dispute_status IN (...))`（这正是对第 1 点最自然的修法），之后再有迁移误删或改名 `payments_status_domain`，不变量仍然是绿的。
- **触发场景**：将来某次改写把 `c.result` 原样写成 Stripe 的原始状态（例如 `warning_closed`），库照收；风控列表按 `withdrawn` 筛不到这一条，这条拒付的锁再也没人能解。
- **证据【读码确认】**：见上述行号；`grep CHECK migrations/*.sql` 显示 `dispute_status` 上没有任何约束。
- **修复方案**：
  - 状态列清单改为 `attname ~ '(^|_)status$'`。
  - 判定改为逐列：解析 `pg_constraint.conkey`，要求约束覆盖这一列，并且定义形如 `<col> = ANY (ARRAY[...])`。
  - `dispute_status` 补 CHECK，或进豁免名单并写明原因。
- **应补测试**：注入“删掉 `payments_status_domain`、另加一条 dispute_status CHECK”，不变量必须红。

### TST3-06【P3】审核文案守卫漏掉审核路径上最显眼的一处：mock 通道按钮文案「模拟支付」来自服务端写死的常量，守卫的豁免理由（“管理端配置的事”）不成立

- **位置**：`miniprogram/review-wording-guard.unit.test.ts:11-12,19`（`FORBIDDEN` 只有三个词，不扫服务端）；`server/src/adapters/payment/channels.ts:75`（`mock: {…, label: '模拟支付'}`）；`miniprogram/utils/pay-plan.js:48,163-170`（按钮文案 = `label（金额）`）。
- **问题**：守卫头注释说审核期全店只开 mock 通道，所以不许在界面上自述“审核期/测试单”。而审核员在支付页实际看到的按钮是「模拟支付（¥…）」，这个文案来自 `channels.ts` 的内置表，不是管理端配置：CLAUDE.md 约束四写明 `payment_channels` 表尚未接线。守卫的 `@limitation` 以“那是管理端配置的事”为由排除服务端，这个前提与现状不符。
- **⚠️ 2026-10-06 更新（AJ-379）**：`payment_channels` **已接线**，通道 `label` 现在由库里那行决定（改数据 + 重启即生效，不必发版）。本条的**前提已变**——"文案写死在常量里"不再成立；但**结论不变**（审核员仍会看到「模拟支付」，因为 seed 里就是这个值）。修复路径因此多了一条最省的：**提审前 UPDATE 那一行 label**；守卫是否要扫服务端仍是独立问题。
- **触发场景**：提审时，审核员在支付页看到“模拟支付”，与 AJ-244 要避免的“审核版与线上版不一致”是同一类驳回理由，而守卫一直是绿的。
- **证据【读码确认】**：见上述行号。
- **修复方案**：守卫扫描范围加上 `server/src/adapters/payment/channels.ts` 里的 `label:` 值，`FORBIDDEN` 加「模拟」；或者把 mock 的 label 改为中性文案，并在提审备注里说明。修的时候与 MP 分片对齐，不要各改一半。

### TST3-07【P3】测试文件归属守卫与 unit 层 include 都不认 `.test.tsx`：第一个用 JSX 写的管理端组件测试会静默不跑

- **位置**：`test/config/test-file-placement.unit.test.ts:53`（`/\.test\.(ts|js|mts)$/`）；`vitest.config.mts:46`（`**/*.unit.test.ts`）。
- **问题**：管理端现有的 4 份组件测试都是 `.dom.unit.test.ts`，靠 `createElement` 写，所以暂时没事。下一份写 JSX 的组件测试必须命名为 `.tsx`：unit 层不会收它，归属守卫也不会把它当成测试文件，gate 全绿，这份测试一次都没跑过。这正是归属守卫文件头要防的形态（“写了测试”与“测试在跑”长得一模一样），只是它的收集正则自己漏掉了。
- **证据【读码确认】**：见上述行号；当前仓库里 `find -name '*.test.tsx'` 为空。
- **修复方案**：归属守卫的收集正则改为 `/\.(test|spec)\.[cm]?[jt]sx?$/`；unit 层 include 同步加 `**/*.unit.test.tsx`，或者明确禁止 `.tsx` 测试并让守卫对它报红。

### TST3-08【P3】AJ-216 分库的防复发断言是纯文本查针：只证明配置文件里有这串字，不证明 e2e worker 真的连到 `japan_shop_e2e_test`

- **位置**：`test/db/test-db.unit.test.ts:79-91`；`vitest.config.mts:99`。
- **问题**：断言内容是 `cfg.toContain("TEST_DB_PROJECT: 'e2e'")`。下面几种情况都会让分库失效，而这条断言保持绿：
  - 把同样一行也加到 `db` 项目上，两边又用回同一个库；
  - vitest 升级后，project 级 `env` 注入 worker 的时机或语义变了（本仓库已在 vitest 5）；
  - 这串字被挪进注释。
  这条用例的 `@why` 说的正是“删掉它测试照样全绿、flake 照样回来”，但文本检查只防住了“删掉”这一种情况。
- **触发场景**：`cov` 一轮里 db 与 e2e 又开始互相 TRUNCATE，`admin-ops-routes.db.test.ts` 那种“刚写入就读回 0”的随机红灯回来，而分库的防复发断言是绿的。
- **证据【读码确认】**。
- **修复方案**：在 e2e 层加一条运行时断言：`select current_database()` 必须等于 `japan_shop_e2e_test`；db 层对称加一条等于 `japan_shop_test`。文本断言可以保留，作为提交期的快速信号。

---

## 二、看过但不是问题

- `test/db/test-db.ts`：库名一律由 `testDbNameFor` 生成，外部连接串里的库名会被覆盖；有 `_test` 后缀与本机闸门；只有 e2e 注入 project 标签。contract 层不触库（6 个 contract 文件中只有 `config.contract.test.ts` 提到 `DATABASE`，只是读键名），与 db 层同库没有风险。配置表没有指向业务表的外键，所以 `TRUNCATE … CASCADE` 不会把配置表连带清掉。
- `config.contract.test.ts`：白名单每条有原因、有反向校验、有非空下限；`HOST` / `PUBLIC_API_BASE` 已进 schema。
- `rng.ts` 是有种子的；fast-check 未固定全局种子，但失败时会打印种子，可以复现。服务端时间一律经 `clock` 注入，没有 SQL `now()` 与假时钟混用。
- 微信支付回调夹具：仓库还没有微信支付 Provider，不适用（约束三那一条待接入时再落）。
- 抽查的 5 个关键 db 测试：`mark-disputed.db.test.ts`（开案、结案、撞号、通道、币种、金额、换读取方）和 `stripe-golden-chain.db.test.ts` 的退款 F-03 段（pending 查询不再 POST、确认失败后换键、查询失败不记失败）断言强度高，每条都断言库状态、事件、出站调用次数。`admin-auth-routes.db.test.ts` 的并发封顶用例已改为与到达顺序无关的不变量。`create-order` / `pay-callback` 本轮只看了结构，没发现新的弱断言。

## 三、上轮遗留状态

| 原编号 | 状态 |
|---|---|
| B46（自动签收/完成的状态过滤无测试） | 仍存在：`auto-fulfilment.db.test.ts` 仍没有“计时列已过期但状态不对”的种子 |
| B47（Stripe 会话 TTL 自证） | 仍存在：没有任何一处用字面量 1800 钉住 |
| B48（DUMMY_HASH 计时防线无测试） | 仍存在：`admin-auth-routes.db.test.ts:94-103` 只比对响应体与计数 |
| B49（e2e harness 缺拒付落账器） | 仍存在：`harness.ts:186-197` 只装了 `succeeded` |
| B50（主链路走预留边、单号 `W-`） | 仍存在：`seed-order.ts:31-33` |
| B51（迁移往返只测“回滚到底”） | 仍存在：`migrations.db.test.ts:85` |
| DB2-09（钱与安全核心未进逐文件门槛） | 仍存在；另据覆盖率产物，`payment-intent.ts` 分支 66.7%、`create-order.ts` 81.8%、`cancel-order.ts` 75%、`quote-assembly.ts` 73.9%，同样不在名单中 |
| TSB-11（`#` 正则永不命中等扫描范围漏洞） | 仍存在（`us-address.ts:65`） |
| TSB-12（network-guard 只拦 fetch、`startsWith` 放行） | 仍存在（`network-guard.ts:64`） |

## 四、统计

| 级别 | 条数 | 编号 |
|---|---|---|
| P1 | 0 | — |
| P2 | 3 | TST3-01、TST3-02、TST3-03 |
| P3 | 5 | TST3-04 ～ TST3-08 |
