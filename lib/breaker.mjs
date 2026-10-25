// 熔断器的状态机：纯函数，不碰时钟和 IO，时间一律从外面传进来。
//
// 模型：上游连续失败 threshold 次后「熔断」——期间新请求不再发往上游，
// 由中间件立刻回 429，让 agent 按它自己的退避策略重试。熔断窗口从
// baseSeconds 起步，每再失败一次翻一倍，封顶 maxSeconds。窗口过后放行
// 下一个请求去试探：成功即熔断关闭、计数清零；失败则窗口翻倍再关上。
//
// 上游「答了话」就算网络是通的——401、403、429 都是可达的证据，一律算
// 成功并清零。熔断器只管「连不连得上」，不管「答得好不好」。

/** 面板和 CLI 没配 options 时用的默认值。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  threshold: 3,
  baseSeconds: 20,
  maxSeconds: 120,
})

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 把用户配置并成完整的、范围合法的一组；ctx.options 可能是 undefined。 */
export function normalize(options) {
  const o = typeof options === "object" && options ? options : {}
  return {
    enabled: o.enabled !== false,
    threshold: clampInt(o.threshold, 1, 10, DEFAULTS.threshold),
    baseSeconds: clampInt(o.baseSeconds, 5, 300, DEFAULTS.baseSeconds),
    maxSeconds: clampInt(o.maxSeconds, 30, 1800, DEFAULTS.maxSeconds),
  }
}

/** 一份全新的熔断状态。 */
export function createState() {
  return { streak: 0, openUntil: 0, windowMs: 0 }
}

/** 上游这次没连上（5xx / 流中错误事件）。 */
export function recordFailure(state, options, now) {
  state.streak++
  if (state.streak >= options.threshold) {
    const cap = options.maxSeconds * 1000
    state.windowMs = state.windowMs ? Math.min(state.windowMs * 2, cap) : options.baseSeconds * 1000
    state.openUntil = now + state.windowMs
  }
  return state
}

/** 上游答了话：网络是通的，一切清零。 */
export function recordSuccess(state) {
  if (state.streak || state.openUntil || state.windowMs) {
    state.streak = 0
    state.openUntil = 0
    state.windowMs = 0
  }
  return state
}

/** 这个请求现在该不该被挡下。 */
export function check(state, now) {
  if (now < state.openUntil) {
    return {
      open: true,
      waitMs: state.openUntil - now,
      waitSeconds: Math.max(1, Math.ceil((state.openUntil - now) / 1000)),
      streak: state.streak,
      windowMs: state.windowMs,
    }
  }
  return { open: false, waitMs: 0, waitSeconds: 0, streak: state.streak, windowMs: state.windowMs }
}

/**
 * 流式/整包回复里，这一份数据算「上游没连上」吗。
 * 认得出各家 API 的流中错误：Anthropic 的 {type:"error"}、OpenAI 形状的
 * {error:{…}}、Responses 的 response.failed。其余一律算连通。
 */
export function looksLikeStreamError(data) {
  if (!data || typeof data !== "object") return false
  if (data.type === "error" || data.type === "response.failed") return true
  return data.error != null
}
