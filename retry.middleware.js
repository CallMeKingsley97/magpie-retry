// magpie-retry 的网关中间件：上游连不上时，别让 agent 的请求干等或烧掉
// 它自己的重试预算——数着失败次数熔断，熔断期间一律立刻回 429，让 agent
// 按它自带的退避策略自动重试；窗口过了放行下一个请求去试探，成功即关。
//
// 状态放在模块级变量上：magpie 把每个请求的 runtime 从池里取，单用户网关
// 下同一个 runtime 反复复用，变量跨请求留存；并发高了会多出几个 runtime，
// 各自记各的账——熔断只是慢半拍，语义不变。整个中间件体系本来就是
// fail-open 的，状态错了顶多少挡一次。
//
// 钩子时限（onRequest/onResponse 各 250ms、onEvent 50ms）内只做几次数值
// 运算，不碰网络：这里没有 fetch，也没有计时器。
import { DEFAULTS, normalize, createState, recordFailure, recordSuccess, check, looksLikeStreamError } from "./lib/breaker.mjs"

const state = createState()

// 熔断从合到开的那一下才记日志（窗口翻倍不刷屏），恢复时也记一笔。
function fail(options) {
  const first = state.streak === options.threshold - 1
  recordFailure(state, options, Date.now())
  if (first && state.openUntil > Date.now()) {
    console.log(`[magpie-retry] 上游连续失败 ${state.streak} 次，熔断 ${Math.round(state.windowMs / 1000)}s：期间请求直接回 429，由 agent 自动重试`)
  }
}

function succeed() {
  const was = state.openUntil
  recordSuccess(state)
  if (was) {
    console.log("[magpie-retry] 上游恢复，熔断关闭，请求恢复正常放行")
  }
}

export function onRequest(_body, ctx) {
  const o = normalize(ctx?.options)
  if (!o.enabled) return
  const c = check(state, Date.now())
  if (c.open) {
    ctx.reject(
      429,
      `[magpie-retry] 上游暂时连不上（连续失败 ${c.streak} 次），已进入自动重试：` +
        `约 ${c.waitSeconds}s 后放行下一个请求试探恢复，成功即停止。请让请求保持重试。`,
    )
  }
}

export function onResponse(_body, ctx) {
  const o = normalize(ctx?.options)
  if (!o.enabled) return
  const status = Number(ctx?.status) || 0
  if (status >= 500) {
    fail(o)
  } else if (status > 0) {
    // 上游答了话——401/403/429 都是可达的证据，网络是通的
    succeed()
  }
}

export function onEvent(event, ctx) {
  const o = normalize(ctx?.options)
  if (!o.enabled) return
  const data = event?.data
  if (data && typeof data === "object" && looksLikeStreamError(data)) {
    fail(o)
  } else {
    // 流里能收到事件 = 上游已经连上、正在吐字
    succeed()
  }
}

export { DEFAULTS }
