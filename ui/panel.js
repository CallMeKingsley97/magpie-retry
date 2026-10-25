// Settings → Plugins 标签里的面板：显示已导入/待导入的数量，提供一键导入。
// 面板跑在沙箱 iframe 里，不能联网、不能直接调插件——它把「导入」这个意愿
// 写进插件自己的 options，插件进程（input 的第二个参数）看到后执行。
(async () => {
  await magpie.ready;

  const summary = document.getElementById("summary");
  const result = document.getElementById("result");
  const button = document.getElementById("import");

  let opts = await magpie.options.get();
  let busy = false;

  const paint = () => {
    const done = Number(opts.importedAt ?? 0);
    const failed = String(opts.importError ?? "");
    if (failed) {
      summary.textContent = "上次导入没有完成：" + failed;
    } else if (done) {
      summary.textContent = "上次导入：" + new Date(done).toLocaleString();
    } else {
      summary.textContent = "还没有导入过。";
    }
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
      result.textContent = "已开始导入。站点较多时需要一会儿，导完后 Usage 里就能看到各站点的额度。";
    } catch (e) {
      result.hidden = false;
      result.textContent = "没能发起导入：" + (e?.message ?? e);
    }
    busy = false;
    paint();
  };
})();
