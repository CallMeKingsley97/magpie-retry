// Settings → Plugins 标签里的配置面板：唯一的界面，只管把重试规则写进
// 插件的 options。面板跑在沙箱 iframe 里，保存走 magpie.options.set，
// magpie 写完 plugins.json 后网关在一秒内热加载，下一个请求就生效。
// 插件没有往回写的通道，所以保存后只如实说「已保存」，不假装有状态可看。
(async () => {
  await magpie.ready;

  const els = {
    enabled: document.getElementById("enabled"),
    threshold: document.getElementById("threshold"),
    base: document.getElementById("base"),
    max: document.getElementById("max"),
  };
  const result = document.getElementById("result");
  const button = document.getElementById("save");

  const DEFAULTS = { enabled: true, threshold: 3, baseSeconds: 20, maxSeconds: 120 };

  let opts = { ...DEFAULTS };
  try {
    const saved = await magpie.options.get();
    opts = { ...DEFAULTS, ...(typeof saved === "object" && saved ? saved : {}) };
  } catch {}

  const paint = () => {
    els.enabled.checked = opts.enabled !== false;
    els.threshold.value = opts.threshold;
    els.base.value = opts.baseSeconds;
    els.max.value = opts.maxSeconds;
  };
  paint();

  button.onclick = async () => {
    button.disabled = true;
    result.textContent = "";
    try {
      const next = {
        enabled: els.enabled.checked,
        threshold: Number(els.threshold.value),
        baseSeconds: Number(els.base.value),
        maxSeconds: Number(els.max.value),
      };
      opts = await magpie.options.set(next);
      result.textContent = "已保存，下一个请求起生效。";
    } catch (e) {
      result.textContent = "没能保存：" + (e?.message ?? e);
    }
    button.disabled = false;
  };
})();
