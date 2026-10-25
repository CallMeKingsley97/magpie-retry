# magpie-retry — 自动重试（网关熔断）

magpie 网关中间件：上游站点连不上时（网络抖动、站点抽风），不再让你的请求
干等到超时、也不烧掉 agent 自己的重试预算——数着连续失败次数「熔断」，
期间请求立刻回 429，由 agent 按它自带的退避策略自动重试；熔断窗口过后放行
一个请求去试探，一通就恢复放行、后续重试自动停止。你不用盯着终端。

## 为什么是这个形状

magpie 是网关：会话归终端里的 agent（Claude Code、Codex……）所有，agent
放弃的那一轮对话，任何插件都无法替它重新发起。但 agent 到 magpie 是本地
连接、永远通，断的是 magpie 到上游——而且这类 agent 对 429 本来就会按
退避节奏反复重试。所以这个插件不替 agent 重试，而是**给 agent 的重试循环
当节拍器**：

- **失败计数**：网关报给 agent 的连接失败（502/504）和上游自己的 5xx
  记一次失败；流式回复里的错误事件（Anthropic `error`、OpenAI 形状的
  `error:{…}`、Responses 的 `response.failed`）也算。
- **熔断**：连续失败达到阈值（默认 3 次）后，新请求不再发往上游，
  立刻回 `429` 和一句说明。agent 收到 429 自动重试，连接不再悬着干等。
- **试探恢复**：熔断窗口（默认 20s 起）过后放行下一个请求去试探：
  通了就关闭熔断、清零计数、一切如常；没通窗口翻倍再关上，封顶
  （默认 120s）。上游只要答了话——哪怕答的是 401、429——都算网络已通。

## 装

```sh
magpie plugin add github:CallMeKingsley97/magpie-retry
```

装上即生效（默认规则：3 次失败、20s 起步、120s 封顶）。

## 配置

唯一的界面：Settings → Plugins 标签里的「自动重试」面板。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后插件完全不介入（fail-open） |
| `threshold` | `3` | 连续失败几次后熔断（1–10） |
| `baseSeconds` | `20` | 第一段熔断窗口，5–300 秒 |
| `maxSeconds` | `120` | 窗口上限，之后不再翻倍（30–1800 秒） |

也可以用 CLI：

```sh
magpie plugin options magpie-retry '{"threshold": 5, "baseSeconds": 30}'
```

保存后网关在一秒内热加载，下一个请求就按新规则走。

## 边界

- **agent 重试耗尽、终端已经报错停下的那一轮，救不回来**——需要手动重发。
  这个插件做的是让 agent 的耐心撑过更长的抖动，而不是复活已死的回合。
- 熔断状态记在网关进程的内存里：重启 magpie 后从零数起；并发高时多个
  请求运行时各记各的账，熔断只会慢半拍，不会错挡。
- 熔断期间你的 agent 看到的是 429。个别对 429 不做重试的客户端会把错误
  直接显示出来——那种场景把 `enabled` 关掉即可。

## 隐私

纯本地：状态就是几个数字，记在 magpie 网关进程的内存里。不上盘、不发网、
不读你的对话内容、不碰你的密钥。

## 开发

```sh
npm test   # node --test "tests/*.test.mjs"
```

代码结构：

- `retry.middleware.js` — 网关中间件：`onRequest` 挡、`onResponse`/`onEvent` 数
- `lib/breaker.mjs` — 熔断状态机（纯函数，时间从外面传）
- `ui/panel.html` + `ui/panel.js` — Settings 面板：重试规则配置

## License

MIT
