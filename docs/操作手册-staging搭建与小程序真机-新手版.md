# 操作手册：搭 staging（预发布环境）+ Stripe 沙盒 + 小程序真机（新手版）

> 写给：第一次接触云服务器、域名、支付、小程序发布的人。每一步都写了**在哪点、填什么、填完看到什么算对**，并给了可以照抄的例子。
> 建立：2026-10-16。对应验收清单：[真平台验收清单.md](真平台验收清单.md) 的 S1～S8、M1～M10、E1～E12。
> 平台界面会改版：文中的按钮名以「」标出，**认关键词，不认位置**。凡是我没能在官方文档里核实的地方，都标了 ⚠️【以界面为准】，不要硬套。
> 谁做什么：标【你】的只有你本人能做（注册、付款、扫码、点同意）；标【我】的可以让 Claude 来做（改清单、跑脚本、查日志、提交代码）。你每做完一大步，把结果贴给我，我帮你核对。

---

## 0. 先看这一页：你要搭的是什么

### 0.1 一张图

```
你的手机微信 ──扫码──▶ 小程序测试号（只有你能用，不用公司）
      │
      │ 真机预览（小程序在你手机里跑）
      ▼
 小程序 ──请求──▶ API 服务（Render，美国 Oregon）──读写──▶ 数据库（Render Postgres）
                      ▲   │
                      │   └─ 每天凌晨一次「每日作业」（Render Cron）：对账、查卡住的订单
                      │
 Stripe 沙盒 ──回调（webhook）──┘      运营后台（Render 静态站）：你在电脑浏览器里用
      ▲
      └─ 买家点「银行卡」→ 跳到 Stripe 托管页（用测试卡号付钱，假钱）
                              ▲
              短链「checkout 静态站」（Cloudflare Pages）：把 /o/xxx 转到 API，再转到 Stripe
```

**一句话**：staging 就是把你现在只在自己电脑上跑的整套东西，原样放到互联网上，用**假钱**和**测试号**把「下单 → 付款 → 回调 → 退款」整条链在真环境里走一遍。走通了，将来换成真公司、真 AppID、真收款，只是换几个配置。

### 0.2 为什么需要它（你之前没碰过的风险）

本机验证不了的事：域名和 https 证书对不对、服务重启后订单会不会丢、Stripe 的回调能不能真的打进来、手机上按钮点得中点不中、微信真机里请求会不会被拦。这些都**只在真环境才暴露**，而且暴露的时候往往是上线当天。staging 就是用来提前撞这些墙的。

### 0.3 要花多少钱、多少时间

| 项目 | 费用（⚠️【以界面为准】，创建前 Render 会显示合计） | 说明 |
|---|---|---|
| Render API 服务（最小付费档） | 约每月几美元 | 不能用免费档（免费档休眠后首个请求要几十秒，会把 Stripe 回调拖超时） |
| Render 数据库（最小档） | 约每月几美元 | 不能用免费档（30 天到期会连数据一起删） |
| Render 每日作业 | 约每月 1 美元 | |
| Render 管理端静态站 | 免费 | |
| Cloudflare Pages（checkout 站） | 免费 | |
| Stripe 沙盒 | 免费 | 假钱 |
| 微信小程序测试号 | 免费 | |
| 域名（可选，见第 4 节） | 每年约 10 美元 | **staging 不需要买**，先用平台送的免费地址 |

**合计预估：每月约 15～25 美元**（我没法替你查到准确价格，所以以 Render 创建前展示的金额为准）。不用的时候可以暂停（第 12 节），费用会降到接近零。

时间：第一天 3～4 小时（账号 + 部署 + 支付），第二天 2～3 小时（后台初始化 + 小程序真机）。中间有几处要等（构建 5～10 分钟），可以去喝杯水。

### 0.4 开始前你要有的东西（逐项打勾）

- [ ] 一个**常用邮箱**（比如 you@gmail.com）。后面 4 个平台都用它注册，将来公司邮箱下来再改。
- [ ] 一张**能在海外付款的信用卡**（Render 要绑卡，哪怕只用最便宜的档）。
- [ ] **手机微信**，且你能用它扫码。测试号靠它登录；真机预览也要它。如果你还没有微信号，先注册一个。
- [ ] **GitHub 账号**（你已经有：仓库是 `NEILXIANG/WaSelect`，私有）。Render 和 Cloudflare 都通过 GitHub 拉代码。
- [ ] **密码管理器**。强烈建议今天就装一个（macOS 自带「密码」App，或 1Password / Bitwarden）。这次会产生十几个密钥，**记在纸上或聊天记录里都不行**——聊天记录会被同步、被截图、被转发。
- [ ] 电脑上 `WeChat.app` 和「微信开发者工具」（你的 `/Applications` 里已经有 `wechatwebdevtools.app`，不用再装）。
- [ ] 终端能用（Mac 自带「终端」）。本手册里的命令都是**整段复制、粘贴、回车**，不需要你懂命令的含义。

### 0.5 几个名词，大白话

| 名词 | 它是什么 | 本次你会碰到的地方 |
|---|---|---|
| **域名** | 网站的名字，比如 `waselect.com`，买来才属于你 | 第 4 节；staging 先不用买 |
| **DNS / CNAME** | 把「名字」指到「服务器」的一张对照表；CNAME 是其中一种「别名」记录 | 第 4 节绑域名时 |
| **https / 证书** | 浏览器地址栏的小锁；Render 和 Cloudflare 都自动办，你不用管 | 全程 |
| **环境变量** | 程序启动时读的「设置项」，比如数据库地址、密钥。**不写进代码**，写在平台控制台里 | 第 5、7 节 |
| **Blueprint（蓝图）** | 一个 `.yaml` 文件，描述「我要哪几个服务、什么配置」，Render 照着一次建好 | 第 5 节 |
| **静态站** | 只有网页文件、没有后台程序的站点（运营后台、checkout 页都是） | 第 5、6 节 |
| **Webhook（回调）** | 别人（Stripe）在事情发生时主动敲你服务器的门：「这笔钱付成功了」 | 第 7 节 |
| **沙盒 / 测试模式** | Stripe 提供的假钱环境：用测试卡号，不扣真钱 | 第 3 节 |
| **TOTP（手机验证码）** | 手机验证器 App 上每 30 秒变一次的 6 位数，管理后台登录必须用 | 第 8 节 |
| **测试号** | 微信送的一个临时小程序身份，不用公司，只能自己用 | 第 9 节 |

---

## 1. 准备一张「信息表」（边做边填，别丢）

打开一个**不进 Git 的**地方（密码管理器的「安全笔记」最好）。把下面整段复制进去，后面每做完一步就填一项。

```
===== WaSelect staging 信息表 =====
【账号邮箱】
Render：
Cloudflare：
Stripe：
微信测试号登录：用手机微信扫码，无需邮箱

【Stripe（第 3、7 节填）】
STRIPE_SECRET_KEY（sk_test_ 开头）：
STRIPE_WEBHOOK_SECRET（whsec_ 开头）：

【Render（第 5 节填）】
API 地址：        https://waselect-staging-api.onrender.com
管理端地址：      https://waselect-staging-admin.onrender.com
数据库 External Database URL：
管理员邮箱：
管理员口令（≥12 位）：
管理员手机验证密钥（TOTP，base32）：

【Cloudflare Pages（第 6 节填）】
checkout 地址：   https://waselect-checkout-staging.pages.dev

【小程序测试号（第 9 节填）】
AppID：
AppSecret：
===================================
```

> 上面几个「地址」是**预期值**：只要名字没被别人占用就是这样。创建完以后要**对着 Render / Cloudflare 页面上实际显示的地址核对一次**（第 5.6 节）。

---

## 2. 本机先检查一遍（5 分钟）

打开「终端」，**逐段**复制运行。

```bash
# 1) 进到项目目录
cd /Users/neilxiang/Documents/me/jp_project

# 2) 用项目要求的 Node 22（你系统的 Node 是 25，直接用会报版本不对）
export PATH=/Users/neilxiang/.workbuddy/binaries/node/versions/22.22.2-6/bin:$PATH
node -v
```
**应该看到**：`v22.22.2`（或 v22 开头）。

```bash
# 3) 确认代码是最新的、仓库干净
git fetch && git status -sb
```
**应该看到**：第一行 `## main...origin/main`，后面没有 `ahead`/`behind`，下面没有文件列表。若看到 `ahead N`，说明有改动还没推到 GitHub——**先让我推送**，因为 Render 拉的是 GitHub 上的代码，不是你电脑上的。

```bash
# 4) 确认 staging 清单存在、守卫测试通过
npx vitest run --project unit test/config/render-staging.unit.test.ts 2>&1 | tail -4
```
**应该看到**：`Tests  7 passed (7)`。

---

## 3. Stripe 沙盒（假钱环境）

### 3.1 注册账号【你】

1. 浏览器打开 **https://dashboard.stripe.com/register**。
2. 填：邮箱、姓名、密码。**国家选「日本」**——这一项注册后改不了，而你将来的收款主体是日本公司。
3. 去邮箱点验证链接。
4. 登录后会出现「激活账户 / Activate your account」的提示，让你填公司资料和银行账户。**现在全部跳过**（关掉、点「稍后」）。不激活**也能用沙盒**；激活要等公司和法人银行账户下来。
5. 开两步验证：右上角头像 → Profile/Settings → Security（⚠️【以界面为准】）→ 用手机验证器（Google Authenticator、iPhone「密码」App 都行）。这个账号以后会管真钱，现在就养成习惯。

> **关于「测试模式」和「沙盒」**（我读了 Stripe 官方文档确认的）：Stripe 现在的说法是「新账号创建后默认就在一个**沙盒（Sandbox）**里」，沙盒里的密钥以 `sk_test_` 开头。你以前听说的「右上角 Test mode 开关」是旧说法，界面上可能叫沙盒、可能还有开关，**认密钥前缀就行：`sk_test_` = 假钱，`sk_live_` = 真钱**。本项目的代码在 staging 里**只接受** `sk_test_`，贴成 `sk_live_` 也会被服务拒绝启动。

### 3.2 拿测试密钥【你】

1. Stripe 后台首页，或左侧/顶部找到「开发者 Developers」→「API 密钥 API keys」。
2. 找到「密钥 Secret key」，点「显示/Reveal」，复制，形如：
   ```
   sk_test_51Qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
3. 粘进「信息表」的 `STRIPE_SECRET_KEY`。**不要**复制「可发布密钥 Publishable key」（`pk_test_` 开头）——我们不用它。

### 3.3 （可选）本机装 Stripe CLI，在电脑上先把支付链路排练一遍【你 + 我】

**这一步不影响 staging 搭建**，但它能让你**不依赖 Render**、在自己电脑上把「下单 → 付款 → 回调 → 退款 → 拒付」跑一遍，并生成报告。建议做，约 20 分钟。

**为什么不用 brew 装**：你的 Mac 是 Intel 芯片，Homebrew 已经不再支持，装 Stripe CLI 会报「Xcode 太旧」。改用官方二进制：

```bash
# 下载并放进 /usr/local/bin（会要你输入电脑登录密码；输入时屏幕不显示字符，输完回车）
curl -L https://github.com/stripe/stripe-cli/releases/download/v1.54.0/stripe_1.54.0_mac-os_x86_64.tar.gz -o /tmp/stripe.tgz
sudo tar -xzf /tmp/stripe.tgz -C /usr/local/bin stripe
stripe --version
```
**应该看到**：`stripe version 1.54.0`。

> 如果 macOS 弹出「无法验证开发者」而拒绝运行：终端执行 `sudo xattr -d com.apple.quarantine /usr/local/bin/stripe` 后再试。

```bash
# 登录（会弹出浏览器，点「允许访问」）
stripe login
```
**应该看到**：终端提示 `Done! The Stripe CLI is configured`。⚠️ 它会让你核对一串「配对码」，浏览器里和终端里的词一样才点允许。

然后：

1. 把信息表里的 `sk_test_…` 填进本机 `.env` 的 `STRIPE_SECRET_KEY=` 后面。（`.env` 在项目根目录，**不会**被提交到 Git。）
2. 终端运行 `npm run dev`，等到出现 `listening on http://0.0.0.0:3000`，**这个窗口别关**。
3. **另开一个终端窗口**，运行：
   ```bash
   cd /Users/neilxiang/Documents/me/jp_project
   export PATH=/Users/neilxiang/.workbuddy/binaries/node/versions/22.22.2-6/bin:$PATH
   npm run stripe:rehearsal -- --channel stripe
   ```
4. 脚本会自己起 `stripe listen`；它第一次会告诉你「签名密钥和 `.env` 里的 `STRIPE_WEBHOOK_SECRET` 不一样」——把它打印的 `whsec_…` 填进 `.env`，在第一个窗口按 `Ctrl+C` 停掉 `npm run dev` 再重新启动，然后重跑第 3 步。
5. 之后脚本会让你在浏览器里打开一个链接，用**测试卡号**付款，你只需输这些：

   | 场景 | 卡号 | 到期日 / CVC / 邮编 |
   |---|---|---|
   | 付款成功 | `4242 4242 4242 4242` | 任意未来日期（如 `12/34`）/ 任意 3 位（`123`）/ 任意（`94105`） |
   | 付款成功，之后触发拒付 | `4000 0000 0000 0259` | 同上 |

6. 结束时脚本打印 `rehearsal ok: N steps → var/rehearsal/....md`。把这份报告发给我，我帮你核对并在验收清单 S2、S3 打勾。

> 没有 Stripe 账号时，可以先 `npm run stripe:rehearsal -- --channel mock` 验证脚本本身（不用密钥，用假支付通道）。

---

## 4. 域名：要不要买、怎么买、怎么绑

### 4.1 先说结论

**staging 阶段不需要买域名。** Render 和 Cloudflare 各送一个免费地址（`xxx.onrender.com`、`xxx.pages.dev`），都是正规 https，完全够用。理由：

1. 域名是**品牌决定**，要和公司名、商标一起定（买了又想换，换了要改一圈配置）。
2. 微信**真机预览**时打开「调试」就跳过域名检查（第 9.5 节），测试号也用不到域名登记。
3. 买域名后绑定要多花一小时，而且出错点更多。

**什么时候买**：公司名定下来、要提交小程序审核之前（微信后台要登记服务器域名，**每月只能改 5 次**，所以最终域名要一次定好）。

下面把买域名和绑定的**全部步骤**写出来，你想现在做或以后做都可以照着来。

### 4.2 在 Cloudflare 买域名【你】

> 为什么在 Cloudflare 买：它按成本价卖（不加价），买完域名自动用 Cloudflare 的 DNS，后面绑 Pages 最省事。代价（官方文档原话）：**用了 Registrar 就不能把 DNS 换到别家**，要换得先把域名转出去。

1. 注册 Cloudflare：**https://dash.cloudflare.com/sign-up**，用常用邮箱，验证邮箱，开两步验证。
2. 左侧菜单找到「域名注册 / Domain Registration → 注册域名 Register domains」。
3. 搜索框输入你想要的名字，比如 `waselect`，点搜索。结果会列出 `.com`、`.net` 等的价格。
4. 选一个，点「购买 Purchase」。
5. 「付款选项」选 1 年（初期不要买 10 年）。
6. 填注册人信息：姓名、邮箱、电话、地址（必须是**英文/拼音**，官方说联系信息只支持 ASCII 字符）。
   - **WHOIS 隐私**：官方文档说「注册局允许时会自动隐去你的个人信息」，不需要额外买。
7. 选付款方式（信用卡），勾同意条款，点「完成购买」。约 30 秒内完成。
8. **自动续费默认开启**。公司成立后记得把注册人改成公司（官方有「转移注册人」流程）。

> ⚠️ `.jp` 域名：官方页面没说 Cloudflare 能不能卖，**别指望**；`.com` 最稳。

### 4.3 域名规划（一次想好）

假设你买到了 `waselect.com`（下面都用它举例；**你的域名替换进去**）：

| 用途 | 子域名 | 指向 | 小云朵 |
|---|---|---|---|
| API 服务 | `api-staging.waselect.com` | Render：`waselect-staging-api.onrender.com` | **灰色（仅 DNS）** |
| 运营后台 | `admin-staging.waselect.com` | Render：`waselect-staging-admin.onrender.com` | **灰色（仅 DNS）** |
| checkout 静态站 | `checkout-staging.waselect.com` | Cloudflare Pages：`waselect-checkout-staging.pages.dev` | Pages 自动处理 |

「小云朵」是 Cloudflare DNS 里每条记录右边的橙色/灰色云图标。**API 和后台一定要灰色**：橙色表示流量先经过 Cloudflare 再到 Render，会多一层代理，服务端判断「用户真实 IP」的层数就从 1 变 2，而项目里这个数是写死 1 的（`TRUST_PROXY_HOPS=1`）。改成 2 还要同时配一个校验密钥，否则限流和账号封禁可被伪造绕过——这是新手最容易踩的一个坑。

### 4.4 绑定三个子域名【你】

**A. Render 的 API 绑 `api-staging.waselect.com`**

1. Render 控制台 → 点服务 `waselect-staging-api` → 「Settings」→ 往下找「Custom Domains」→「+ Add Custom Domain」。
2. 输入 `api-staging.waselect.com`，点「Save」。
3. 它会显示要你加的 DNS 记录。到 Cloudflare：选你的域名 → 「DNS → 记录 Records」→「添加记录 Add record」：
   ```
   类型 Type：    CNAME
   名称 Name：    api-staging
   目标 Target：  waselect-staging-api.onrender.com
   代理状态：     仅 DNS（灰色云）
   TTL：          自动
   ```
   保存。（⚠️ 官方提醒：如果域名下有 **AAAA 记录**要先删掉，Render 只用 IPv4。）
4. 回 Render 点域名旁的「Verify」。几分钟后变成已验证，Render 自动签发 https 证书。刚验证完短暂 502 是正常的，等 2～5 分钟。

**B. Render 的管理端绑 `admin-staging.waselect.com`**：同上，服务选 `waselect-staging-admin`，CNAME 名称 `admin-staging`，目标 `waselect-staging-admin.onrender.com`，灰云。

**C. Cloudflare Pages 绑 `checkout-staging.waselect.com`**（先完成第 6 节再做）

1. Cloudflare → 「Workers & Pages」→ 点项目 `waselect-checkout-staging` →「Custom domains」→ 添加。
2. 输入 `checkout-staging.waselect.com`，继续。因为域名已经在 Cloudflare 里，它会**自动**帮你加好 CNAME 记录（官方文档：zone 在 Cloudflare 时会自动添加）。
3. 不要自己手动加这条 CNAME（官方警告：没先在 Pages 里添加就手加会导致 522 错误）。

### 4.5 绑完以后要改的地方（顺序很重要）

绑定只是「多了一个入口」，**程序里写的旧地址不会自动变**，要逐个改：

| # | 改什么 | 改成 | 怎么生效 |
|---|---|---|---|
| 1 | Render API 环境变量 `CORS_ORIGINS` | `https://admin-staging.waselect.com` | 保存后自动重启 |
| 2 | Render API 环境变量 `PUBLIC_API_BASE` | `https://api-staging.waselect.com` | 同上 |
| 3 | Render API 环境变量 `CHECKOUT_BASE_URL`、`LEGAL_BASE_URL` | `https://checkout-staging.waselect.com` | 同上 |
| 4 | Render 管理端环境变量 `VITE_API_BASE_URL` | `https://api-staging.waselect.com` | **必须重新构建**：服务页「Manual Deploy → Clear build cache & deploy」 |
| 5 | Cloudflare Pages 环境变量 `PUBLIC_API_BASE` | `https://api-staging.waselect.com` | **必须重新部署**：「Deployments」→ 最新一条 →「Retry deployment」 |
| 6 | Stripe 的 webhook 端点网址 | `https://api-staging.waselect.com/api/v1/pay/callback/stripe` | 在 Stripe 后台改，不用重启 |
| 7 | 小程序 `miniprogram/config.js`（本机改，第 9.4 节） | `https://api-staging.waselect.com` | 重新编译 |

> 漏了第 4、5 项最坑：改了环境变量却没重新构建，页面里烤进去的还是旧地址，**表现是请求全失败，而且不报错**。
> 想让我代劳：把你的域名告诉我，我改 `render.staging.yaml` 并提交（Render 蓝图会同步）。

---

## 5. Render：部署 API + 数据库 + 每日作业 + 运营后台

### 5.1 注册 Render【你】

1. **https://dashboard.render.com/register** → 选「用 GitHub 登录 Sign in with GitHub」（最省事：登录和授权一次完成）。
2. 授权时 GitHub 会问「安装到哪些仓库」，选**「Only select repositories（只选定的仓库）」→ 勾 `WaSelect`**。不要给「All repositories」。
3. 进入控制台后，左下角/账户设置 → 「Billing」→ 绑信用卡。（⚠️ 如果提示要升级工作区套餐，按提示选**最便宜**那档；不要因为界面推销就选贵的。）

### 5.2 创建前，把要填的值备好

Blueprint 创建时会**弹窗问你 4 个值**（因为是密钥，不能写进代码）。**这个弹窗只出现这一次**——创建完再想改，只能去服务的 Environment 页面逐项改（官方文档原话：只在首次创建 Blueprint 时询问）。所以现在备好：

| 变量 | 填什么 | 示例 |
|---|---|---|
| `STRIPE_SECRET_KEY` | 信息表里的 `sk_test_…` | `sk_test_51Qabc…` |
| `STRIPE_WEBHOOK_SECRET` | **先填占位值**（真值要等第 7 节建好 Stripe 端点才有）：必须以 `whsec_` 开头 | `whsec_placeholder_replace_me` |
| `ADMIN_EMAIL` | 你的管理员登录邮箱（可以和注册邮箱一样） | `you@gmail.com` |
| `ADMIN_INITIAL_PASSWORD` | 至少 12 位的口令，自己生成并存进密码管理器 | 在终端运行 `openssl rand -base64 18`，结果形如 `kF3x9Qm2LpA7vZcN1wYtRb0H` |

> 口令里有特殊字符（`+ / =`）没问题。但**不要**含空格。

### 5.3 创建 Blueprint【你】

1. Render 控制台顶部点「New +」→ 选「**Blueprint**」。
2. 在仓库列表里找到 `NEILXIANG/WaSelect`，点「Connect」。
3. 表单：
   ```
   Blueprint Name：   waselect-staging
   Branch：           main
   Blueprint Path：   render.staging.yaml        ← 这一项最重要！默认是 render.yaml（那是生产的）
   ```
   > ⚠️ **绝对不要把 Blueprint Path 留空或填成 `render.yaml`**——那是生产清单，会建出 `NODE_ENV=production`、审核模式的整套生产环境。
4. 点继续。Render 读取文件，**先给你一页「将要创建的资源」预览**，核对必须是这 4 个：
   ```
   Database      waselect-staging-pg
   Web Service   waselect-staging-api
   Cron Job      waselect-staging-daily
   Static Site   waselect-staging-admin
   ```
   同时页面会让你填上面那 4 个密钥值。填完。
5. 预览页底部会显示**每月合计费用**。看一眼，没问题再点「**Deploy Blueprint**」。
   - 如果这里报红字（比如「Blueprint file has errors」），截图发给我，**不要自己改**。

### 5.4 等部署完成（5～10 分钟）

Render 会依次：建数据库 → 拉代码 → `npm ci` + `npm run build` → 跑**数据库迁移**（建表）→ 启动服务 → 健康检查。

在 Blueprint 页面能看到 4 个资源各自的状态。点进 `waselect-staging-api` →「Logs」看实时日志。

**成功的样子**（示例，具体文字略有不同）：

```
==> Running 'npm run db:migrate'
> Migrating files: ... 全部 "Migrations complete"
==> Running 'npm start'
{"level":"info", ... "msg":"listening", "port":10000}
==> Your service is live 🎉
```
服务状态变成绿色的「**Live**」。

### 5.5 验证三件事【你，30 秒】

在终端运行（地址换成你的）：

```bash
curl -s https://waselect-staging-api.onrender.com/healthz
echo
curl -s -o /dev/null -w "readyz=%{http_code}\n" https://waselect-staging-api.onrender.com/readyz
curl -s https://waselect-staging-api.onrender.com/api/v1/terms
```
**应该看到**：第一条返回 `{"ok":true...}` 之类；第二条 `readyz=200`；第三条返回带 `"version":"TOS-2026-09-20"` 的 JSON。

再用浏览器打开管理端地址 `https://waselect-staging-admin.onrender.com`，应该出现**登录页**（先别登录，要先做第 8 节）。

### 5.6 如果实际地址和预期不一样

在每个服务页面顶部会显示它真正的网址。如果是 `waselect-staging-api-ab12.onrender.com` 这种带后缀的（名字被占用了），就要改，**把四处保持一致**：

1. `waselect-staging-api` 的环境变量 `PUBLIC_API_BASE`；
2. `waselect-staging-admin` 的环境变量 `VITE_API_BASE_URL`（改完要 Manual Deploy 重新构建）；
3. `waselect-staging-api` 的环境变量 `CORS_ORIGINS`（改成管理端的实际地址）；
4. 信息表。

**最省事的办法是告诉我实际地址，我来改 `render.staging.yaml` 并提交**，守卫测试会替你核对四处一致。

### 5.7 关掉「自动同步蓝图」（建议）【你】

Blueprint 页面 → 「Settings」→ 把 **Auto Sync** 设为 **No**。

理由：之后你在 Render 控制台手工改的环境变量（比如把 `STRIPE_WEBHOOK_SECRET` 换成真值），会被「蓝图再同步一次」覆盖回清单里的值。关掉后只有你点「Manual Sync」才会同步，不会有东西在背后悄悄变。

> 代码自动部署不受影响：你（或我）每次往 GitHub 的 `main` 推送代码，staging 的 API 和后台会**自动重新部署**。这是预期行为——staging 永远跟着 main。部署期间约 5 分钟服务不可用，别在这时候测试。

### 5.8 第一次部署最常见的失败

| 你看到 | 原因 | 怎么办 |
|---|---|---|
| Blueprint 预览页红字，提到某个 key | 清单写错 | 截图发我 |
| 构建日志停在 `npm ci` 报错 | 网络抖动 | 服务页右上「Manual Deploy → Deploy latest commit」再来一次 |
| 日志里 `启动失败：…` 开头的中文多行 | **配置校验拒绝启动**（本项目的保护机制，会逐条说明缺什么） | 把那几行复制给我 |
| `ConfigError ... STRIPE_SECRET_KEY 形状必须是 sk_test_…` | 贴成了别的密钥（`pk_test_`、`whsec_`） | 控制台 Environment 里改成 `sk_test_` 开头 |
| 健康检查一直不过，服务反复重启 | 迁移失败 / 数据库没就绪 | 看日志最早的错误行；数据库刚建好可能要再等 1～2 分钟 |
| 管理端能打开但登录页空白 | 构建时 `VITE_API_BASE_URL` 不对 | 查 5.6，改完 Manual Deploy |

---

## 6. Cloudflare Pages：checkout 静态站（付款短链第一跳）

### 6.1 它是干什么的

买家在小程序点「银行卡」后会得到一个短链 `https://…/o/<订单号>?t=<令牌>`。这个站收到后把买家 **302 转到 API**，API 再转到 Stripe 的支付页。它还放着《用户协议》《隐私政策》《退款政策》《特商法》四个法务页（现在是草案）。

**为什么不放 Render**：Render 的跳转固定是 301（浏览器会永久缓存），付款路径上不能接受；Cloudflare Pages 支持 302。

### 6.2 创建项目【你】

1. 登录 Cloudflare（第 4.2 节已注册；没买域名也要注册）。
2. 左侧「Workers & Pages」→「创建应用 Create application」→ 选「**Pages**」标签 →「导入现有 Git 存储库 Import an existing Git repository」→「开始设置 Begin setup」。
3. 第一次会让你连接 GitHub：点「连接 GitHub」→ 授权时同样选「Only select repositories」→ `WaSelect`。
4. 选中仓库 `WaSelect`，点「开始设置」。
5. 配置（**逐项照填**）：

   ```
   项目名称 Project name：     waselect-checkout-staging        ← 决定了地址 waselect-checkout-staging.pages.dev，不能改
   生产分支 Production branch： main
   框架预设 Framework preset：  无 None
   构建命令 Build command：     npm ci --include=dev && npm run build:checkout
   构建输出目录 Output dir：     checkout-static/dist
   根目录 Root directory：      （留空，高级设置里）
   ```
6. 展开「环境变量（高级）Environment variables」，添加：

   | 变量名 | 值 |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `PUBLIC_API_BASE` | `https://waselect-staging-api.onrender.com` |

   > `SELLER_NAME` 等 5 个商家信息变量**先不填**（公司没注册，页面会显示「公司登记后公布」）。
   > **`PUBLIC_API_BASE` 漏填或写错 = 短链永远转不对地方**，构建会失败并提示（项目里有闸门拦这个）。
7. 点「保存并部署 Save and Deploy」。等 1～3 分钟。

### 6.3 验证【你，1 分钟】

浏览器打开：`https://waselect-checkout-staging.pages.dev/legal/terms/`——应该看到《用户协议》草案页。

再在终端验证「转到 API」这一跳（`abc` 随便写）：

```bash
curl -s -o /dev/null -D - "https://waselect-checkout-staging.pages.dev/o/abc?t=xyz" | head -5
```
**应该看到**：第一行 `HTTP/2 302`，并且有一行 `location: https://waselect-staging-api.onrender.com/api/v1/pay/link/abc?t=xyz`——**注意 `?t=xyz` 这段查询串要保留**。（Cloudflare 官方没承诺 302 时保留查询串，这里必须实测一次，对应验收清单 E5。）

---

## 7. 把 Stripe 和 staging 接起来（webhook 端点）

### 7.1 建端点【你】

Stripe 在支付成功、退款、拒付时会主动敲你服务器的门。要告诉它**敲哪里**：

1. Stripe 后台（确认还在沙盒里，页面有测试数据提示）→ 「开发者 Developers」→「Workbench」→「Webhooks」标签。
2. 点「**创建事件目标 Create an event destination**」（⚠️ 旧界面叫「添加端点 Add endpoint」，是同一件事）。
3. 「事件来源」选「**你的账户 Your account**」。
4. 「载荷格式 Payload style」选「**快照 Snapshot**」。
   > ⚠️ **这里选错是最常见的坑**：Stripe 现在默认推荐「精简 Thin」，但我们的代码解析的是传统的「快照」事件。选 Thin 的表现是：回调到了，验签也过，但订单永远不变成已付款。
   > 选了快照后会出现「API 版本」下拉：选 **`2025-03-31.basil` 或更新的版本**（项目要求：低于这个版本时，币种字段的含义会变，导致付了钱订单也对不上）。
5. 勾选事件（**只勾这 14 个**，多勾无害但不必要）：

   ```
   checkout.session.completed
   checkout.session.expired
   checkout.session.async_payment_succeeded
   checkout.session.async_payment_failed
   payment_intent.succeeded
   payment_intent.payment_failed
   payment_intent.canceled
   charge.refunded
   refund.updated
   refund.failed
   charge.dispute.created
   charge.dispute.closed
   charge.dispute.funds_withdrawn
   charge.dispute.funds_reinstated
   ```
   > `refund.updated` 和 `refund.failed` **必须勾**：漏了，退款会一直卡在「退款中」。

6. 点「继续」，目标类型选「**Webhook 端点 Webhook endpoint**」，继续。
7. 「端点网址 Endpoint URL」填：
   ```
   https://waselect-staging-api.onrender.com/api/v1/pay/callback/stripe
   ```
   （一个字符都别错，路径是 `/api/v1/pay/callback/stripe`。）
8. 保存。进入端点详情页，找到「签名密钥 Signing secret」，点「显示/Reveal」，复制，形如 `whsec_abc123…`。存进信息表和密码管理器。

### 7.2 把真密钥填进 Render【你】

1. Render → `waselect-staging-api` →「Environment」。
2. 找到 `STRIPE_WEBHOOK_SECRET`，点编辑，把占位值换成刚复制的 `whsec_…`，保存。
3. 页面会提示保存并重新部署，确认。等状态回到 Live（约 1～2 分钟）。

### 7.3 发一条测试事件验证【你】

1. Stripe 端点详情页 →「发送测试事件 Send test event」→ 选 `payment_intent.succeeded` → 发送。
2. 在 Stripe 的「事件传递 Event deliveries」标签里，这条应该显示 **200**（已送达）。
3. 如果是 **400/401 且 Render 日志里有 `40103`**：说明签名密钥填错了——回 7.2 检查是不是漏了字符、是不是把别的端点的密钥贴进来了。

> 沙盒的重试规则（官方文档）：沙盒里失败的事件**只重试 3 次、在几小时内**；生产模式才是 3 天指数退避。所以沙盒里回调丢了不会自己补，要在 Stripe 后台手动「重新发送 Resend」。

---

## 8. 初始化 staging：管理员、手机验证、基础数据

### 8.1 为什么管理员登录这么麻烦

staging 和生产**强制**管理员必须开「手机验证」（TOTP）才能登录——口令对了也进不去。这是防止运营后台被撞库。所以流程是：①服务启动时自动建出管理员（用你在 5.2 填的邮箱和口令）→ ②你在电脑上给他开通手机验证 → ③才能登录。

### 8.2 拿到数据库地址【你】

1. Render → 数据库 `waselect-staging-pg` →「Info」（或右上「Connect」菜单）。
2. 找到「**External Database URL**（外部数据库地址）」，复制。形如（示例，**不是真的**）：
   ```
   postgresql://waselect:AbCdEf123456@dpg-d3abcde5f6g7h8-a.oregon-postgres.render.com/japan_shop_staging
   ```
3. 存进密码管理器（它里面含数据库口令，**等同于数据库的钥匙**）。
4. ⚠️ 官方文档：外部连接**必须加密**，Render 会拒绝 `sslmode=disable`；下面的命令我会自动帮你加上 `?sslmode=require`。数据库默认**任何 IP 都能连**（只要口令对），所以这个地址不能泄露。

### 8.3 给管理员开通手机验证【你】

打开终端，**整段复制**（`read -s` 会让你粘贴地址，粘贴时屏幕不显示，粘完直接回车）：

```bash
cd /Users/neilxiang/Documents/me/jp_project
export PATH=/Users/neilxiang/.workbuddy/binaries/node/versions/22.22.2-6/bin:$PATH

read -s "DATABASE_URL?粘贴 External Database URL 后回车（输入不会显示）: "
export DATABASE_URL="${DATABASE_URL}?sslmode=require"

# 把下面的邮箱换成你在 5.2 填的 ADMIN_EMAIL
npm run admin:totp -- you@gmail.com --yes

unset DATABASE_URL
```

**应该看到**（示例）：一段中文说明，打印出一串**密钥**（大写字母和数字，形如 `JBSWY3DPEHPK3PXP`）和一个 `otpauth://` 开头的链接。

接下来**立刻**：

1. 打开手机上的验证器 App：
   - **iPhone 自带「密码」App**：新建/编辑一条记录 →「设置验证码 Set Up Verification Code」→「输入设置密钥 Enter Setup Key」→ 粘贴上面那串密钥。
   - **Google Authenticator**：右下「+」→「输入设置密钥」→ 账号名填 `WaSelect staging`，密钥填那串，类型选「基于时间」。
2. App 里会出现一个 6 位数，每 30 秒变一次。
3. 把密钥也存进**密码管理器**（手机丢了靠它恢复）。**然后清屏**：终端按 `Cmd+K`。
4. 这串密钥**不要**发给任何人，包括我、包括邮件和微信。（它就是第二把锁本身。）

> **常见问题**：
> - 报 `no pg_hba.conf entry` 或 `SSL` 相关：确认地址完整、`?sslmode=require` 在最后。
> - 报 `找不到管理员`：服务还没启动成功过（管理员是启动时建的），先回第 5.4 节看 API 是不是 Live。
> - 手机时间不准会导致验证码不对：手机「设置 → 通用 → 日期与时间 → 自动设置」打开。

### 8.4 登录管理后台【你】

1. 浏览器打开 `https://waselect-staging-admin.onrender.com`。
2. 填：邮箱 = `ADMIN_EMAIL`，口令 = `ADMIN_INITIAL_PASSWORD`，验证码 = 验证器 App 当前的 6 位数（**在它快变的时候别点，等下一个**）。
3. 登录成功会进入「工作台」。

**登录后立刻换口令**（初始口令存在 Render 控制台里，能进控制台的人都看得到）：

```bash
cd /Users/neilxiang/Documents/me/jp_project
export PATH=/Users/neilxiang/.workbuddy/binaries/node/versions/22.22.2-6/bin:$PATH
read -s "DATABASE_URL?粘贴 External Database URL 后回车: "
export DATABASE_URL="${DATABASE_URL}?sslmode=require"
npm run admin:password -- you@gmail.com --yes     # 会提示你输入新口令（输入不显示）
unset DATABASE_URL
```
换完后，到 Render 控制台把 `ADMIN_INITIAL_PASSWORD` 这一项**删掉**（官方做法：「只配 ADMIN_EMAIL」是允许的终态）。

### 8.5 录入基础数据（全新的库是空的，不录入买家什么都买不了）

左侧菜单按顺序：

**① 运营配置 → 运费分档**（承运商的价格表）

没有它，买家报价会得到「运费不可计算」。先录一份**示例**（不是真实报价，真实价要问承运商）：

| 承运商 | 重量上限（g） | 运费（日元） |
|---|---|---|
| EMS | 100 | 1400 |
| EMS | 250 | 1650 |
| EMS | 500 | 2150 |
| EMS | 1000 | 3150 |
| EMS | 1500 | 4050 |
| EMS | 2000 | 4950 |
| EMS | 3000 | 6600 |

「启用」都勾上，点「保存」。

**② 运营配置 → 展示汇率**

银行卡按**美元**收款，**没有 USD 汇率就无法发起付款**。每个外币各录一条：

| 币种 | 原始汇率（1 日元 = ? 外币） | 生效时间 |
|---|---|---|
| USD | `0.0067` | 留空（立即生效） |
| CNY | `0.048` | 留空 |

页面会显示「核对：10,000 日元 ≈ $67.00」之类的示例，并要你**勾选「我已核对上面的金额，确认不是小数点错位」**——认真看一眼，这是防止少打一个 0 的保险。

> 汇率是进价口径，系统会再加缓冲。汇率超过 72 小时没更新，报价会失败（50003）——staging 隔几天不动就会过期，重新录一条即可。

**③ 商品管理 → 新建商品**

录一件测试商品。示例：

| 字段 | 填 |
|---|---|
| 商品名（面向买家） | 南部铁器 急须 0.5L 黑 |
| 日文品名（采购用） | 南部鉄器 急須 0.5L 黒 |
| 售价（日元） | `8800` |
| 重量（克） | `800` |
| 库存 | `10` |
| 原产地 | JP |
| 英文报关品名 | Cast iron teapot |
| HS 编码 | `7323.91`（⚠️ 仅测试；真上架要问报关行） |
| 分类 | 厨房餐具 |

红色提示的字段是必填的。图片 staging 没配图片存储，**先不传**（页面显示占位图）。保存后点「上架」。再录 1～2 件不同价格的（比如 `1200` 日元 / 30g，用来测小额）。

**④ 看启动状态**：Render → `waselect-staging-api` → Logs，找 `launch_ready`。如果是 `launch_not_ready`，它会逐条列出还缺什么（运费表、哪种汇率…），补齐后在服务页点「Manual Deploy → Restart」。

### 8.6 跑一次冒烟检查【你 / 我】

```bash
cd /Users/neilxiang/Documents/me/jp_project
export PATH=/Users/neilxiang/.workbuddy/binaries/node/versions/22.22.2-6/bin:$PATH
npm run smoke -- --base https://waselect-staging-api.onrender.com
```
**应该看到**（公开层 7 项）：

```
✓ 进程存活 /healthz — 200
✓ 就绪 /readyz（数据库可达、未在停机） — 200
✓ 条款 GET /api/v1/terms 带版本号 — version=TOS-2026-09-20
✓ 首页 GET /api/v1/home（轮播与分类） — 4 个分类
✓ 商品列表 GET /api/v1/products 至少一件在售 — 首件 南部铁器 急须 0.5L 黑
✓ 商品详情 GET /api/v1/products/{id} — prd-…
✓ 未登录访问受保护接口 → 401（鉴权没被配丢） — 401
smoke ok: 7 passed (https://waselect-staging-api.onrender.com)
```

**让它每天自动跑**（以后坏了会通知你）：

1. 给冒烟**单独建一个管理员**（别用你自己的）。终端：
   ```bash
   read -s "DATABASE_URL?粘贴 External Database URL: "
   export DATABASE_URL="${DATABASE_URL}?sslmode=require"
   npm run admin:create -- smoke@gmail.com --yes     # 提示输入口令（≥12 位，输入不显示）
   npm run admin:totp -- smoke@gmail.com --yes       # 记下打印的 TOTP 密钥（不需要加进手机）
   unset DATABASE_URL
   ```
2. 打开 GitHub 仓库 `NEILXIANG/WaSelect` → Settings → Secrets and variables → Actions：
   - 「Variables」标签 → New repository variable：`SMOKE_BASE_URL` = `https://waselect-staging-api.onrender.com`
   - 「Secrets」标签 → New repository secret，三个：`SMOKE_ADMIN_EMAIL`、`SMOKE_ADMIN_PASSWORD`、`SMOKE_ADMIN_TOTP_SECRET`
3. Actions 标签 → 左侧 `smoke` → 「Run workflow」手动点一次，应该绿色。之后每天日本时间早上 6:30 自动跑。

---

## 9. 小程序：测试号 + 真机预览

### 9.1 申请测试号【你】

1. 浏览器打开 **https://mp.weixin.qq.com/wxamp/sandbox?doc=1**，用**手机微信扫码**，授权登录。
2. 页面会给你一个测试用的 **AppID** 和 **AppSecret**（⚠️ 官方文档页没写明 AppSecret，实际页面上通常有一栏「AppSecret」，点「重置/显示」。拿不到的话告诉我）。
3. 存进信息表和密码管理器。
4. 以后再次登录：去 **https://mp.weixin.qq.com/**，扫码，选你的测试号。

> 测试号能做的（官方）：在开发者工具里开发、真机预览、调接口。**不能**：发布、提交审核、接真实支付。所以它只用来联调——够用，因为我们的支付走 Stripe 托管页，不走微信支付。

### 9.2 打开项目【你】

1. 打开「微信开发者工具」（`/Applications/wechatwebdevtools.app`），用手机微信扫码登录。
2. 「项目 → 导入项目」（或首页点「+」）：
   ```
   目录：   /Users/neilxiang/Documents/me/jp_project/miniprogram
   AppID：  暂时用已有的，下一步改
   项目名称：waselect
   ```
3. 能打开、能编译就对了。

### 9.3 把 AppID 换成测试号【你】

**不要在开发者工具界面里改**（它会改 `project.config.json`，那是**提交进 Git 的文件**，里面是 `touristappid`，有测试盯着）。改**本地私有文件**，它被 Git 忽略：

用文本编辑器打开 `miniprogram/project.private.config.json`，把 `appid` 改成你的测试号 AppID：

```json
{
  "appid": "wx1234567890abcdef",
  "libVersion": "3.17.3",
  "setting": {
    "urlCheck": false
  }
}
```
（`wx1234567890abcdef` 换成你的。）开发者工具会自动重新加载。

### 9.4 让小程序连 staging【你】

小程序里写着「后端地址」的文件是 `miniprogram/config.js`。**你的修改不能被提交**（里面是你个人的联调地址），先让 Git 忽略你对它的本地修改：

```bash
cd /Users/neilxiang/Documents/me/jp_project
git update-index --skip-worktree miniprogram/config.js
```
（以后想恢复：`git update-index --no-skip-worktree miniprogram/config.js`。）

然后编辑 `miniprogram/config.js`，改**两处**：

```js
export const API_BASES = {
  develop: 'https://waselect-staging-api.onrender.com',   // ← 原来是 http://localhost:3000
  trial: '',
  release: '',
};

export const DEVELOP_DEVICE_API_BASE = 'https://waselect-staging-api.onrender.com';   // ← 原来是 ''
```

- `API_BASES.develop`：电脑上的**模拟器**用。
- `DEVELOP_DEVICE_API_BASE`：**手机真机预览**用（手机上的 `localhost` 是手机自己，所以必须给公网地址；不填的话真机会直接提示「没配置地址」）。
- `trial` / `release` **保持空**——那是体验版、正式版，要等真 AppID 和正式域名。

### 9.5 先在模拟器里看一遍【你】

1. 开发者工具右上角「详情 → 本地设置」，确认勾选「**不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**」。
2. 点「编译」。应该看到首页、商品列表（有你在 8.5 录的商品）。
3. 如果页面提示「请求失败」：看开发者工具底部「Console」红字；多半是 5.x 的服务还没 Live，或者 `config.js` 地址写错。

### 9.6 把测试号 AppID 和 AppSecret 配给 staging 服务【你】

服务端要用它们去微信换用户身份（登录）。**两项必须同时加**（只加一个，服务会拒启动）。

Render → `waselect-staging-api` →「Environment」→「Add Environment Variable」，加两项：

```
APP_ID       = wx1234567890abcdef        （测试号 AppID）
APP_SECRET   = 你的测试号 AppSecret
```
保存，等服务重启完成（Live）。

> ⚠️【待验证】测试号的 AppSecret 能不能走微信的 `jscode2session` 登录接口，官方文档页没明说，**需要这一步实测**。如果登录报「微信登录失败 / 50000」：把 Render 日志里 `wechat` 相关的几行发给我，我判断是密钥问题还是测试号不支持。

### 9.7 真机预览【你】

1. 开发者工具顶部工具栏点「**预览**」。
2. 用手机微信（和开发者工具登录的**同一个微信号**）扫屏幕上的二维码。
3. 小程序在手机里打开。
4. **立刻打开调试**：手机上点小程序右上角「…」→「**打开调试**」→ 小程序重启。（官方文档说：真机预览时打开调试可跳过域名检查。必须开——测试号没法登记服务器域名。）
5. 打开调试后手机屏幕角落会出现一个绿色「vConsole」小按钮，点开能看请求日志。遇到问题截图给我。

### 9.8 在手机上走完整条买家流程【你】

这是整个 staging 的**终极验收**。每一步后面写了「应该看到」，不一致就截图。

| # | 动作 | 应该看到 |
|---|---|---|
| 1 | 打开小程序 | 首页有分类和你录入的商品；价格是「8,800 日元」，旁边有美元参考价（按 0.0067 算大约 $59） |
| 2 | 点商品 → 「加入购物车」 | 底部购物车数字 +1 |
| 3 | 去购物车 → 去结算 | 结算页；若提示选地址，点进去**新增地址**（见下表） |
| 4 | 勾选同意用户协议 → 提交订单 | 跳到支付页，有 30 分钟倒计时，通道只有「银行卡」 |
| 5 | 点「银行卡」→ 出现「复制链接」 | 复制成功（如果提示被微信拦下，看下面「隐私授权」） |
| 6 | 手机浏览器（Safari）粘贴链接 | 跳到 Stripe 的支付页（域名 checkout.stripe.com，页面有「测试模式」标记） |
| 7 | 输入测试卡 `4242 4242 4242 4242`，任意未来日期，CVC `123`，邮编 `94105`，付款 | 显示付款成功，回到 checkout 站的「支付完成」页 |
| 8 | 回到小程序 → 订单 | 订单状态**「已付款 · 日本采购中」**（几秒内；若还是待付款，点「我已付款，刷新状态」） |
| 9 | 管理后台 → 订单管理 | 能看到这单，状态已付款，时间线有「付款成功」，金额与小程序一致 |
| 10 | 后台点这单 → 退款 → 填原因 → 确认 | 状态变「已退款」；Stripe 后台 Payments 里出现 Refunded |
| 11 | 小程序订单页下拉刷新 | 状态「已退款」 |

**美国测试地址（第 3 步）**——地址必须是英文/数字，电话用美国 10 位：

```
收件人：    Test Buyer
电话：      4155550123
地址第一行： 1 Market St
地址第二行： （留空）
城市：      San Francisco
州：        CA
邮编：      94105
```
（邮编首位和州必须对得上，随便编一个会被拒。）

**隐私授权**：第一次复制链接时微信会弹隐私授权窗，点「同意」。测试号如果不弹窗直接失败，页面会提示「长按下面的链接手动复制」，照做即可。

**再走一遍拒付**：重复 1～8，第 7 步改用卡号 `4000 0000 0000 0259`。付款成功后 1～2 分钟内，后台订单会出现「拒付」标记，发货和退款按钮被拦——这就是 Stripe 模拟了「买家向银行投诉」。

**把 11 步的结果告诉我**，我帮你核对并在验收清单 M1～M10、E4 打勾。

### 9.9 真机上要特别看的 10 件事（验收清单 M2～M10）

| 看什么 | 怎么看 | 不对时 |
|---|---|---|
| 主按钮手指点得中 | 首页/详情/结算/支付页的大按钮，单手拇指点 | 截图，说哪页 |
| 灰色说明文字读得清 | 订单详情的「联系客服请提供订单号」，在窗边亮处看 | 截图 |
| 详情页图片轮播 | （staging 没图，此项等有图再看） | |
| 输入框不被键盘挡住 | 结算页邮箱框、地址页每个框，点进去键盘弹出 | 说哪个框 |
| 底部购物车角标 | 加购后切到购物车 tab | 数字不对/不显示 |
| 图片加载失败 | （同上，等有图） | |
| 各处「复制」 | 支付页、订单详情、「我的」页客服 | 失败时有没有提示 |
| 订单列表 | 翻到第 2 页→进详情→返回不丢页；等 1 分钟再回来会刷新 | |
| 登录 | 先关掉 Render 服务，再打开小程序 | 10 秒内「我的」页应出现可重试，不是一直转圈 |

---

## 10. 全部做完后，检查清单

- [ ] 5.5：`healthz` / `readyz` / `terms` 三个 curl 都对
- [ ] 6.3：`/o/abc?t=xyz` 返回 302 且保留 `?t=xyz`（验收 E5）
- [ ] 7.3：Stripe 测试事件显示 200（E4）
- [ ] 8.4：管理后台能登录（口令 + 手机验证码）
- [ ] 8.6：`npm run smoke` 全绿，GitHub Actions `smoke` 手动跑绿（E9）
- [ ] 9.8：整条买家流程 11 步通过（S2、S4）
- [ ] 9.8：拒付一遍通过（S3）
- [ ] Render 日志里能看到一次 `trace_id` 贯穿下单到付款（E12 的前半）
- [ ] 手动触发一次每日作业（Render → `waselect-staging-daily` → 「Trigger Run」，⚠️按钮名以界面为准），后台「运营日志」里「最近一次对账」时间更新（E6）

---

## 11. 出了问题怎么办

先看**症状**，再查**原因**。凡是 Render 日志里出现中文多行的「启动失败：…」，那是配置校验在说明缺什么，把它整段复制给我。

| 症状 | 最可能的原因 | 怎么查 / 怎么办 |
|---|---|---|
| 服务一直重启，日志有「启动失败」 | 某个环境变量缺失或格式不对 | 看日志里列出的变量名，到 Environment 补 |
| 小程序所有请求失败，Console 里 `request:fail` | 地址写错 / 没打开调试 / 服务没起来 | 先浏览器访问 `<API>/healthz`；真机确认已「打开调试」 |
| 小程序提示「没配置地址 api_base_not_configured」 | `DEVELOP_DEVICE_API_BASE` 是空的 | 见 9.4 |
| 登录失败 / 50000 | `APP_ID`/`APP_SECRET` 没配或不成对 | 见 9.6 |
| 报价提示「运费不可计算」/「汇率不可用」 | 没录运费表 / 汇率，或汇率过期 | 见 8.5 |
| 下单成功但「发起支付」失败 | `STRIPE_SECRET_KEY` 错、没有 USD 汇率、被熔断 | 看 API 日志里 `stripe` 相关行 |
| 付了钱订单一直「待付款」 | **webhook 没打进来**或验签失败 | Stripe 端点页 → 事件传递：看状态码；日志搜 `40103`（签名密钥错）或没有请求（网址错）；确认选的是**快照**载荷 |
| 管理后台能打开但登录一直失败 | 没开手机验证 / 验证码过期 / 手机时间不准 | 见 8.3 |
| 管理后台登录后列表空白、控制台有跨域错误 | `CORS_ORIGINS` 与管理端实际地址不一致 | 对比二者，**精确到 https、没有结尾斜杠** |
| 绑了域名后一切全挂 | 漏改了 4.5 的某一项，或 API 域名的云朵是橙色 | 逐项过 4.5；云朵改灰 |
| 邮件没收到 | staging 没配邮件服务（预期） | 不影响测试；以后在验收清单 E8 配 Resend |
| 商品没有图片 | staging 没配图片存储（预期） | 以后配 Cloudflare R2 |

**需要我帮忙时，请一次性贴出**：①你在做第几步；②报错的原文或截图；③Render 日志里出错位置前后各 20 行。**不要贴**任何 `sk_`、`whsec_`、数据库地址、口令、验证器密钥——这些我也不需要。

---

## 12. 暂停与收尾（省钱、安全）

**不测试的时候暂停**：Render → 服务页 → 「Settings」里（或右上菜单）找「Suspend」（暂停）。暂停后服务不收费（数据库仍然收费，因为它存着数据）。想要再用，点「Resume」。

**彻底删除 staging**（比如全部验完要上生产了）：

1. Render → Blueprint 页面 → 「Settings」→ 「Delete Blueprint」，选**同时删除它创建的资源**。
2. Stripe → Webhooks → 删掉 staging 端点。
3. Cloudflare Pages → 项目 → Settings → 删除项目。
4. GitHub → 删掉仓库变量 `SMOKE_BASE_URL`（否则每天冒烟会因为地址不通而变红）。
5. 把 `miniprogram/config.js` 恢复：`git update-index --no-skip-worktree miniprogram/config.js && git checkout miniprogram/config.js`。

**安全提醒**：

- staging 是**公网可访问**的。别用真实买家的姓名、地址、手机号测试；只用假地址和假邮箱。
- 数据库外部地址、Stripe 密钥、管理员口令、TOTP 密钥——都只放密码管理器。
- 万一密钥泄露：Stripe 后台「API 密钥」点「滚动 Roll」换新；管理员口令用 `npm run admin:password` 换；Render 环境变量改完保存。

---

## 13. 你可能没想到的事（我替你列出来）

**平台与账号**

1. **Render / Cloudflare / Stripe 账号都用同一个常用邮箱**，将来公司邮箱下来要**逐个改**。现在就在信息表里记下每个平台「改邮箱」的入口。
2. **一定开两步验证**：Render、Cloudflare、Stripe、GitHub 都开。账号被盗是新手最大的损失来源。
3. **GitHub 仓库是私有的**，Render 和 Cloudflare 要的是「只读代码」授权，只勾 `WaSelect` 一个仓库，别给全部。
4. **staging 永远跟着 `main`**：每次有人推送，staging 约 5 分钟内重新部署。这期间 Stripe 回调可能失败（沙盒只重试 3 次），测试付款时别同时有人推代码。

**数据与安全**

5. **staging 数据库每天自动备份吗？** ⚠️【以界面为准】最小档数据库的备份能力要在 Render 数据库页确认。staging 数据可以重建，不影响；但生产必须确认（验收清单 E10）。
6. **不要在 staging 用真实个人信息**（特别是真实地址、电话）。
7. **`.env` 是本机文件，已被 Git 忽略**；但「信息表」不要放进项目目录里，万一被提交就泄露了。
8. **你的数据库地址等同钥匙**：Render 数据库默认任何 IP 都能连。好习惯：用完不保存在终端历史里（本手册用 `read -s` 就是为此）。需要时可在数据库页「Networking」限制只允许你家 IP（⚠️IP 变了要改）。

**小程序**

9. **测试号不能发布、不能提审、不能接微信支付**。将来需要正式 AppID：境外主体注册 + 微信认证（1～3 周）。**公司下来第一天就提交**，这是最慢的一环。
10. **微信后台服务器域名每月只能改 5 次**：真 AppID 下来后，登记域名要一次填完（`deploy/wechat-domains.json` 是清单）。
11. **体验版/正式版地址**：`config.js` 里 `trial`、`release` 现在是空的，是刻意的（防止静默打错环境）。真 AppID 后再填，且**必须与微信后台登记的域名一致**。
12. **真机上 `localhost` 是手机自己**，所以一定要给公网地址（9.4）。
13. **你修改 `config.js` 不能被提交**：已用 `skip-worktree` 保护。但如果你想让我提交代码，先告诉我你改过它，我会避开这个文件。

**支付与业务**

14. **Stripe 账号激活要的资料**：法人登记簿、法人代表身份证明、法人银行账户。公司注册完成当天就提交（1～2 周审核）。
15. **美国关税规则变了**（2025 年 8 月底取消小额免税）：你的定价是「商品价含关税、DDP 预缴」，**承运商能不能做 DDP** 决定这个承诺成不成立。EMS 一般不做，DHL / FedEx 可以。这个问题现在就该去问承运商（验收清单 B1）。
16. **结汇与换汇费**：买家付美元，Stripe 日本账户默认结算日元，每笔有换汇费。激活后看看能否开美元结算账户（验收清单 L 系列）。
17. **日本消费税的出口免税**要保留出口证明；记账方式在第一单之前定（验收清单 B2）。
18. **拒付举证**：Stripe 拒付胜诉要靠证据（签收记录、买家同意的条款版本、沟通记录）。系统存了条款版本和运单号，但还没做成「一键导出证据包」。
19. **法务页是草案**：用户协议、隐私政策、退款政策、特商法四页的正文还是占位。特别是**隐私政策要写清「数据存在美国服务器」**（日本个人信息保护法对跨境传输有告知要求）。公司下来后找人审。
20. **邮件**：付款、发货、退款通知靠邮件。staging 没配；上线前要配 Resend，且发件域名要做 SPF / DKIM / DMARC，否则进垃圾箱（验收清单 E8）。
21. **图片存储**：商品图要放 Cloudflare R2（Render 磁盘重启会丢文件）。staging 没配所以没图，上线前必须配（`STORAGE_DRIVER=r2` + 4 个 `R2_*`）。
22. **监控**：生产至少配 Sentry 或告警邮件二选一（服务会拒绝启动检查）。staging 可以不配，但建议开 Sentry 免费档，顺便验证「错误能上报」（验收清单 E7）。

**一个人运营的风险**

23. 所有密码和密钥只有你一个人知道。至少让**一个你信任的人**能在你出事时拿到恢复方式（密码管理器的「紧急联系人」功能）。
24. 把 `docs/上线运维手册-首次部署·回滚·审核期切正式.md` 当作「别人替你恢复服务」的说明书，看看是否读得懂。

---

## 14. 命令速查（复制即用）

```bash
# —— 每次开新终端先执行 ——
cd /Users/neilxiang/Documents/me/jp_project
export PATH=/Users/neilxiang/.workbuddy/binaries/node/versions/22.22.2-6/bin:$PATH

# —— 看 staging 活没活 ——
curl -s https://waselect-staging-api.onrender.com/healthz; echo
npm run smoke -- --base https://waselect-staging-api.onrender.com

# —— 本机排练支付（先 npm run dev，另开窗口运行）——
npm run stripe:rehearsal -- --channel mock
npm run stripe:rehearsal -- --channel stripe

# —— 对 staging 数据库做管理员操作（每次都用 read -s，不留历史）——
read -s "DATABASE_URL?粘贴 External Database URL: "
export DATABASE_URL="${DATABASE_URL}?sslmode=require"
npm run admin:totp -- <邮箱> --yes
npm run admin:password -- <邮箱> --yes
npm run admin:create -- <邮箱> --yes
unset DATABASE_URL

# —— 小程序本地配置保护 ——
git update-index --skip-worktree miniprogram/config.js      # 改 config.js 之前
git update-index --no-skip-worktree miniprogram/config.js   # 不再需要时
```

## 15. 本手册对应的仓库文件

| 文件 | 作用 |
|---|---|
| `render.staging.yaml` | staging 的 Render 蓝图（API / 数据库 / 每日作业 / 管理端）；守卫测试 `test/config/render-staging.unit.test.ts` |
| `render.yaml` | **生产**蓝图（别用于 staging） |
| `deploy/cloudflare-pages.json` | Cloudflare Pages 的构建设置真源（第 6 节照它填） |
| `deploy/wechat-domains.json` | 将来微信后台要登记的域名清单 |
| `scripts/smoke.ts` | 部署后冒烟检查 |
| `scripts/stripe-rehearsal.ts` | 支付链路排练 |
| `.github/workflows/smoke.yml` | 每日自动冒烟 |
| `docs/真平台验收清单.md` | 所有「需要在真平台验证」的项，验过打勾 |
| `docs/上线运维手册-首次部署·回滚·审核期切正式.md` | 生产上线、回滚、故障处理 |
