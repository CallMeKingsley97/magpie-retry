// Settings → Plugins 标签里的面板：提供一键导入。
// 面板跑在沙箱 iframe 里，不能联网、不能直接调插件——它把「导入」这个意愿
// 写进插件自己的 options，插件进程（input 的第二个参数）看到后执行。
// 插件没有往回写的通道，所以这里只能如实说「在后台进行」，不能假装有进度。
(async () => {
  await magpie.ready;

  const result = document.getElementById("result");
  const button = document.getElementById("import");

  let opts = await magpie.options.get();
  let busy = false;

  const paint = () => {
    button.disabled = busy;
    button.textContent = busy ? "导入中…" : "一键导入全部站点";
  };
  paint();

  button.onclick = async () => {
    if (busy) return;
    busy = true;
    paint();
    result.hidden = true;
    try {
      opts = await magpie.options.set({ ...opts, importRequested: Date.now() });
      result.hidden = false;
      result.textContent =
        "导入在后台进行，一般几十秒内完成（站点多会久一点）。这条提示不用等——" +
        "完成后到 Settings → Usage 就能看到各站点的额度卡片。";
    } catch (e) {
      result.hidden = false;
      result.textContent = "没能发起导入：" + (e?.message ?? e);
    }
    busy = false;
    paint();
  };
})();
