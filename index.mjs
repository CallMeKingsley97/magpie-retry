// 额度管家（Quota Manager）：magpie 插件
//
// 把 magpie 里配好的 new-api / sub2api 站点，额度读进 magpie 自己的 Usage 卡片。
//  - 账号：一个账号 = 一个站点 + 一份凭据（new-api 用 sk-… 令牌，sub2api 用
//    API 密钥或登录令牌）
//  - 批量导入：把 providers.json 里已经配好的站点一次性搬进来，凭据就是那条
//    provider 的 key
//  - 卡片：套餐、额度窗口、余额、到期时间都用 magpie 的结构化字段交出去，
//    由 magpie 自己排版、翻译、做额度提醒
//
// 只读 magpie 自己的配置文件，只把请求发往用户自己配置的那些站点；日志里不写密钥。

import path from "node:path"

import { asRecord, requestJson, siteKeyOf, siteLabel, siteRootOf } from "./lib/core.mjs"
import { PLUGIN_ID, patchAccountState, putAuthAccounts, dropAuthAccount, dropAccountState, patchState, loadState, isPluginAccountShape, readJsonFile, loadProviderSites, registeredSites, authFilePath } from "./lib/store.mjs"
import { detectSite } from "./lib/detect.mjs"
import { loginSub2Api } from "./lib/sub2api.mjs"
import { usageFor } from "./lib/usage.mjs"

const PROVIDER_ID = PLUGIN_ID
const PROVIDER_NAME = "额度管家"

// 声明过的开关（auth.options）；用户的值在 settings.json 的 pluginOptions 里
const OPTION_KEYS = { showProviderScan: "showProviderScan" }

// settings 面板（ui/panel.html）通过 magpie.options.set 请求导入；插件进程
// 收到的第二个参数就是这些 options。上次请求的时间戳记住，处理过就清掉，
// 避免每次 config 钩子都重复导入。
let lastImportRequestAt = 0

// config 钩子在 magpie 每次拼请求配置时都会被叫到；扫一眼 providers.json
// 虽然只是读本地文件，也没必要每秒读好几遍。十分钟看一次足够了。
const PROVIDER_SCAN_INTERVAL = 10 * 60 * 1000
let lastProviderScanAt = 0

export default {
  id: PLUGIN_ID,
  async server(input, panelOptions = {}) {
    const client = input?.client
    const directory = input?.directory
    const magpieOption = (key) => {
      try {
        return input?.magpie?.option?.(PROVIDER_ID, key) === true
      } catch {
        return false
      }
    }
    // settings 面板写进 plugins.json Entry.Options 的值，host 把它作为
    // server() 的第二个参数传进来（面板通过 magpie.options.set 更新它）
    const entryOptions = () => (typeof panelOptions === "object" && panelOptions ? panelOptions : {})

    const log = async (level, message) => {
      try {
        await client?.app?.log?.({ body: { service: PLUGIN_ID, level, message: String(message) } })
      } catch {}
    }

    // ---- 账号登记簿 --------------------------------------------------------
    //
    // magpie 把每个账号记在自己的 key 下（第一个是 provider id，其余是
    // id#xxxxxx）；账号挂在哪个站点、叫什么名字，记在 state.json 里。

    /** 账号名 = provider id（第一个账号）或 provider#xxxx（其余）。 */
    /**
     * 账号名 = provider id（第一个账号）或 provider#xxxx（其余）。
     * 只认“有站点信息”的账号：以前版本或许留下过只有一个令牌的半个账号，
     * 不该让它占着名字、让后来的站点被记成第二个。
     */
    function accountKeyFor() {
      const all = readAuthFile()
      const keys = Object.keys(all).filter(
        (k) => (k === PROVIDER_ID || k.startsWith(PROVIDER_ID + "#")) && isPluginAccountShape(all[k]),
      )
      const usedIds = new Set(keys.map((k) => String(asRecord(all[k])?.accountId ?? "").trim()).filter(Boolean))
      if (!keys.includes(PROVIDER_ID)) return PROVIDER_ID
      for (;;) {
        const k = `${PROVIDER_ID}#${Math.random().toString(36).slice(2, 8)}`
        if (k in all || usedIds.has(k)) continue
        return k
      }
    }

    /** 直接读插件的 auth 文件，只为了给账号排序、去重（不写）。 */
    function readAuthFile() {
      const v = readJsonFile(authFilePath(directory))
      return asRecord(v) ?? {}
    }

    /**
     * 这个站点已经登记过的话，它在 auth 文件里的 key。
     * 重新添加同一个站点（比如换了令牌）要改这一条，不能再开一条：
     * 同一站点堆两条账号，列表里就会重复，还各自记一份状态。
     */
    function accountKeyForSite(site) {
      const want = siteKeyOf(site)
      if (!want) return ""
      const all = readAuthFile()
      for (const k of pluginAccountKeys(all)) {
        const a = asRecord(all[k])
        if (!isPluginAccountShape(a)) continue
        if (siteKeyOf(String(a.metadata?.site ?? a.site ?? "")) === want) return k
      }
      return ""
    }

    /** 本插件自己的账号（按 agent 名字或 site 找条目时用得到）。 */
    function pluginAccountKeys(all = readAuthFile()) {
      return Object.keys(all).filter((k) => k === PROVIDER_ID || k.startsWith(PROVIDER_ID + "#"))
    }

    /** 能展示的账号：读不懂的条目跳过（但不动它们）。 */
    function accountsIn(all = readAuthFile()) {
      return pluginAccountKeys(all)
        .filter((k) => isPluginAccountShape(all[k]))
        .map((k) => ({ key: k, auth: asRecord(all[k]) ?? {} }))
    }

    function currentAccounts() {
      return accountsIn().sort((a, b) => (a.key === PROVIDER_ID ? -1 : b.key === PROVIDER_ID ? 1 : a.key < b.key ? -1 : 1))
    }

    /**
     * 把一个账号写进 plugin-auth.json。不在登录流程里时（添加站点），
     * 不能走 client.auth.set（会写到 provider 自己那一个 key 上）。
     */
    function saveAccountFile(key, body) {
      const ok = putAuthAccounts(directory, new Map([[key, body]]))
      if (!ok) log("error", "写 plugin-auth.json 失败（文件可能正被占用或读不出来），这次没有保存")
      return ok
    }

    /**
     * 更新已有账号的凭据（sub2api 续期后用）。
     * 保住原有的账号名和 metadata，只改新的令牌；写坏了也留住旧的，
     * 不能因为一次续期把账号的站点信息搞丢。
     */
    function saveAuthUpdate(key, cred) {
      const all = readAuthFile()
      const cur = asRecord(all[key])
      if (!cur) return false
      const body = {
        ...cur,
        ...(cred?.access ? { key: cred.access } : {}),
        metadata: {
          ...(asRecord(cur.metadata) ?? {}),
          ...(cred?.access ? { access: cred.access } : {}),
          ...(cred?.refresh ? { refresh: cred.refresh } : {}),
          ...(cred?.expires ? { expires: cred.expires } : {}),
        },
      }
      return saveAccountFile(key, body)
    }

    /**
     * 凭 magpie 给的凭据反查它在 auth 文件里的 key（账号名就是 accountId）。
     * usage 钩子只拿到 getAuth，没有 key，续期时要靠这个找回落点。
     */
    function accountKeyOf(auth) {
      const want = String(asRecord(auth)?.accountId ?? "").trim()
      if (!want) return ""
      const all = readAuthFile()
      for (const k of pluginAccountKeys(all)) {
        if (String(asRecord(all[k])?.accountId ?? "").trim() === want) return k
      }
      return ""
    }

    // ---- 账号登记簿 --------------------------------------------------------
    /** 一次导入多个站点：批量写 auth 文件（读一次写一次），批量记 state。 */
    function saveAccounts(entries) {
      const pairs = new Map()
      const notes = []
      for (const e of entries) {
        pairs.set(e.key, {
          type: "api",
          key: e.credential,
          accountId: e.name,
          metadata: { site: e.site, name: e.name, source: e.source ?? "providers.json", kind: e.kind, provider: e.provider ?? "" },
        })
        notes.push([e.key, { site: e.site, name: e.name, kind: e.kind, source: e.source ?? "providers.json" }])
      }
      if (!putAuthAccounts(directory, pairs)) {
        log("error", "写 plugin-auth.json 失败（文件可能正被占用或读不出来），这次没有保存")
        return false
      }
      for (const [key, meta] of notes) patchAccountState(directory, key, meta)
      return true
    }

    async function importProviders({ dryRun = false } = {}) {
      const known = new Set(registeredSites(directory).map((s) => s.key))
      const sites = loadProviderSites(directory)
      const added = []

      // 以前版本放过没展开的占位符（{{API_KEY_xxx}}），那种不是真凭据，顺手清掉
      for (const { key, auth } of accountsIn()) {
        if (!/^\{\{.*\}\}$/.test(String(auth?.key ?? ""))) continue
        dropAuthAccount(directory, key)
        dropAccountState(directory, key)
        log("info", `清掉了一个占位符账号：${String(auth?.accountId ?? key)}`)
      }

      // 挑出要导的：没登记过、providers.json 那条带真 key（占位符不算凭据）
      const candidates = []
      for (const s of sites) {
        if (known.has(s.key)) continue
        if (!s.hasKey) continue
        const cred = String(findProviderRecord(s)?.key ?? "").trim()
        if (!cred || /^\{\{.*\}\}$/.test(cred)) continue
        candidates.push({ site: s, cred })
        known.add(s.key)
      }
      if (dryRun) {
        return candidates.map(({ site }) => ({ site: site.site, name: site.name, source: site.source, action: "会导入" }))
      }

      // 站点类型要逐站探测（对每个站点发一次公开请求）。七十个站点串行下来
      // 要好几分钟——面板“等了超级久”多半是它；开个小池子并发，几秒就完
      const batch = []
      let cursor = 0
      const workers = Array.from({ length: Math.min(6, candidates.length) }, async () => {
        for (;;) {
          const i = cursor++
          if (i >= candidates.length) return
          const { site: s, cred } = candidates[i]
          const detected = await detectSite(s.site).catch(() => undefined)
          batch.push({
            key: accountKeyFor(),
            site: s.site,
            name: s.name,
            kind: detected?.kind ?? "unknown",
            credential: cred,
            provider: s.providerIds[0] ?? "",
          })
        }
      })
      await Promise.all(workers)

      if (batch.length && !saveAccounts(batch)) return added
      for (const e of batch) added.push({ site: e.site, name: e.name, account: e.key, kind: e.kind, action: "已导入" })
      return added
    }

    /** 在 providers.json / plugin-providers.json 里找一条 provider 记录。 */
    function findProviderRecord(siteEntry) {
      for (const file of ["providers.json", "plugin-providers.json"]) {
        const data = readJsonFile(path.join(directory, file))
        const list = Array.isArray(data) ? data : Array.isArray(data?.providers) ? data.providers : Array.isArray(data?.plugins) ? data.plugins : []
        for (const p of list) {
          const r = asRecord(p)
          if (!r) continue
          const id = String(r.id ?? r.name ?? "")
          if (siteEntry.providerIds.includes(id) && typeof r.key === "string" && r.key) return r
        }
      }
      return undefined
    }

    /** 试一下凭据能不能读额度：new-api 读令牌额度，sub2api 读 /v1/usage 或登录资料。 */
    async function probeToken(site, kind, token) {
      const t = String(token ?? "").trim()
      const out = (r, hint) => ({
        ...r,
        rejected: r.status === 401 || r.status === 403,
        // 404 / 别的站点的信封：这条凭据不是给这个接口用的
        unrecognized: r.status === 404 || r.status === 405,
        hint,
      })
      if (kind === "new-api") {
        const r = await requestJson(site, "/api/usage/token/", { headers: { Authorization: `Bearer ${t}` } })
        return out(r, "new-api 要用站点「令牌」页建的 sk-… 令牌")
      }
      // JWT 是登录令牌，不是网关的 API 密钥
      if (!t.includes(".")) {
        const r = await requestJson(site, "/v1/usage", { headers: { Authorization: `Bearer ${t}` } })
        return out(r, "sub2api 要用站点里建的 sk-… API 密钥")
      }
      const r = await requestJson(site, "/api/v1/auth/me", { headers: { Authorization: `Bearer ${t}` } })
      return out(r, "请确认用的是登录后的 access token")
    }

    /** 用凭据试两种读法，返回能读通的那一种（以及探测回答）。 */
    async function probeCredential(site, token, preferred) {
      const first = preferred || (String(token).includes(".") ? "sub2api" : "new-api")
      let firstProbe
      for (const kind of [first, first === "new-api" ? "sub2api" : "new-api"]) {
        const probe = await probeToken(site, kind, token)
        if (probe.error) return { kind, probe }
        if (probe.rejected || probe.unrecognized) {
          firstProbe ??= { kind, probe }
          continue
        }
        return { kind, probe }
      }
      // 两种读法都不认：按记下的类型给一句最贴近的说明
      return firstProbe
    }

    /**
     * 新增/更新一个站点。token 给了就直接用；只给了邮箱密码就往 sub2api 登录。
     * 返回一句给人看的结果。
     */
    async function addSite({ site, token, email, password, name, kind }) {
      const root = siteRootOf(site)
      if (!root) return { ok: false, message: `站点地址看不懂：${site}` }
      const detected = await detectSite(root)
      const resolvedKind = detected?.kind ?? (kind === "new-api" || kind === "sub2api" ? kind : "")

      if (token) {
        // 公开接口认不出来的站点（前置网关、Cloudflare 拦截）也照样能加：
        // 凭据本身能不能读通，比站点指纹更算数
        const { kind: probedKind, probe } = await probeCredential(root, token, resolvedKind)
        if (probe.error) return { ok: false, message: `${siteLabel(root)} 连不上：${probe.error}` }
        if (probe.rejected) {
          return { ok: false, message: `${siteLabel(root)} 不认这个凭据（HTTP ${probe.status}）。${probe.hint}` }
        }
        if (probe.unrecognized) {
          return {
            ok: false,
            message: `${siteLabel(root)} 没有可用的额度接口（HTTP ${probe.status}）：new-api 用 /api/usage/token/，sub2api 用 /v1/usage。请确认地址填的是站点根地址。`,
          }
        }
        const finalKind = resolvedKind || probedKind
        const label = name || accountLabelFromProbe(probe, root)
        const key = accountKeyForSite(root) || accountKeyFor()
        const body = {
          type: "api",
          key: String(token).trim(),
          accountId: label,
          metadata: { site: root, name: label, kind: finalKind, source: "manual" },
        }
        if (!saveAccountFile(key, body)) {
          return { ok: false, message: "读到 magpie 的账号文件时出了问题，这次没有写入。请稍后再试一次。" }
        }
        patchAccountState(directory, key, { site: root, name: label, kind: finalKind, source: "manual" })
        return { ok: true, account: key, message: `已加入 ${label}（${finalKind}）` }
      }

      if (!detected) {
        return {
          ok: false,
          message: `${siteLabel(root)} 没认出是 new-api 还是 sub2api，插件暂时读不了它的额度。请确认地址正确、填的是站点首页；如果站点换了接口，欢迎到仓库提 issue 说明这个站点。`,
        }
      }
      if (resolvedKind !== "sub2api") {
        return {
          ok: false,
          message: `${siteLabel(root)} 是 new-api 站点，不支持账号密码登录（它没有稳定的登录接口）。请到站点的「令牌」页建一把 sk-… 令牌后填进来。`,
        }
      }
      if (!email || !password) {
        return { ok: false, message: "sub2api 站点需要邮箱和密码，或直接填一个 API 密钥 / access token" }
      }
      try {
        const tokens = await loginSub2Api(root, { email, password })
        const label = name || tokens.accountId || siteLabel(root)
        const key = accountKeyForSite(root) || accountKeyFor()
        const body = {
          type: "api",
          key: tokens.access,
          accountId: label,
          metadata: {
            site: root,
            name: label,
            kind: "sub2api",
            source: "login",
            // 邮箱密码留着：令牌过期时能自动重新登录，不用你手动补
            email: String(email ?? "").trim(),
            password: String(password ?? ""),
            ...(tokens.uid ? { uid: tokens.uid } : {}),
            ...(tokens.refresh ? { refresh: tokens.refresh } : {}),
            ...(tokens.expires ? { expires: tokens.expires } : {}),
          },
        }
        if (!saveAccountFile(key, body)) {
          return { ok: false, message: "登录成功了，但写 magpie 的账号文件时出了问题。请到「设置 → 账号」手动加一次，或稍后重试。" }
        }
        patchAccountState(directory, key, { site: root, name: label, kind: "sub2api", source: "login" })
        return { ok: true, account: key, message: `已登录 ${label} 并加入额度管家（令牌会过期，到期会自动续）` }
      } catch (e) {
        return { ok: false, message: `登录失败：${e?.message ?? e}` }
      }
    }

    /** 从探测回答里挑一个账号名：new-api 令牌名、sub2api 的邮箱/用户名，都没有就用域名。 */
    function accountLabelFromProbe(probe, root) {
      const d = asRecord(probe.body)
      const data = asRecord(d?.data) ?? d ?? {}
      const user = asRecord(data.user) ?? data
      return String(user?.email ?? user?.username ?? user?.display_name ?? user?.name ?? "").trim() || siteLabel(root)
    }

    /**
     * 把额度整理成一张卡片。字段都是 magpie 自己的额度结构（plan/windows/
     * balance/until），排版和额度提醒交给 magpie。这里先读一次凭据，按它在
     * auth 文件里的 key 查 state.json 里用户给站点起的名字。
     */
    async function usageCard(getAuth) {
      let auth
      try {
        auth = asRecord(await getAuth()) ?? {}
      } catch {
        auth = {}
      }
      const fileKey = accountKeyOf(auth)
      const key = fileKey || String(auth.accountId ?? auth.metadata?.name ?? "").trim()
      return usageFor(getAuth, { directory, accountId: key, auth, save: (c) => saveAuthUpdate(fileKey, c) })
    }

    // ---- 给 agent 用的动作 --------------------------------------------------
    //
    // magpie 会把 tool 钩子里的工具挂到插件工具的 MCP server 上，agent 直接就能调。

    /** 列出所有站点与账号：providers.json 里有什么、已经导入了哪些。 */
    async function listSites() {
      const known = registeredSites(directory)
      const knownKeys = new Set(known.map((s) => s.key))
      const rows = loadProviderSites(directory).map((s) => ({
        site: s.site,
        name: s.name,
        from: s.source,
        providers: s.providerIds,
        hasKey: s.hasKey,
        imported: knownKeys.has(s.key),
      }))
      const accounts = currentAccounts().map((a) => ({
        account: a.key,
        site: String(a.auth.site ?? a.auth.metadata?.site ?? ""),
        name: String(a.auth.accountId ?? a.auth.metadata?.name ?? ""),
        kind: String(a.auth.metadata?.kind ?? ""),
      }))
      return {
        accounts,
        sites: rows,
        unimported: rows.filter((r) => !r.imported),
        hint:
          "添加一个站点：action=add，给出 site 和 token（new-api 用 sk-… 令牌，sub2api 用 API 密钥或登录令牌）；" +
          "sub2api 也可以给 email + password 直接登录。" +
          "一键导入 providers.json 里已有的中转站：action=import。",
      }
    }

    /** 一键导入 providers.json / plugin-providers.json 里还没进来的站点。 */
    async function importAll() {
      const added = await importProviders({})
      return {
        added,
        message: added.length
          ? `导入了 ${added.length} 个站点，打开 Settings → Usage 就能看到它们的额度。`
          : "没有可导入的站点（要么都导入过了，要么那些 provider 里没有带 key 的中转站）。",
      }
    }

    /** 把一个账号移出额度管家（只是不再读它的额度，站点上的账号不受影响）。 */
    async function removeAccount({ account = "" } = {}) {
      const key = String(account ?? "").trim()
      if (!key) return { ok: false, message: "要给出账号名" }
      // 能删的包括读不出站点信息的“半条账号”：正好用来打扫
      if (!pluginAccountKeys().includes(key)) return { ok: false, message: `没有这个账号：${key}` }
      if (!dropAuthAccount(directory, key)) {
        return { ok: false, message: `没能移除 ${key}（账号文件读不出来或本来就不在）` }
      }
      return { ok: true, message: `已移除 ${key}（站点上的账号不受影响）` }
    }

    // ---- 插件导出 ----------------------------------------------------------

    /** magpie 在开发模式下会把钩子里的异常打出来（见 provider-plugins 文档）。 */
    async function safety(what, fn) {
      try {
        return await fn()
      } catch (e) {
        log("error", `${what} 时出错：${e?.message ?? e}`)
        return undefined
      }
    }

    return {
      /**
       * magpie 每次拼请求配置时都会叫一次。这里给额度管家安一个 provider 壳子：
       * 地址用 plugin:// 开头（magpie 认得，不会真去联网），名字显示成「额度管家」，
       * 这样它在列表里是显式的、而不是缺省的一行灰字。
       */
      config: async (config) =>
        safety("拼配置", () => {
          config.provider ??= {}
          config.provider[PLUGIN_ID] = {
            name: PROVIDER_NAME,
            api: `plugin://${PLUGIN_ID}`,
            ...(config.provider[PLUGIN_ID] ?? {}),
          }

          // settings 面板请求了一次导入：跑一遍。请求时间要记进 state.json——
          // options 里那个 importRequested 清不掉（面板和插件各写各的），
          // 不记的话 magpie 每次重启都会当成新请求，把全部站点重新扫一遍
          const opts = entryOptions()
          const asked = Number(opts?.importRequested ?? 0)
          if (asked && asked !== lastImportRequestAt) {
            lastImportRequestAt = asked
            if (asked !== Number(loadState(directory).importRequestedAt ?? 0)) {
              patchState(directory, { importRequestedAt: asked })
              importProviders({})
                .then((added) => {
                  log("info", added.length ? `面板导入完成：${added.length} 个站点` : "面板导入：没有新的站点可导入")
                })
                .catch((e) => log("error", `面板导入失败：${e?.message ?? e}`))
            }
          }

          if (magpieOption(OPTION_KEYS.showProviderScan) && Date.now() - lastProviderScanAt > PROVIDER_SCAN_INTERVAL) {
            lastProviderScanAt = Date.now()
            const sites = loadProviderSites(directory)
            const known = new Set(registeredSites(directory).map((s) => s.key))
            const fresh = sites.filter((s) => !known.has(s.key))
            if (fresh.length) {
              log(
                "info",
                `发现 ${fresh.length} 个还没加入额度管家的站点：${fresh
                  .slice(0, 8)
                  .map((s) => s.name)
                  .join("、")}${fresh.length > 8 ? " 等" : ""}。可以对 agent 说“把没导入的站点导入额度管家”。`,
              )
            }
          }
        }),

      auth: {
        provider: PROVIDER_ID,
        label: PROVIDER_NAME,
        // 仪表盘线稿图标（24×24、圆角端点），颜色在浅色和深色卡片上都够亮；
        // magpie 把它当图片画，不能用 currentColor
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTZhMzRhIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTMuNSAxOGE4LjUgOC41IDAgMSAxIDE3IDAiLz48cGF0aCBkPSJtMTIgMTUgNC4yLTQuMiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTUiIHI9IjEuMyIgZmlsbD0iIzE2YTM0YSIgc3Ryb2tlPSJub25lIi8+PHBhdGggZD0iTTQuNSAxNGgyTTE3LjUgMTRoMk02LjYgOC42bDEuNCAxLjRNMTcuNCA4LjYgMTYgMTAiLz48L3N2Zz4=",
        options: [
          {
            key: OPTION_KEYS.showProviderScan,
            label: "启动时检查其它 Provider",
            description:
              "启动时看一眼 providers.json 里还有哪些站点没加进来，在日志里提一句。只读地址，不碰凭据；这个开关本身不会导入任何东西。",
            default: false,
          },
        ],

        methods: [
          {
            type: "api",
            // keyless：magpie 不问任何密钥，直接跑下面的 authorize —— 它把
            // providers.json 里还没进来的站点一键导入。界面上不再是“登录”，
            // 而是一次“导入”：不填表单、不输密码。
            keyless: true,
            label: "导入站点",
            async authorize() {
              const added = await importProviders({})
              if (!added.length) {
                const sites = loadProviderSites(directory)
                const withKey = sites.filter((s) => s.hasKey).length
                return {
                  type: "failed",
                  error:
                    registeredSites(directory).length && withKey
                      ? "都导入过了。新配置了站点后再点一次即可。"
                      : "providers.json 里还没有带 key 的中转站。先在 magpie 里把站点配好，再回来点「导入」。",
                }
              }
              // 成功也要在 magpie 里留下一个“账号”，否则卡片行仍然显示“未登录”、
              // 按钮还是“Sign in”。这个影子账号不读额度：usageCard 对 kind:imported
              // 的账号只报一句导入结果。sign-in 带来的 key/accountId 由 host 写文件，
              // 这里的返回只提供内容。
              return {
                type: "success",
                key: `imported-${added.length}-${Date.now().toString(36)}`,
                accountId: `已导入 ${added.length} 个站点`,
                metadata: { site: "https://imported.localhost", name: "导入", kind: "imported", source: "import" },
              }
            },
          },
        ],

        /** magpie 每次用到账号前会问一次；额度管家不需要额外准备什么。 */
        async loader() {
          return {}
        },

        usage: (getAuth) => safety("读额度", () => usageCard(getAuth)),
      },

      tool: {
        manage_usage: {
          description:
            "额度管家：列出/导入 magpie 里配置的中转站（new-api、sub2api），把它们的额度读进 Usage 卡片。" +
            "action=providers 列出站点与账号；action=import 一键导入 providers.json 里的站点；" +
            "action=add 添加一个站点（site、token 或 email/password）；action=remove 移除一个账号。",
          args: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["providers", "import", "add", "remove"] },
              site: { type: "string", description: "站点地址，例如 https://example.com" },
              token: { type: "string", description: "站点凭据：new-api 的 sk-… 令牌 / sub2api 的 API 密钥或 access token" },
              email: { type: "string" },
              password: { type: "string" },
              name: { type: "string" },
              account: { type: "string", description: "要移除的账号名" },
            },
            required: ["action"],
          },
          async execute(args = {}) {
            const action = String(args.action ?? "")
            try {
              if (action === "providers") return { output: JSON.stringify(await listSites(), null, 2) }
              if (action === "import") {
                const out = await importAll()
                return { output: `${out.message}\n\n${JSON.stringify(out.added, null, 2)}` }
              }
              if (action === "add") {
                const out = await addSite(args)
                return { output: out.message ?? JSON.stringify(out, null, 2) }
              }
              if (action === "remove") {
                const out = await removeAccount({ account: args.account })
                return { output: out.message ?? JSON.stringify(out, null, 2) }
              }
              return { output: "action 要是 providers / import / add / remove 之一" }
            } catch (e) {
              return { output: `这一步没做成：${e?.message ?? e}` }
            }
          },
        },
      },
    }
  },
}
