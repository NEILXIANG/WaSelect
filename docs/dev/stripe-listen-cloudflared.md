# 本地联调：stripe listen 与 cloudflared

> 状态：已定（F17 单元②，2026-09-25）｜适用：本地开发与 staging 联调；2026-09-28 一致性审计校正（AJ-176：骨架端点已退役，相关段落改为现行做法）
> 前置：服务已通过 `npm run dev` 起在 `localhost:3000`

## 1. stripe listen（Stripe 回调转发到本机）

**干什么用**：Stripe 的 webhook 只认公网 URL。本地开发时，`stripe listen` 在本机与 Stripe 之间
建一条转发通道，把 test mode 的回调事件原样（带签名头）打到本机服务，验签链路全程走真代码。

**步骤**：

```bash
brew install stripe/stripe-cli/stripe   # 或官网下载
stripe login                            # 跳浏览器授权；test mode 不需要公司资料（并行泳道 §1.1）

stripe listen --forward-to localhost:3000/api/v1/pay/callback/stripe
```

启动后会打印一行 `Ready! Your webhook signing secret is whsec_xxxx...`——
把这个 **`whsec_...`** 填进 `.env` 的 `STRIPE_WEBHOOK_SECRET`，然后重启服务。

⚠️ 三个坑（都真实存在）：

1. **`whsec` 每次 `stripe listen` 都会变**——重开 listen 就要重填 `.env` 再重启服务，
   否则全部回调 40103（验签失败）。排查 40103 的第一反应应该是「whsec 是不是又换了」。
2. **回调路径里的通道名是注册键 `stripe`**（见 `adapters/payment/channels.ts`），
   不是 `stripe-checkout`（那是 Provider 实现名）。路径写错会 404，且 404 不会重发。
3. **触发测试事件用 `stripe trigger`**，例如 `stripe trigger checkout.session.completed`。
   ~~骨架期订单不存在时~~ 事件里的 `metadata.order_id` 在本地库找不到时（例如订单还没建好），回调会按「早到宽限期」逻辑返回 503 让 Stripe 重发
   （`CALLBACK_ORDER_GRACE_MS`，AJ-32）——看到 503 重发不是 bug，是设计行为；超过宽限期改回 2xx 并记 `callback_unmatched`（error）转对账。
   ⚠️ 裸 `stripe trigger` 造出的事件**不带** `metadata.order_id`（它只在我们 create 会话时写入）：
   付款成功类事件（如 `checkout.session.completed`）取不到单号会按"我方缺陷"抛错（500，Stripe 会重发），
   其它与订单无关的类型按 unknown 收下（200 + `ignored:unknown`），见 `adapters/payment/stripe-checkout.ts` 的 `parseWebhook`——要联调**落账**，请走真实链路：
   本地建单 → 发起支付（stripe 通道）→ 打开短链进 Checkout 托管页用测试卡付款。（AJ-176：骨架端点已退役，不再有"骨架演示单"可用）
   本服务关心的完整事件清单在契约 `x-provider-events.stripe` 里，**以契约为准**。
   （这里**不**另抄一份清单：抄了就是第三份，契约再变要同步三处，而多一份就多一处漂移。
     逐个列出是运维手册的事——运维要在 Stripe 后台一个个勾；本地 `stripe listen` 转发全部事件，不需要照单勾。）

**生产/预发**：不用 listen，在 Stripe Dashboard 配固定 webhook endpoint
（`https://api.<domain>/api/v1/pay/callback/stripe`），`STRIPE_WEBHOOK_SECRET` 用 Dashboard 给的固定值。

## 2. cloudflared（给本机一个公网入口）

**干什么用**：① 微信回调/微信开放平台需要一个公网可达的 URL；② 真机调试时手机要能访问到本机服务。
staging 隧道也是技术栈定案的一部分（ADR-14）。

**临时隧道（开发用，零配置）**：

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
# 输出一个 https://<随机>.trycloudflare.com —— 每次启动都变
```

**命名隧道（staging 用，域名固定）**：需要 Cloudflare 账号，一次性配置：

```bash
cloudflared tunnel login                 # 跳浏览器授权，选你的域名
cloudflared tunnel create waselect-stg   # 创建隧道，记下 Tunnel ID 与凭据文件路径
cloudflared tunnel route dns waselect-stg stg-api.<你的域名>
# 写 ~/.cloudflared/config.yml（tunnel: <ID> / credentials-file / ingress: hostname → http://localhost:3000）
cloudflared tunnel run waselect-stg
```

⚠️ 注意：

- **小程序 request 合法域名每月只能改 5 次**（微信后台限制）——开发期**不要**把临时隧道域名配进
  微信后台；真机调试改用开发者工具的「详情 → 本地设置 → 不校验合法域名」开关（仅开发版有效）。
- 隧道把本机服务暴露在公网：~~**骨架路由在非生产是挂载的**（`shouldMountSkeleton`），
  它能绕过验签改订单状态。~~（AJ-176 更正：骨架路由与 `shouldMountSkeleton` 已随 I1-U6c 删除，见 `server/src/main.ts` 文件头第 3 条。）
  现行的**非生产专属入口**有两个，同样不该裸露在公网：
  ① **dev 登录**——`.env` 配了 `WECHAT_DEV_LOGIN` 且 `NODE_ENV` 为 development / test 时，`server/src/app/mount.ts` 挂 dev 替身，
  `POST /api/v1/auth/wechat/login` 等价于**无密码登录任意身份**；
  ② **mock 通道回调**——`MOCK_CALLBACK_SECRET` 留空时回落到**公开的开发占位密钥**（`adapters/payment/channels.ts`），
  知道这个值的人可以伪造 mock 回调把 mock 通道的订单改成 paid。
  所以：临时隧道只在需要时开，用完就关；开隧道时 `.env` 里清空 `WECHAT_DEV_LOGIN`、给 `MOCK_CALLBACK_SECRET` 配一个随机值（或 `PAYMENT_CHANNELS` 去掉 mock）；
  staging 隧道前考虑加 Cloudflare Access。
- trycloudflare 随机域名**不要写进任何配置或文档**——它每次都变，写进去就是下一个"配置漂移"事故。

## 3. 常见问题

| 现象 | 先查 |
|---|---|
| 回调全部 40103 | `whsec` 是否与当前 listen 会话匹配（每次启动都会换） |
| 回调 404 | 路径里的通道名是不是注册键 `stripe`；服务是否已重启 |
| 回调 503 且 Stripe 自动重发 | 正常：事件里的订单在本地库尚不存在时的宽限期行为（AJ-32）；~~建单链路通后会消失~~ 走真实下单链路后不会出现（AJ-176） |
| 回调 500、日志里 `取不到 order_id` | 付款成功类事件不是我们建的会话（例如裸 `stripe trigger checkout.session.completed`），没有 `metadata.order_id`；走真实下单链路联调（AJ-176） |
| 真机请求发不出去 | 开发者工具「不校验合法域名」开关；手机与电脑同一网络时用局域网 IP 也行 |
