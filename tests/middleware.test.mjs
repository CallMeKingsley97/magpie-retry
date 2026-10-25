import test from "node:test"
import assert from "node:assert/strict"

// 直接驱动真实的中间件文件：钩子内部用 Date.now()，用 node:test 的
// 假时钟控制时间。每个场景用带查询串的动态导入拿一份全新的模块实例
// （ESM 按完整 URL 缓存），互不串场。

const load = (tag) => import(`../retry.middleware.js?case=${tag}`)

const rejectingWith = (onRequest) => () => {
  const rej = []
  onRequest({}, { options: {}, reject: (status, message) => rej.push({ status, message }) })
  return rej
}

test("整包回复场景：三次失败熔断，窗口内回 429，试探成功后恢复放行", (t) => {
  t.mock.timers.enable({ apis: ["Date"] })
  return load("whole").then(({ onRequest, onResponse }) => {
    const rejecting = rejectingWith(onRequest)

    t.mock.timers.setTime(0)
    // 前两次失败：放行（agent 自己会看到 502 自己重试）
    onResponse({}, { options: {}, status: 502 })
    onResponse({}, { options: {}, status: 504 })
    assert.deepEqual(rejecting(), [])

    // 第三次失败：熔断 20s，窗口内的请求一律 429
    onResponse({}, { options: {}, status: 502 })
    const rej = rejecting()
    assert.equal(rej.length, 1)
    assert.equal(rej[0].status, 429)
    assert.match(rej[0].message, /20s/)

    // 窗口内 429 不喂自己的计数：再多几个请求还是同一个窗口
    t.mock.timers.setTime(10_000)
    assert.equal(rejecting().length, 1)

    // 窗口过：放行试探；试探成功（上游答话，哪怕 429）→ 恢复放行
    t.mock.timers.setTime(21_000)
    assert.deepEqual(rejecting(), [], "窗口过后放行探测请求")
    onResponse({}, { options: {}, status: 429 })
    assert.deepEqual(rejecting(), [])

    // 再来一轮：从零数起
    onResponse({}, { options: {}, status: 502 })
    onResponse({}, { options: {}, status: 502 })
    assert.deepEqual(rejecting(), [])
    onResponse({}, { options: {}, status: 502 })
    assert.equal(rejecting().length, 1)
  })
})

test("流式场景：onEvent 判定连通，流中错误算失败", (t) => {
  t.mock.timers.enable({ apis: ["Date"] })
  return load("stream").then(({ onRequest, onEvent }) => {
    const rejecting = rejectingWith(onRequest)

    t.mock.timers.setTime(1_000_000)
    onEvent({ data: { type: "content_block_delta", delta: {} } }, { options: {} })
    assert.deepEqual(rejecting(), [])

    onEvent({ data: { type: "error", error: { message: "overloaded" } } }, { options: {} })
    onEvent({ data: { type: "error", error: {} } }, { options: {} })
    assert.deepEqual(rejecting(), [])
    onEvent({ data: { error: { code: "x" } } }, { options: {} })
    assert.equal(rejecting().length, 1, "三次流中错误后熔断")

    // 恢复：正常增量一到，立刻放行
    onEvent({ data: { type: "content_block_delta", delta: {} } }, { options: {} })
    assert.deepEqual(rejecting(), [])
  })
})

test("enabled=false 时不介入", async () => {
  const { onRequest, onResponse } = await load("disabled")
  const rej = []
  onResponse({}, { options: { enabled: false }, status: 502 })
  onRequest({}, { options: { enabled: false }, reject: (s) => rej.push(s) })
  assert.deepEqual(rej, [])
})
