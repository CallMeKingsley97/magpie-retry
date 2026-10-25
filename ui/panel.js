// Settings → Plugins 标签里的配置面板：唯一的配置界面，把重试规则写进
// 插件的 options。面板跑在沙箱 iframe 里，保存走 magpie.options.set，
// magpie 写完 plugins.json 后网关在一秒内热加载，下一个请求就生效。
// 插件没有往回写的通道，所以保存后只如实说「已保存」，不假装有状态可看。
(async () => {
  await magpie.ready;

  const DEFAULTS = { enabled: true, threshold: 3, baseSeconds: 20, maxSeconds: 120 };
  const LIMITS = { threshold: [1, 10], baseSeconds: [5, 300], maxSeconds: [30, 1800] };

  const $ = (id) => document.getElementById(id);
  const els = {
    enabled: $("enabled"),
    threshold: $("threshold"),
    base: $("base"),
    max: $("max"),
  };
  const fieldOf = { threshold: $("f-threshold"), baseSeconds: $("f-base"), maxSeconds: $("f-max") };
  const preview = $("preview");
  const result = $("result");
  const saveBtn = $("save");

  let opts = { ...DEFAULTS };
  try {
    const saved = await magpie.options.get();
    opts = { ...DEFAULTS, ...(typeof saved === "object" && saved ? saved : {}) };
  } catch {}

  const read = () => ({
    enabled: els.enabled.checked,
    threshold: Number(els.threshold.value),
    baseSeconds: Number(els.base.value),
    maxSeconds: Number(els.max.value),
  });

  const paint = () => {
    els.enabled.checked = opts.enabled !== false;
    els.threshold.value = opts.threshold;
    els.base.value = opts.baseSeconds;
    els.max.value = opts.maxSeconds;
    previewRules(read());
  };

  // 实时把三个数读成一句话，改到哪跟到哪——比字段说明更直白
  function previewRules(o) {
    if (!o.enabled) {
      preview.innerHTML = "";
      const off = document.createElement("span");
      off.className = "off";
      off.textContent = "已停用：插件不介入，请求照常直发上游。";
      preview.append(off);
      return;
    }
    const [minB, maxB] = LIMITS.baseSeconds;
    const bad = [...Object.entries(LIMITS)].some(([k, [lo, hi]]) => !(Number.isFinite(o[k]) && o[k] >= lo && o[k] <= hi));
    preview.textContent = bad
      ? "数字填好且在范围内，这里会显示当前的规则。"
      : `连不上 ${o.threshold} 次 → 熔断 ${o.baseSeconds}s，期间请求秒回 429 由 agent 重试；` +
        `再失败窗口翻倍，最多 ${o.maxSeconds}s。某次请求通了就立刻恢复、重试停止。`;
  }

  // 就近校验：范围外的字段标红并给一句怎么改
  function validate(o) {
    let firstBad = null;
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      const bad = !(Number.isFinite(o[k]) && o[k] >= lo && o[k] <= hi);
      fieldOf[k].classList.toggle("bad", bad);
      if (bad && !firstBad) firstBad = k;
    }
    return firstBad;
  }

  for (const el of Object.values(els)) el.addEventListener("input", () => {
    const o = read();
    previewRules(o);
    // 保存时标红的字段，改到合法就立刻撤掉红字；输入过程中不新添
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      if (fieldOf[k].classList.contains("bad") && Number.isFinite(o[k]) && o[k] >= lo && o[k] <= hi) {
        fieldOf[k].classList.remove("bad");
      }
    }
  });

  saveBtn.onclick = async () => {
    result.textContent = "";
    result.className = "";
    const o = read();
    const bad = validate(o);
    if (bad) {
      result.textContent = "有字段没填对，看红字提示。";
      result.className = "bad";
      fieldOf[bad].querySelector("input, .switch input")?.focus();
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      opts = await magpie.options.set(o);
      result.textContent = "已保存，下一个请求起生效。";
      result.className = "ok";
    } catch (e) {
      result.textContent = "没能保存：" + (e?.message ?? e);
      result.className = "bad";
    }
    saveBtn.disabled = false;
    saveBtn.textContent = "保存";
  };

  // 恢复默认只回填表单，不自动保存——看到预览觉得对再按保存
  $("reset").onclick = () => {
    opts = { ...DEFAULTS };
    paint();
    result.textContent = "已回填默认值，确认后按保存。";
    result.className = "ok";
  };

  paint();
})();
