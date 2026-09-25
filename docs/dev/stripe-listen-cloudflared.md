# 本地联调：stripe listen 与 cloudflared

> 状态：已定（F17 单元②，2026-09-25）｜适用：本地开发与 staging 联调
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
   骨架期订单不存在时，回调会按「早到宽限期」逻辑返回 503 让 Stripe 重发
   （`CALLBACK_ORDER_GRACE_MS`，AJ-32）——看到 503 重发不是 bug，是设计行为。
   本服务关心的完整事件清单在契约 `x-provider-events.stripe` 里（checkout.session.completed /
   expired、payment_intent.*、charge.refunded / refund.updated / refund.failed、charge.dispute.*）。

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
- 隧道把本机服务暴露在公网：**骨架路由在非生产是挂载的**（`shouldMountSkeleton`），
  它能绕过验签改订单状态。临时隧道只在需要时开，用完就关；staging 隧道前考虑加 Cloudflare Access。
- trycloudflare 随机域名**不要写进任何配置或文档**——它每次都变，写进去就是下一个"配置漂移"事故。

## 3. 常见问题

| 现象 | 先查 |
|---|---|
| 回调全部 40103 | `whsec` 是否与当前 listen 会话匹配（每次启动都会换） |
| 回调 404 | 路径里的通道名是不是注册键 `stripe`；服务是否已重启 |
| 回调 503 且 Stripe 自动重发 | 正常：订单未建的宽限期行为（AJ-32），建单链路通后会消失 |
| 真机请求发不出去 | 开发者工具「不校验合法域名」开关；手机与电脑同一网络时用局域网 IP 也行 |
