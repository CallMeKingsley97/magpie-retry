import test from "node:test"
import assert from "node:assert/strict"

import { DEFAULTS, normalize, createState, recordFailure, recordSuccess, check, looksLikeStreamError } from "../lib/breaker.mjs"

const opts = (over = {}) => normalize({ ...over })

test("normalize：没配时给默认值，越界时收进范围", () => {
  assert.deepEqual(normalize(undefined), DEFAULTS)
  assert.deepEqual(normalize(null), DEFAULTS)
  assert.deepEqual(normalize({}), DEFAULTS)
  assert.equal(normalize({ threshold: 99 }).threshold, 10)
  assert.equal(normalize({ threshold: 0 }).threshold, 1)
  assert.equal(normalize({ threshold: "3" }).threshold, 3)
  assert.equal(normalize({ baseSeconds: 1 }).baseSeconds, 5)
  assert.equal(normalize({ maxSeconds: 99999 }).maxSeconds, 1800)
  assert.equal(normalize({ enabled: false }).enabled, false)
  assert.equal(normalize({ enabled: true }).enabled, true)
  // maxSeconds 收得比 baseSeconds 小时，翻倍逻辑由 Math.min 兜底
  assert.equal(normalize({ baseSeconds: 300, maxSeconds: 30 }).maxSeconds, 30)
})

test("失败不到阈值不熔断，到了就开窗，之后翻倍、封顶", () => {
  const s = createState()
  const o = opts({ threshold: 3, baseSeconds: 20, maxSeconds: 120 })

  recordFailure(s, o, 0)
  recordFailure(s, o, 0)
  assert.equal(check(s, 0).open, false)

  recordFailure(s, o, 0) // 第 3 次：开 20s
  let c = check(s, 10_000)
  assert.equal(c.open, true)
  assert.equal(c.waitSeconds, 10)
  assert.equal(s.windowMs, 20_000)

  // 窗口过后试探又失败：翻倍 40s
  recordFailure(s, o, 20_000)
  assert.equal(s.windowMs, 40_000)
  assert.equal(check(s, 20_000).open, true)

  recordFailure(s, o, 60_000)
  assert.equal(s.windowMs, 80_000)
  recordFailure(s, o, 140_000)
  assert.equal(s.windowMs, 120_000, "封顶 maxSeconds")
})

test("上游答了话就清零——哪怕答的是 401/429 这种坏消息", () => {
  const s = createState()
  const o = opts({ threshold: 1, baseSeconds: 30 })
  recordFailure(s, o, 0)
  assert.equal(check(s, 0).open, true)
  recordSuccess(s)
  assert.equal(check(s, 0).open, false)
  assert.equal(s.streak, 0)
  assert.equal(s.openUntil, 0)
})

test("check 在窗口内报等待秒数，过期即放行", () => {
  const s = createState()
  const o = opts({ threshold: 1, baseSeconds: 20 })
  recordFailure(s, o, 100_000)
  assert.equal(check(s, 100_001).waitSeconds, 20)
  assert.equal(check(s, 120_000).open, false, "窗口刚过就放行试探")
})

test("流中错误认得出三家，普通增量不算", () => {
  assert.equal(looksLikeStreamError({ type: "error", error: {} }), true, "Anthropic")
  assert.equal(looksLikeStreamError({ error: { message: "x" } }), true, "OpenAI 形状")
  assert.equal(looksLikeStreamError({ type: "response.failed" }), true, "Responses")
  assert.equal(looksLikeStreamError({ type: "content_block_delta", delta: {} }), false)
  assert.equal(looksLikeStreamError({}), false)
  assert.equal(looksLikeStreamError(undefined), false)
  assert.equal(looksLikeStreamError("data"), false)
})

test("成功时已经在熔断里也照样打开（恢复即停，后续重试自动结束）", () => {
  const s = createState()
  const o = opts({ threshold: 1 })
  recordFailure(s, o, 0)
  recordFailure(s, o, 1000)
  assert.equal(check(s, 1000).open, true)
  recordSuccess(s)
  assert.equal(check(s, 1000).open, false)
})
