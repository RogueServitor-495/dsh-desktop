/* DSH Runtime Manager — control-panel frontend (no build step). */
const invoke = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core.invoke : null;
const listen = window.__TAURI__ && window.__TAURI__.event ? window.__TAURI__.event.listen : null;

const $ = (id) => document.getElementById(id);

let lastSeq = 0;
let busy = false;
let snapshot = null;
let rtInfo = null;

const PHASE_LABEL = {
  stopped: "已停止",
  starting: "启动中…",
  running: "运行中",
  stopping: "停止中…",
};

function phaseDot(phase) {
  if (phase === "running") return "running";
  if (phase === "starting" || phase === "stopping") return "starting";
  if (phase === "stopped") return "stopped";
  return "exited";
}

function toast(msg, ok) {
  const t = $("toast");
  t.textContent = msg;
  t.style.color = ok ? "var(--green)" : "var(--red)";
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.textContent = ""), 4200);
}

function setBusy(b) {
  busy = b;
  ["btnStart", "btnStop", "btnRestart", "btnSave", "btnOpenGui", "btnAddPlugin"].forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle("busy", b);
  });
}

async function call(fn, args) {
  setBusy(true);
  try {
    return await invoke(fn, args || {});
  } catch (e) {
    toast(String(e), false);
    throw e;
  } finally {
    setBusy(false);
  }
}

function fmtUptime(secs) {
  if (secs == null) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? h + "h" + m + "m" : m > 0 ? m + "m" + s + "s" : s + "s";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── tabs ────────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".tab-page").forEach((p) => {
    p.classList.toggle("active", p.id === "tab-" + name);
  });
}

// ── overview / status ───────────────────────────────────────────────────────
function renderStatus(s) {
  const phase = s.phase;
  const label = PHASE_LABEL[phase] || phase;

  $("statusDot").className = "dot " + phaseDot(phase);
  $("statusText").textContent = label;
  let meta = [];
  if (s.running) {
    meta.push("pid " + s.pid, ":" + s.port);
    if (s.uptimeSecs != null) meta.push(fmtUptime(s.uptimeSecs));
    if (!s.ready) meta.push("等待端口…");
  } else if (s.lastExit != null && s.lastExit !== 0) {
    meta.push("上次退出码 " + s.lastExit);
  }
  $("statusMeta").textContent = meta.join(" · ");

  $("heroDot").className = "hero-dot " + phaseDot(phase);
  $("heroTitle").textContent = label + (s.running ? " · http://127.0.0.1:" + s.port : "");
  $("heroSub").textContent = s.running
    ? "pid " + s.pid +
      (s.uptimeSecs != null ? " · 已运行 " + fmtUptime(s.uptimeSecs) : "") +
      (s.ready ? " · 端口就绪" : " · 等待端口就绪…")
    : s.lastExit != null && s.lastExit !== 0
    ? "上次退出码 " + s.lastExit
    : "点击「启动」开始运行时";

  $("ovPhase").textContent = label;
  $("ovPid").textContent = s.pid != null ? s.pid : "—";
  $("ovUptime").textContent = s.uptimeSecs != null ? fmtUptime(s.uptimeSecs) : "—";
  $("ovPort").textContent = s.port;
  $("ovExit").textContent = s.lastExit != null ? s.lastExit : "—";

  const lf = $("logFile");
  if (lf) lf.textContent = s.logFile ? "· " + s.logFile : "";

  $("btnStart").disabled = busy || s.running;
  $("btnStop").disabled = busy || !s.running;
  $("btnRestart").disabled = busy || !s.running;
  $("btnOpenGui").disabled = busy || !s.running;

  $("footInfo").textContent = s.ready
    ? "界面地址: " + s.guiUrl
    : s.running
    ? "运行时启动中，等待端口就绪…"
    : "运行时未启动 — 前往「总览」点击启动";
}

function renderOverviewEnv() {
  if (!snapshot) return;
  $("ovWorkspace").textContent = snapshot.settings.workspace || "—";
  if (!rtInfo) return;
  $("ovDshVersion").textContent = rtInfo.dshVersion;
  $("ovNodeVersion").textContent = rtInfo.nodeVersion;
  $("ovProfile").textContent = rtInfo.profile;
}

// ── settings / launch args ──────────────────────────────────────────────────
function renderSettings(s, settings) {
  const active = document.activeElement;
  const setInput = (id, val) => {
    const el = $(id);
    if (el && active !== el) el.value = val;
  };
  setInput("port", settings.port);
  setInput("host", settings.host || "127.0.0.1");
  setInput("trustedHosts", settings.trustedHosts || "");
  setInput("extraArgs", settings.extraArgs || "");
  setInput("workspace", settings.workspace);
  setInput("profile", settings.profile || "web");
  setInput("dshBin", settings.dshBin || "");
  setInput("nodePath", settings.nodePath || "");

  const badge = s.bundled ? "（内置运行时）" : "";
  $("dshResolved").textContent = "已解析: " + s.dsh + badge;
  $("nodeResolved").textContent = "已解析: " + s.node + badge;
  const bundleEl = $("ovBundle");
  if (bundleEl) {
    bundleEl.style.display = s.bundleInfo ? "" : "none";
    bundleEl.textContent = s.bundleInfo || "—";
  }

  const ael = document.activeElement;
  if (ael !== $("startOnLaunch")) $("startOnLaunch").checked = settings.startOnLaunch;
  if (ael !== $("autostart")) $("autostart").checked = s.autostartEnabled;

  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.classList.toggle("active", String(b.dataset.mode) === String(settings.guiInApp));
  });
}

function collectSettings() {
  const seg = document.querySelector(".seg-btn.active");
  return {
    port: parseInt($("port").value, 10) || 3080,
    host: $("host").value.trim() || "127.0.0.1",
    trustedHosts: $("trustedHosts").value.trim(),
    extraArgs: $("extraArgs").value.trim(),
    workspace: $("workspace").value.trim(),
    profile: $("profile").value.trim() || "web",
    nodePath: $("nodePath").value.trim() || null,
    dshBin: $("dshBin").value.trim() || null,
    startOnLaunch: $("startOnLaunch").checked,
    guiInApp: seg ? seg.dataset.mode === "true" : true,
  };
}

function q(s) {
  return s.includes(" ") || s.includes("'") ? "'" + s + "'" : s;
}

function renderCmdPreview() {
  if (!snapshot) return;
  const settings = collectSettings();
  const node = snapshot.node;
  const dsh = snapshot.dsh;
  const parts = [dsh, "--profile", settings.profile];
  if (settings.host) parts.push("--host", settings.host);
  if (rtInfo && rtInfo.overlay && rtInfo.overlayPath) {
    parts.push("--patch", rtInfo.overlayPath);
  }
  parts.push("--port", String(settings.port));
  settings.trustedHosts.split(/[,\s]+/).filter(Boolean).forEach((h) => parts.push("--trusted-host", h));
  settings.extraArgs.split(/\s+/).filter(Boolean).forEach((a) => parts.push(a));
  $("cmdPreview").textContent = [node].concat(parts).map(q).join(" ");
}

// ── plugins ─────────────────────────────────────────────────────────────────
function renderRuntimeInfo(info, plugins) {
  const enabled = plugins.filter((p) => p.enabled).length;
  $("runtimeInfo").innerHTML =
    "dsh <b>" + escapeHtml(info.dshVersion) + "</b> · node <b>" + escapeHtml(info.nodeVersion) +
    "</b> · profile <b>" + escapeHtml(info.profile) + "</b> · 插件 <b>" + plugins.length +
    "</b>（启用 " + enabled + "）<br>覆盖层: " + escapeHtml(info.overlayPath);
}

function renderPlugins(plugins) {
  const list = $("pluginList");
  if (!plugins.length) {
    list.innerHTML = '<div class="plugin-empty">该 profile 还没有安装插件</div>';
    $("pluginSummary").textContent = "";
    return;
  }
  const enabled = plugins.filter((p) => p.enabled).length;
  $("pluginSummary").textContent = plugins.length + " 个 · 启用 " + enabled;
  list.innerHTML = "";
  for (const p of plugins) {
    const row = document.createElement("div");
    row.className = "plugin-row";
    const kindBadge =
      p.kind === "bundle"
        ? '<span class="badge bundle">层 bundle</span>'
        : p.enabled
        ? '<span class="badge on">已启用</span>'
        : '<span class="badge off">未启用</span>';
    row.innerHTML =
      '<div class="plugin-main">' +
      '<div class="plugin-name">' + escapeHtml(p.name) + ' <span class="plugin-ver">v' + escapeHtml(p.version) + "</span> " + kindBadge + "</div>" +
      '<div class="plugin-desc">' + escapeHtml(p.description || "—") + "</div>" +
      (p.source ? '<div class="plugin-src">来源: ' + escapeHtml(p.source) + "</div>" : "") +
      "</div>" +
      '<label class="switch" title="' + (p.kind === "bundle" ? "bundle 层插件：切换 dsh.profile.bundles" : "切换 patch 启用状态") + '">' +
      '<input type="checkbox" ' + (p.enabled ? "checked" : "") + " />" +
      '<span class="track"></span></label>' +
      '<button class="btn mini danger" data-remove="' + escapeHtml(p.name) + '">删除</button>';
    const toggle = row.querySelector('input[type="checkbox"]');
    toggle.addEventListener("change", async () => {
      try {
        await call("set_plugin_enabled", { name: p.name, enabled: toggle.checked });
        toast(p.kind === "bundle" ? "已切换 bundle 层（重启后生效）" : toggle.checked ? "已启用插件" : "已禁用插件", true);
        refreshPlugins();
      } catch (e) {
        toggle.checked = !toggle.checked;
      }
    });
    const rm = row.querySelector("[data-remove]");
    rm.addEventListener("click", async () => {
      if (!confirm("确定删除插件 " + p.name + " 吗？将从 profile 依赖与 patch 中移除")) return;
      try {
        await call("remove_plugin", { name: p.name });
        toast("已删除插件", true);
        refreshPlugins();
      } catch (e) {}
    });
    list.appendChild(row);
  }
}

async function refreshPlugins() {
  try {
    const plugins = await invoke("list_plugins");
    rtInfo = await invoke("get_runtime_info");
    renderRuntimeInfo(rtInfo, plugins);
    renderPlugins(plugins);
    renderOverviewEnv();
    renderCmdPreview();
    const ov = $("ovPlugins");
    if (ov) ov.textContent = plugins.length + " 个（启用 " + plugins.filter((p) => p.enabled).length + "）";
  } catch (e) {
    /* plugin section unavailable */
  }
}

// ── refresh loop ────────────────────────────────────────────────────────────
async function refresh() {
  try {
    snapshot = await invoke("get_snapshot");
  } catch (e) {
    return;
  }
  const s = snapshot;
  renderStatus(s.status);
  renderSettings(s, s.settings);
  renderCmdPreview();
  try {
    const page = await invoke("get_logs", { after: lastSeq });
    if (page.lines.length) {
      const box = $("logBox");
      const pinned = $("autoscroll").checked;
      // build the chunk first so we touch the DOM once (avoids O(n^2) reflow)
      let chunk = "";
      for (const l of page.lines) chunk += l.text + "\n";
      box.textContent += chunk;
      lastSeq = page.end;
      if (pinned) box.scrollTop = box.scrollHeight;
    }
  } catch (e) {}
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  if (!invoke) {
    // Not running inside the Tauri shell: nothing can work, show the reason
    // instead of a silent blank panel.
    document.body.innerHTML =
      '<div style="padding:28px;color:#ff5c5c;font:14px/1.6 sans-serif">' +
      "管理面板无法初始化：页面没有运行在 Tauri 窗口内（window.__TAURI__ 不可用）。</div>";
    return;
  }
  // tabs
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });

  if (listen) await listen("runtime-status", () => refresh());

  $("btnStart").onclick = async () => {
    try {
      await call("start_runtime");
      toast("启动指令已发出", true);
      refresh();
    } catch (e) {}
  };
  $("btnStop").onclick = async () => {
    if (!confirm("确定停止 DSH 运行时吗？")) return;
    try {
      await call("stop_runtime");
      toast("停止指令已发出（优雅退出）", true);
      refresh();
    } catch (e) {}
  };
  $("btnRestart").onclick = async () => {
    if (!confirm("确定重启 DSH 运行时吗？")) return;
    try {
      await call("restart_runtime");
      toast("重启指令已发出", true);
      refresh();
    } catch (e) {}
  };
  $("btnSave").onclick = async () => {
    try {
      await call("save_settings", { settings: collectSettings() });
      toast("设置已保存" + (snapshot && snapshot.status.running ? "（端口等变更将在重启后生效）" : ""), true);
      refresh();
      refreshPlugins();
    } catch (e) {}
  };
  $("btnOpenGui").onclick = async () => {
    try {
      await call("open_gui");
    } catch (e) {}
  };
  $("btnAddPlugin").onclick = async () => {
    const spec = $("pluginSpec").value.trim();
    if (!spec) {
      toast("请输入 npm 包名或 URL", false);
      return;
    }
    try {
      await call("add_plugin", { spec });
      toast("导入成功，运行时将自动重启以生效", true);
      $("pluginSpec").value = "";
      refreshPlugins();
    } catch (e) {}
  };
  $("btnClearLogs").onclick = async () => {
    try {
      lastSeq = await call("clear_logs");
      $("logBox").textContent = "";
      toast("日志显示已清空", true);
    } catch (e) {}
  };
  $("btnRevealLogs").onclick = async () => {
    try {
      await call("reveal_logs");
    } catch (e) {}
  };
  $("autostart").onchange = async (ev) => {
    try {
      await call("autostart_set", { enabled: ev.target.checked });
      toast(ev.target.checked ? "已开启开机自启" : "已关闭开机自启", true);
    } catch (e) {
      ev.target.checked = !ev.target.checked;
    }
  };
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      renderCmdPreview();
    };
  });
  // live command preview on input
  ["port", "host", "trustedHosts", "extraArgs", "workspace", "profile", "dshBin", "nodePath"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("input", renderCmdPreview);
  });

  setInterval(refresh, 1500);
  refresh();
  refreshPlugins();
}

boot();
