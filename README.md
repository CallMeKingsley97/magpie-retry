# 额度管家（Quota Manager）

magpie 插件：把你在 magpie 里配置过的 new-api / sub2api 中转站额度，读进 magpie
自己的 Usage 卡片。一个账号 = 一个站点，卡片上的套餐、额度窗口、余额、到期时间
全用 magpie 的结构化字段，排版、翻译和额度提醒都交给 magpie。

不签到、不代登录、不改站点上的任何东西——只读。

## 装

```sh
magpie plugin add github:CallMeKingsley97/magpie-quota-manager
```

或者把仓库克隆下来，用本地路径装：

```sh
magpie plugin add /path/to/magpie-quota-manager
```

插件 ID 是 `quota-manager`，包名 `magpie-quota-manager`；agent 调用的工具名是
`magpie-quota-manager_manage_usage`。

> 仓库从 `magpie-api-auto-checkin` 改名成了 `magpie-quota-manager`。GitHub 会把
> 旧地址跳转到新地址，但已经装过旧版的人最好按下面的「从旧版升级」重装一次。

装好后 Providers 里会多出一个「额度管家」，每个站点的账号都挂在它下面。

### 从旧版（签到管家）升级

插件 ID 从 `auto-checkin` 改成了 `quota-manager`，账号和状态都按 ID 分开存，
所以要重装一次、重新导入一次：

```sh
magpie plugin rm magpie-api-auto-checkin
magpie plugin add github:CallMeKingsley97/magpie-quota-manager
```

然后在 Settings → Plugins 的「额度管家」面板里点一键导入，或让 agent 跑
`magpie-quota-manager_manage_usage` 的 `action=import`——它会把 providers.json
里所有带 key 的站点重新导入一遍（站点名、类型都会重新认，不丢信息）。

旧的 `~/.config/magpie/auto-checkin/` 和 `plugin-auth.json` 里 `auto-checkin*`
开头的条目不会被新插件碰，确认不需要了可以自己删掉。

## 用

### 1. 一键导入（推荐）

Settings → Plugins 标签里的「额度管家」面板有一个**一键导入**按钮：把
providers.json / plugin-providers.json 里已经配好、带 key 的站点一次导入，
凭据就是那条 provider 的 key。导入时会顺手认站点类型（看公开接口，不需要
密钥）；认不出来的也导进来，读卡片时再认一次。

也可以对 agent 说「把没导入的站点导入额度管家」，或让它调
`magpie-quota-manager_manage_usage`，`action=import`。

在 Providers → 额度管家 的账号列表里点「导入站点」，效果相同。

### 2. 手动加站点

想加 providers.json 之外的站点（或某个站点没带 key）时，对 agent 说：

> 用额度管家的 manage_usage 工具，action=add，站点 https://example.com，
> 令牌 sk-…

凭据分三种，按站点类型给：

| 凭据 | 什么时候用 |
| --- | --- |
| **new-api 令牌（sk-…）** | new-api 及同族站点。去站点的「令牌」/「设置 → 访问令牌」建一个 |
| **sub2api API 密钥（sk-…）** | sub2api 站点里建的 API 密钥 |
| **sub2api 登录令牌** | 从浏览器里复制登录后的 access token（sub2api 邮箱密码登录可由 agent 代做，插件会自动续期） |

添加时会用这把凭据真读一次额度，读得出来才收下——不会把一个填错的令牌
存进去，等到看卡片时才发现。

### 3. 看卡片

Settings → Usage，或者菜单栏。每张卡显示：

- **额度窗口**：进度条 + 「已用 / 剩余」切换。new-api 是这把令牌的额度，
  sub2api 是总额度以及 5h / 1d / 7d 三个速率窗口（有配才有）
- **余额**：站点只报一个数时（比如 sub2api 的钱包余额）就显示这一行
- **到期时间**：站点给了才有
- **账号名**：你给站点起的备注名

同一个站点被 magpie 记成 new-api、读出来却不像（前置网关、Cloudflare 拦截了
公开接口），插件会换另一家的读法再试一次；两种读法都不认这把凭据时，才会说
「不认这个令牌」。

卡片数据来自哪里：

| 站点类型 | 读到的东西 | 接口 |
| --- | --- | --- |
| new-api | 这把令牌的总额度 / 已用 / 剩余 / 是否无限 / 到期 | `GET /api/usage/token/`（令牌） |
| new-api | 按什么货币显示（USD / CNY / 自定义 / 令牌数）、汇率 | `GET /api/status`（公开） |
| sub2api | 总额度、5h / 1d / 7d 速率窗口、订阅的日 / 周 / 月额度、钱包余额 | `GET /v1/usage`（API 密钥） |
| sub2api | 账号余额 | `GET /api/v1/user/profile`（登录令牌） |

**额度提醒是自动的。** magpie 会拿卡片上的窗口百分比和余额数字去比对
Settings → Usage → Alerts 里设的阈值；这里提供的余额都是 magpie 能解析的
金额（`$6.71`、`¥70`、`无限`），所以设了提醒就会响。

## 边界与隐私

- **没有登录，没有信息泄露。** 插件不要求你输入密码，不做任何形式的账号登录；
  凭据只来自 magpie 自己的 `providers.json`（那是你已经配好的），或者你明确
  让 agent 添加的那一条。
- 只读 magpie 自己的配置文件（`providers.json`、`plugin-providers.json`、
  自己的 `plugin-auth.json`），请求**只发往你自己配置的那些站点**。
- 不上传、不转发、不收集任何数据：没有遥测，没有第三方接口，界面上也写明了
  这一点（Settings → Plugins → 额度管家）。
- 日志和提示里不写密钥，不写完整响应体。
- sub2api 的邮箱密码只有 agent 代你添加时才会出现在账号里（存 magpie 的
  `plugin-auth.json`，0600），只用于令牌过期时自动续期；不想存密码就用
  登录令牌方式。
- 读不出来的结论一律如实说：没认出来、令牌被拒、连不上、被限流，各有各的说法，
  不会把「读不到」显示成余额 0。

## 已知限制

- **new-api 的 `/api/user/self` 用令牌读不了**（一律 401），所以 new-api 的
  余额只能按这把令牌自己的额度算；令牌设成「无限额度」、站点又不允许查用户额度
  时，卡片显示「无限」，给不出具体数字。
- 商店按什么货币显示由站点的 `/api/status` 决定；站点没配（占位符 `¤`）时
  按美元算。
- 同一个站点记一个账号。同一站点想读多个账号的额度，暂时得分开装一份。
- 卡片结果缓存 5 分钟（出错时 2 分钟），站点被限流时按 `Retry-After` 退避，
  退避期内一次请求都不发。

## 开发

```sh
npm test        # node --test "tests/*.test.mjs"
```

代码结构：

- `index.mjs` — 插件入口：config / auth / tool 三个钩子
- `lib/core.mjs` — HTTP、响应解包、限流退避、本地状态文件
- `lib/detect.mjs` — 认站点（new-api / sub2api），带缓存
- `lib/newapi.mjs` — new-api 的额度与货币换算
- `lib/sub2api.mjs` — sub2api 的登录、续期、额度
- `lib/store.mjs` — 站点清单、账号登记
- `lib/usage.mjs` — 把上面两家的读数拼成 magpie 的 Usage 卡片
- `ui/panel.html` + `ui/panel.js` — Settings → Plugins 里的面板：一键导入
  按钮和隐私说明

## 后续

见 [ROADMAP.md](ROADMAP.md)：模型清单漂移检测、站点公告汇总。

## License

MIT
