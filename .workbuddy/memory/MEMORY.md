# 项目长期笔记（精简版 2026-09-27；细节见同目录 YYYY-MM-DD.md 日志）

## 0. 双库分工（2026-09-19 定）
- `/Users/neilxiang/Documents/me/jp`＝**治理/业务文档库**（git `WaSelectDoc`）→ 公司设立/股权/商业模式/支付资金/总控三账/**产品需求与设计 PRD/GUI**
- `/Users/neilxiang/Documents/me/jp_project`＝**工程开发库**（git `WaSelect`）→ 代码/架构/技术选型。**工程侧单一事实源在此，两边互指链接、不重复数字**
- 远端：jp→`git@github.com:NEILXIANG/WaSelectDoc.git`；jp_project→`github.com/NEILXIANG/WaSelect`（fetch https / pushURL ssh）
- jp 治理规则（README §6）：改口径**先**改 README §5 + 决策日志 + ADR，**再**改文档；md 头必须有「状态：」；非"已定"不得当依据；提交前 `bash scripts/check-docs.sh`

## 1. 现行口径（写新文档前必看）
- **主体**：日本株式会社（KK）单主体，三职合一；北美公司延后、不为收单
- **支付**：小程序内＝微信支付跨境机构模式（主）；小程序外＝Stripe Japan（并行）；银行卡唯一入口＝**短链→Stripe Checkout 托管页**（D-49，已废 H5 收银页/web-view/换票口径）
- **货币锚**：**JPY 唯一定价锚＝结算币＝记账币**；`price_usd` 仅派生展示，**禁参与金额计算**
- **股权（D-62）**：資本金 ¥3,000,000（1 株 ¥1），設立時発行 3,000,000 株（红 1,944,900／向 824,100／陈 132,000／萍 99,000），授权 10,000,000 株；代表取締役 萍子（南雲國萍）；本店 埼玉県さいたま市
- **关税**：美国 2025-08-29 起取消 de minimis，日本货不分货值 **15%**；加拿大 GST/HST 13%；MVP 用 DDP
- **技术栈（ADR-12/13/14）**：原生小程序 WXML/WXSS/TS ｜ Node.ts ｜ `postgres.js`+显式 SQL+`node-pg-migrate`（不用 Prisma）｜ **Render**（Oregon，Web Starter $7+PG $6；禁免费档；静态走 CF R2/Pages）｜ cloudflared 隧道

## 2. 🔴 不可违反的红线
- **运费取档方向（D-46，运营事故级）**：`max_weight_g` 是「上限（含）」，取**第一个 ≥ 包裹重**的档（向上）。Excel `VLOOKUP(...,TRUE)` 向下取档→**每单少收 900–1,000 円且静默**。后端唯一 SQL：`WHERE max_weight_g >= $w ORDER BY max_weight_g ASC LIMIT 1`；**自测向量 `w=1850 → 4950`（返回 4050 即错）**
- **出站重试（AJ-54/55）**：判定纯函数放 `ports/http-client.ts`；🔒 **POST 无幂等键 → 超时/5xx/网络错误一律不重试**（429 例外）；⏱ 总预算 `totalBudgetMs` 默认 6s 单独封顶；抖动由注入 `rand` 提供。熔断已接线默认开启
- **测试外网闸门（AJ-56）**：`setupFiles` 给每个测试文件装上，未放行出站直接抛错；只放本机。教训：**能力模块与安装模块必须分文件**，否则"安装是否生效"是自证（§2 第 21 条）
- **回调统一入口（AJ-52/53）**：只有 `/pay/callback/{channel}`；`GET /pay/channels` 驱动前端渲染（不写死）。🔑 注册表三方法语义不同：`get()`=新单（禁用即不可用）／`getForRefund()`=老单退款／`getForCallback()`=老单回调（**禁用也不拦**）
- **落账绑定通道（AJ-93）**：`markOrderPaid(db,events,clock,orderId,settlement)`，settlement 是判别联合（provider｜simulated），"没传通道"编译不过；回调缺 currency/amount_minor 一律拒（不静默）
- **F10 禁业务侧 `new Date()`**：时间走注入时钟；job 用 `ctx.startedAt`，SQL 用 `make_interval`
- **D-45 心跳可观测**：`job_runs` 是看门狗唯一出口；失败轮只更新 `last_error`、不动 `last_success_at`

## 3. 架构可扩展性（ADR-28，用户硬性要求）
业务核心**不认识**任何具体支付方式/国家/UI：① 分层 `domain/ports/adapters/app` 单向依赖，ESLint 进 gate；副作用走领域事件 ② Provider 注册表 + capabilities + `payment_channels` 配置表（上下线不发版）③ 多国家 = `country_profiles`+`shipping_rates.dest_country`+`duty_rates`+`app_config` ④ UI = design token + section schema + 模板渲染，禁写死色值/金额/税率/国家/承运商/模块顺序。
⚠️ **表数真源 = `jp_project/server/src/adapters/db.db.test.ts` 表清单断言**（不是 ADR 文档）；`country_profiles` 是配置表，已在 `resetTestDb` 排除名单，被清后不自动补 seed。

## 4. 注释与日志（ADR-29，用户硬性要求）
注释必须写清逻辑、**缺点**与优点：`@limitation`（已知缺陷）+ `@tradeoff`（放弃什么）+ `@see ADR-xx/D-xx`；只写优点不合格；禁裸 TODO；**改代码不改注释＝bug**。日志三流：A 运行（pino JSON→stdout+Sentry）／B 业务审计（`order_events`+`admin_audit`，100% 不采样）／C 用户行为（`user_events`+RealtimeLogManager）；统一字段 `trace_id/req_id/user_id/actor/order_id/channel/module/event/duration_ms/result/err/ctx`；脱敏红线（禁 secret/卡号/完整邮箱电话/openid 明文/回调原文）。

## 5. 开发纪律总入口：`jp_project/CLAUDE.md`（写代码前必读）
十条约束＝无测试不前进／小步单元上限／假数据要像真的／架构可换零件／UI 不写死／注释讲优缺点／日志三流／缺陷注入验证／防复发机制／`@measured` 实测。单元完成标准**七项**，缺一不算完成。
- 红灯纪律：红→绿→全量 `npm run gate`→缺陷注入确认变红→记录→提交，**一单元一 commit**
- AJ 七字段：场景/可选/选择/依据/反向风险/回滚/下游/红灯证据
- 单元上限：纯函数≤60 行／存储≤80／接口≤100／适配≤100／任务≤80／前端≤150
- 门禁 `npm run gate`（Vitest + postgres.js + vi 假时间 + v8 覆盖率）
- 必测红线：运费 7 向量、状态机全迁移、幂等并发与回调重放、原币退款、40011/40907/42901、上架 9 条校验、调度器锁与 savepoint、30 分钟 TTL 边界

## 6. 报告与判断的硬纪律
- **报告的"涉及文件"清单必须与 `git diff --name-only` 集合对账**（三审教训：列了三行"已修"实际一个没改）
- **gate 结论只能由一次 `gate-exit=0` 实测支撑，且用通过数不用总数**
- **🔒 完全自研，不外包**（用户长期前提）：任何引入第三方交付物（外部代码/服务/人力）的判断**默认答案是"不做"**，要打破默认必须由用户明说，不得推定；工期压力解法是缩范围
- **🔒 `jp/99-原始素材/` 全部＝参考材料不是决定**：当线索核实，不当依据；不许把素材报价写成"二选一"选项集；我推导的分析不许放回素材目录
- ⚠️ **§2 第 21 条（本项目核心教训）：自证断言不算证据**——从被测对象内部取状态或自己造数据自己断言，都不算守护
- ⚠️ **§2 第 49 条：扫描型断言最容易写成自证**——可达性断言第一版只扫"页面 js 里出现过 `/pages/x/index` 字面量"，而**路径常量声明本身就是那个字面量** → 注入"删掉跳转、只留常量"exit=0。修法：只从**调用点**（`navigateTo`/`redirectTo` 的 `url:`）取证 + 解析常量表。**判定标准：注入"把用法删掉、只留声明"必须红**
- ⚠️ **§2 第 50 条：「能走通」不等于「走得到」**——页面注册了、三件套齐备、单测全绿 ≠ 用户能到（订单/地址/法务三页曾是孤岛）。新增页面时"有没有登记 / 有没有入口"**都不报错**。现由 `project-config` 两条断言守；白名单（名单式）：`pages[0]` 启动页、`pages/index/index`、`pages/comp/index`
- ⚠️ **§2 第 51 条：`git checkout -- <file>` 对新文件无效**（未跟踪文件不在 HEAD 里，命令失败但静默留下注入的改动）。缺陷注入的还原一律用**事先 `cp` 的备份**
- ⚠️ **§2 第 52 条：BSD `date -j -f` 是恒等映射陷阱**——`TZ=Asia/Tokyo date -j -f …` 把输入当本地时区解析，输出=输入，"交叉验证"什么都没验到。正确做法：`TZ=UTC date -j -f … +%s` 得 epoch → `TZ=Asia/Tokyo date -r` 换算，再加 Python `datetime+timedelta(hours=9)` 第三路

## 7. 商业测算（jp `30-商业模式/商业测算模型.xlsx`）
- 纯美国、**N=4**：加权单件净贡献 **948.5 円**；净贡献率 **12.39%**、毛利率 17.55%；盈亏平衡 **174 件 / 44 单·月**。过 12% 红线：厨刀 15.97% ✅、保温杯 13.40% ✅、SK-II 11.78% ⛔
- **N 是第一杠杆（R18）**：N=1→8.99%/240 单·月；N=2→11.12%/97；N=4→12.39%/44；N=8→12.92%/21。**引用盈亏平衡前必须先确认 N**
- 待换真实数据：运费表占位（锚点 2kg=4,950）、实重/销量权重/零售价
- ⚠️ 改 xlsx 教训：openpyxl 插删行**不改写公式引用**；改完必须① 全表扫引用 ② Python 独立复算 ③ 提醒用户用 Excel 打开重算另存

## 8. 进度与下一步
- **地基 F0–F17 全部 ✅**；**I1 订单域 U1–U7b 完成 + 10 条 P2 尾巴清完**（AJ-120~122 / D-65）；**I2 前端开工（09-26 深夜）**：首页 + 商品详情页落地，测试 **1541 条**（1099/368/39/35/34），gate exit=0，契约 **0.6.0**，两库已推送（jp_project `6f01f41` / jp `9f44452` D-66）
- **约束十一已生效**（CLAUDE.md 第十一条，AJ-123）：页面逻辑进 `*.vm.js` 纯函数（不读 wx/不 new Date/不做 IO/不发请求），导航意图用数据表达，`index.js` 薄壳；守卫 `miniprogram/vm-guard.unit.test.ts`（有 vm 必须有同名单测，**不强制每页都有 vm**）
- **⚠️ I2 主链路已闭环（09-27，测试 1541→1647，gate exit=0，jp_project `9b25a9b` / jp `5c47791` D-67）**：home → detail → cart → address → checkout → pay → order 全通。共享层：`cart-store.js`（本地车，快照价**不许算钱**）、`address-form.js`（与契约 pattern 双向比对）、`pay-plan.js`、`quote-view.js`、`idem-key.js`、`placeholder.js`、`price-format.js`、`error-text.js`。`wx-api.ts` 已登记 10 个宿主 API（request/storage×3/log/navigateTo/login/navigateBack/showModal/requestPayment/setClipboardData/redirectTo）
- **🔴 支付分支只看 payload 形状，不认通道名**（`PaymentIntent` 契约里**没有** entryMode，`channel` 是任意字符串）——按 `channel==='stripe'` 分支的那天 = 新增支付方式必须发版（ADR-28 红线）。`redirect` 通道**直接不显示**（小程序无「302 跳出去再回来」闭环，D-49 已废 web-view）
- **🔴 页面不 import 页面**：报价区/幂等键/地址表单全下沉 `utils/`。跨页回传用 `globalData.pickedAddressId` **一次性交接**（消费侧读走立刻清空）。支付结果**不轮询**（完成靠服务端回调，订单列表是用户可见真值）
- **✅ 管理端 admin-web 五个页签全部落地（09-27 下午，D-68 / AJ-132~136；测试 1236→**1392** 单测，全量 1834 + lint 层 34，gate **exit=0**）**：商品管理 / 订单管理 / 运营配置（运费分档+展示汇率）/ 首页 Banner / 风控（拒付+拉黑）；登录沿用 F15 骨架（密码 minLength 12，D-57）
- **管理端硬口径**：① 三个操作闸门（发货/退款/改址）**前置到前端且禁用必给具体原因**，服务端仍是权威（409/40907 一条没少）② 状态文案**另起一份十态不合并**（买家侧合并"待付款"，客服要分清"没发起/支付中"）③ ⚠️ `has_dispute` **只有详情接口有、列表没有** → 列表退款闸门对"字段缺失"**放行**，靠 40907 兜 ④ 时间**恒显 JST**、金额千分位自己拼（不用 `toLocaleString`）、`datetime-local` 钉成 `+09:00` 再发 ⑤ 🔴 **刻意不做"输入重量试算运费"**（会造出第二份取档实现，D-46：取档 SQL 全仓库只允许 `adapters/catalog.ts` 一份）⑥ 运费是**整表替换** → 整表校验 + 二次确认 ⑦ 风控：拒付**进行中排最前**；拉黑两步（Dispute 无 user_id → 先取订单；契约**无解除接口** → 不可逆）；证据提交**不做**（在 Stripe Dashboard）
- **⚠️ 第三次/第二次踩同一个坑（规律已成立）**：凡是「服务端形状 → 表单」的 model 函数（`productFormModel` / `bannerFormModel`），**校验与组装都不能复用它**——它会按**服务端**键名（`price_jpy` / `image_key`）读，而表单键名是驼峰（`priceJpy` / `imageKey`）→ 字段**全回落空串**。必须拆一个只按表单键名读的 `asForm`
- **⚠️ 搬代码必须连测试一起搬**（format/upload 下沉时搬错一次闭合括号，typecheck 抓到）：只搬代码不搬测试 = 原模块守护静默消失
- **✅ 服务端 `/api/v1/admin/*` 路由已全部落地（09-27 夜，契约 0.6.5，错误码 28，gate exit=0，jp_project `07656b4` / jp `4aaca2d`）**：U-A 商品四条（U-A1/2/3）→ U-B 订单五条（U-B1/2a/2b/2c/2d）→ U-C 运营配置四条（U-C1/2/3）→ U-D Banner 四条（U-D1/2/3）→ U-E 风控两条（U-E1/2/3）。管理端不再只跑在契约上。测试 unit **1474** / db **495** / contract 39 / e2e 35 / lint 34，cov 一轮 2043
- **⚠️ 服务端 `/admin/*` 的几条硬口径（写新路由前必看）**：① `POST` 若前端要拿 id 打后续 PUT 就**必须返回带 id 的 body**（Banner），否则**空体**（ADR-28：无消费方的字段是死数据）② **改（PUT）命中 0 行必须 404**，返回 200 = 静默失败；**删（DELETE）恒 204 幂等**——前者"没改成必须说"，后者"让它不存在"没得可错 ③ **0 行命中可能是两种原因的写操作必须先分辨再给码**（拉黑：40403 人不存在 / 40911 对方是管理员）④ 日志里记"对象"用 `target_user_id`，**🈲 不得传 `actor`**（logger 保留键，会抛 TypeError → 500，§2 第 41 条）⑤ **`admin_audit` 端口仍未落地**（零写入方），所有管理端写路由目前只写 pino 业务日志，等端口统一后四处一起接
- ~~**🔴 新的真阻塞点 = Stripe dispute 事件的写入方**~~ **已解决（09-27/28，U-F3 `8e5704f` / U-F4 `1a61c59`，契约 0.6.7）**：回调管线改成**按 outcome 注册落点**（U-F2），`disputed` / `dispute_closed` 两个落点真落库；结案**必须复位 `orders.has_dispute=false`**（否则订单被 `shipGuard`/`refundGate` 永久锁死且无报错）
- **✅ 小程序可达性收口（09-28，U-H1/U-H2，jp_project `c8906d0` / `65cd6fb`，jp `eda07db` D-70；unit 1489→**1513**，db 521 / contract 39 / e2e 35 / lint 34，cov **2108**，gate **exit=0**）**：① **法务页 `pages/legal`**——结算页"阅读并同意购买条款"此前**没有任何去处**（勾选框的另一半）；条款正文**刻意不搬进小程序**（单一事实源是 `GET /terms.urls` 指向的 checkout 静态站），走"复制链接 + 浏览器打开"，与支付页复制 Stripe 短链同一口径（D-49 已废 web-view）。② **「我的」页 `pages/user`**——订单/地址/法务三页此前注册了、能跑、测试全绿，但**从首页出发走不到**；现在 首页 → 我的 → 三个页。③ **两条新守卫**（都是缺陷注入逼出来的空白）：建了页面必须登记进 `app.json`；每个业务页必须**真的**被跳到（§2 第 49/50 条）。④ 刻意没做：**tabBar**（要 `iconPath` 本地图标，仓库只有斜纹灰占位图）、**客服入口**、**特商法表示**——后两项是 PRD P0 的**已登记缺口**（契约无字段 / 主体未登记，占位会被当成真值写进订单）
- **✅ 订单详情页落地（09-28，U-H3，jp_project `ed29d95` / jp `baaebc6` D-71；unit 1513→**1540**，cov 一轮 **2135**，gate **exit=0**）**：撤销 D-67⑦ 的"范围外"判定——详情页是买家凭据（行项目**单价快照**/金额/地址/运单/时间线/条款版本）。① `order-status.js` 下沉 utils（连测试一起搬），`canPay`/`canCancel` **同源 PAYABLE**（防"能付但取消不了"半开）② `jst-text.js` = Hinnant 历日纯整数运算 UTC→JST，**不用 `new Date`**；只认 `...Z`，带偏移直接 null（防再 +9 静默错 9 小时）③ 关税标签写死"含在商品价内"（D-32）④ 行项目带单价快照与结算页相反且各有理由（结算页价格会过期、详情页是凭据）⑤ 8 轮注入全红（canCancel 不同源首轮 exit=0 → 补**十态逐态断言**，覆盖假象第三次应验）
- **下一步 = `/admin/upload`（依赖 R2/S3；管理端商品/Banner 存不了图，且契约缝隙：`POST /admin/upload` 返回 ImageSet 三档 URL 而 `BannerInput` 要 image_key，实现前必须定死）→ F12 售后（机构返 pending 时订单停在 `refunding` 无驱动者）→ 客服 / 特商法（等运营定值 + 公司登记）→ `admin_audit` 接入（四处一起接）**；小程序买家侧页面已全部落地；#110 I1 收尾报告仍欠（跨会话遗留）
- **✅ 待拍板批量拍板（09-27 晚，用户授权；D-69 + AJ-137~143，两库已推 `c464613` / `0558537`）**：工程侧七项——运费表占位写进 `carrier=PLACEHOLDER`(137)、`user_events` 180 天 + 一个 `purge_user_events` SECURITY DEFINER 且订单走匿名化(138)、日志落点 **Axiom 默认 / Better Stack 备选 + 四条验收**(139)、ADR-28 四张表按消费时点分批纳入(140)、形态清单按"有前端消费方"接(141)、**关税基数按成交价 ×15%**（保守方向，写成 `duty_rates` 数据）(142)、Banner `image_key` 由上传接口返回(143)。
  jp 侧十二项：D-24=**JPY**｜D-32=含关税 DDP+分档｜D-34=独立 Web｜D-45=不上电器｜D1=**B 轻奢日系**｜**N 不定目标、定「N=1 也要不亏」+ 凑单策略必做（owner 待补）**｜主体架构追认 D-53（**看板 $50k→$25k**）｜发起人路线**默认四人**（判据 09-30；**垫资 91 万→231,000 円**）｜首月周转金=**股东借贷**、额度按在途峰值（**資本金 91 万→300 万**）｜**食品线 MVP 缓上**（三条复开条件）｜"先只开银行卡"拍的是**推广分两段**｜商号推荐 和選/WaSelect（合伙人定）
- **🧭 拍板的三条通用判据（以后沿用）**：① 两种错误的方向不同时，选**保守方向**（多缴税 > 申报不实；少赚 > 违规；多一道公证 > 事后转让股权）② 凡是**改数据就能回滚**的（关税率在 `duty_rates`、报价币种在 `payment_channels`、运费在 `shipping_rates`）就先定一个——这才让"先拍一个"安全 ③ **外部事实不替它下结论**（真实运费、CBP 关税核实、Stripe 结算周期），只定"拿到事实前怎么走"
- **⚠️ 口径已同步**：10 个文件里"待周会确认"字样已改为已定（决策日志 D-24/32/34、ADR 状态行与待定表、技术文档 §2.5 等）；README §5 顺带修掉 D-49 已废却仍在的「H5 + Payment Element」口径
- **⚠️ 测试写法教训（09-27 两次踩）**：**两个变量一起改的用例会造出覆盖假象**——① 关税行两条用例同时把 `duty_jpy` 改 null，漏了「estimate=false 但有数字」这档，缺陷注入首次未变红；② 「同一 rand 两次相同」在**同一毫秒内会漏**，要补**假时钟**断言才钉得住「不取时间」

## 9. 关键路径与阻塞
- **公司登记是唯一开工令**：Stripe Japan／收单签约／海外主体 AppID／法人账户全串行在其后 → 粗估 **6–10 周**才能真收款；发起人路线（四人 vs 两人）未决→卡定款 v0.4→卡公证登记
- **未拍板（只剩外部事实类）**：① ~~日本出口申报阈值 ¥200,000~~ **已核实为是且适用**（D-61）② ~~关税基数 A7~~ **已拍 ×15% 按成交价申报**（AJ-142/D-69），待通関業者核实后可改 `duty_rates` 一行数据 ③ **真实 DDP 转运报价**（到手前运费表 `carrier=PLACEHOLDER`）④ **CBP 关税基数核实结论** ⑤ **Stripe 实际结算周期**（决定周转金额度）⑥ 商号最终定名（推荐 和選/WaSelect）⑦ 事業目的 10 条签字
- 待补风险：**营运资金/结算在途现金流**——已拍方案为股东借贷，额度 = 日均单量 × 客单价 × 在途天数（不按 100–200 万拍脑袋），Stripe 开通后实测结算周期再定
- 报告指针：`docs/全面体检报告-2026-09-25.md`、`docs/全面审计报告-第二轮-2026-09-25.md`、`docs/复盘与自我审计报告-2026-09-26.md`
