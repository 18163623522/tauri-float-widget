// OBS 悬浮控制条 —— 直连 OBS 31 内置的 obs-websocket 5.x（JSON 协议）
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow, LogicalSize, PhysicalPosition } = window.__TAURI__.window;

const dot = document.getElementById("dot");
const label = document.getElementById("label");
const btnRec = document.getElementById("btn-rec");
const btnPause = document.getElementById("btn-pause");
const btnGear = document.getElementById("btn-gear");
const btnClose = document.getElementById("btn-close");
const panel = document.getElementById("panel");
const panelMsg = document.getElementById("panel-msg");
const panelHint = document.getElementById("panel-hint");
const dirText = document.getElementById("dir-text");
const btnOpenDir = document.getElementById("btn-open-dir");
const btnPickDir = document.getElementById("btn-pick-dir");
const inVbitrate = document.getElementById("in-vbitrate");
const inAbitrate = document.getElementById("in-abitrate");
const toast = document.getElementById("toast");
const toastText = document.getElementById("toast-text");
const toastOpen = document.getElementById("toast-open");
const btnWinRefresh = document.getElementById("btn-win-refresh");
const btnPlay = document.getElementById("btn-play");
const stBitrate = document.getElementById("st-bitrate");
const stFps = document.getElementById("st-fps");
const stCpu = document.getElementById("st-cpu");
const stMem = document.getElementById("st-mem");
const stGpu = document.getElementById("st-gpu");

const win = getCurrentWindow();
const BAR_H = 86, PANEL_H = 532; // 逻辑像素：主界面(60条+26信息条) / 展开后整窗高度
const WINCAP_NAME = "悬浮条·窗口采集"; // 场景中自动创建/复用的 window_capture 源名

const ICON = {
  rec: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="#ff453a"/></svg>`,
  stop: `<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="#fff"/></svg>`,
  pause: `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>`,
  resume: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.2v9.6l8.2-4.8z"/></svg>`,
  play: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.2v9.6l8.2-4.8z"/></svg>`,
  gear: `<svg class="gear-ic" viewBox="0 0 16 16" fill="none"><path d="M6.6 1.8h2.8l.4 1.7c.4.15.75.35 1.1.6l1.6-.7 1.4 2.4-1.3 1.2c.03.23.05.46.05.7s-.02.47-.05.7l1.3 1.2-1.4 2.4-1.6-.7c-.35.25-.7.45-1.1.6l-.4 1.7H6.6l-.4-1.7a4.9 4.9 0 0 1-1.1-.6l-1.6.7-1.4-2.4 1.3-1.2a5.3 5.3 0 0 1 0-1.4L2.1 5.8l1.4-2.4 1.6.7c.35-.25.72-.45 1.1-.6l.4-1.7Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.2"/></svg>`,
};

let cfg = null;
let ws = null;
let reqId = 0;
const pending = new Map();
let connState = "connecting"; // connecting | offline | online
let recState = "idle"; // idle | recording | paused
let recStartMs = 0; // Date.now() 对应录像时间码 0 点的时刻
let lastOutputPath = ""; // 最近一次录像路径（来自事件，StopRecord 响应可能不带）
let toastTimer = null;

// ---- 面板/场景/统计状态 ----
let panelOpen = false;
let savedY = null; // 面板展开时若发生上移，记原 y 供收起还原
let curDir = "";
let suppressSave = false; // 程序回填下拉值时不触发保存
let sceneName = "";
let monitorItemId = null; // 显示器采集源 id（无则不可切窗口）
let windowItemId = null; // 窗口采集源 id
let statsTimer = null;
let gpuTick = 0;
let sizeSamples = []; // 录像文件大小采样（算滑动码率）
let loadingWindows = false;
let winHoverTimer = null; // 窗口下拉项 hover 去抖

btnGear.innerHTML = ICON.gear;
btnPlay.innerHTML = ICON.play;

// ---- 自定义下拉组件（毛玻璃浮层、向上弹出、可选 hover 回调） ----

function makeDropdown(root, { placeholder = "请选择", onSelect }) {
  const btn = document.createElement("button");
  btn.className = "dd-btn";
  btn.type = "button";
  btn.innerHTML = `<span class="dd-val"></span><svg class="dd-caret" viewBox="0 0 12 12"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const list = document.createElement("div");
  list.className = "dd-list";
  root.append(btn);
  document.body.appendChild(list); // 挂 body 级：面板/外壳的 overflow:hidden 会裁剪内部浮层
  let items = [];
  let value = null;
  let open = false;

  function renderList() {
    list.innerHTML = "";
    for (const it of items) {
      if (it.group) {
        const g = document.createElement("div");
        g.className = "dd-group";
        g.textContent = it.group;
        list.appendChild(g);
        continue;
      }
      const el = document.createElement("div");
      el.className = "dd-item" + (it.value === value ? " cur" : "");
      el.textContent = it.label;
      el.title = it.label;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        setValue(it.value, true);
        close();
      });
      if (it.onHover) {
        el.addEventListener("mouseenter", it.onHover);
        el.addEventListener("mouseleave", it.onLeave || (() => {}));
      }
      list.appendChild(el);
    }
  }
  function setValue(v, fire) {
    value = v;
    const it = items.find((i) => i.value === v);
    btn.querySelector(".dd-val").textContent = it ? it.label : placeholder;
    renderList();
    if (fire && onSelect && !suppressSave) onSelect(v);
  }
  function setItems(newItems, keepValue = true) {
    items = newItems;
    if (!keepValue || !items.some((i) => i.value === value)) value = null;
    renderList();
    setValue(value, false);
  }
  function close() {
    open = false;
    root.classList.remove("open");
    list.style.display = "none";
    if (winHoverTimer) { clearTimeout(winHoverTimer); winHoverTimer = null; }
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllDropdowns(api);
    open = !open;
    if (open) {
      // fixed 定位贴到按钮下方；下方空间不足则向上弹（bottom 贴按钮顶，无需预知列表高度）
      const r = btn.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 10;
      const above = r.top - 40;
      list.style.left = r.left + "px";
      list.style.width = r.width + "px";
      if (below >= 120) {
        list.style.top = (r.bottom + 6) + "px";
        list.style.bottom = "auto";
        list.style.maxHeight = Math.min(216, below) + "px";
      } else {
        list.style.top = "auto";
        list.style.bottom = (window.innerHeight - r.top + 6) + "px";
        list.style.maxHeight = Math.max(100, Math.min(216, above)) + "px";
      }
      list.style.display = "block";
      list.classList.remove("anim-in");
      void list.offsetWidth; // 重启入场动画
      list.classList.add("anim-in");
    }
    root.classList.toggle("open", open);
  });
  const api = {
    setValue,
    setItems,
    get value() { return value; },
    get open() { return open; },
    close,
    setDisabled(d) { btn.classList.toggle("disabled", d); },
  };
  allDropdowns.push(api);
  return api;
}

// 全局下拉注册表：统一关闭（浮层在 body 级，必须显式隐藏）
const allDropdowns = [];
function closeAllDropdowns(except) {
  allDropdowns.forEach((d) => { if (d !== except) d.close(); });
}
window.addEventListener("resize", () => closeAllDropdowns());
document.addEventListener("click", () => closeAllDropdowns());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllDropdowns();
});

// 窗口下拉：悬停项 250ms 后目标窗口亮红框
function windowItemHover(entry) {
  return () => {
    if (winHoverTimer) clearTimeout(winHoverTimer);
    winHoverTimer = setTimeout(() => {
      invoke("flash_window", { hwnd: entry.hwnd }).catch(() => {});
    }, 250);
  };
}
function windowItemLeave() {
  return () => { if (winHoverTimer) { clearTimeout(winHoverTimer); winHoverTimer = null; } };
}

const ddWindow = makeDropdown(document.getElementById("dd-window"), {
  placeholder: "请选择",
  onSelect: async (v) => {
    if (v === "__none") return;
    try {
      let itemId; // 当前激活的采集源（用于重置缩放）
      if (v.startsWith("__mon:")) {
        // 切到指定显示器：overlay 局部更新 monitor_id，不动其他设置
        await request("SetInputSettings", { inputName: monitorName, inputSettings: { monitor_id: v.slice(6) }, overlay: true });
        await request("SetSceneItemEnabled", { sceneName, sceneItemId: monitorItemId, sceneItemEnabled: true });
        if (windowItemId !== null) {
          await request("SetSceneItemEnabled", { sceneName, sceneItemId: windowItemId, sceneItemEnabled: false });
        }
        itemId = monitorItemId;
      } else {
        await request("SetInputSettings", { inputName: WINCAP_NAME, inputSettings: { window: v }, overlay: true });
        await request("SetSceneItemEnabled", { sceneName, sceneItemId: windowItemId, sceneItemEnabled: true });
        if (monitorItemId !== null) {
          await request("SetSceneItemEnabled", { sceneName, sceneItemId: monitorItemId, sceneItemEnabled: false });
        }
        itemId = windowItemId;
      }
      // 画布/输出分辨率同步为目标分辨率（防拉伸错配：4K 画布配 1440p 屏会录成假 4K）
      const dim = targetDims[v] || targetDims["__mon:" + String(v).slice(6)];
      if (dim && dim.width > 0 && dim.height > 0) {
        await request("SetVideoSettings", {
          baseWidth: dim.width, baseHeight: dim.height,
          outputWidth: dim.width, outputHeight: dim.height,
        });
        // 源缩放重置为 1:1，正好铺满新画布
        if (itemId != null) {
          await request("SetSceneItemTransform", {
            sceneName, sceneItemId: itemId,
            sceneItemTransform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1 },
          });
        }
        flash(`已切换 · ${dim.width}×${dim.height}`);
      } else {
        flash("已切换");
      }
    } catch (e) { flash(e?.message || "切换失败"); }
  },
});

// value → 目标分辨率（显示器与窗口共用）
const targetDims = {};

const ddFormat = makeDropdown(document.getElementById("dd-format"), {
  placeholder: "格式",
  onSelect: async (v) => {
    try {
      await request("SetProfileParameter", { parameterCategory: "SimpleOutput", parameterName: "RecFormat2", parameterValue: v });
      flash("已保存");
    } catch (e) { flash(e?.message || "保存失败"); }
  },
});

const ddEncoder = makeDropdown(document.getElementById("dd-encoder"), {
  placeholder: "编码器",
  onSelect: async (v) => {
    try {
      await request("SetProfileParameter", { parameterCategory: "SimpleOutput", parameterName: "RecEncoder", parameterValue: v });
      flash("已保存");
    } catch (e) { flash(e?.message || "保存失败"); }
  },
});

const ddFps = makeDropdown(document.getElementById("dd-fps"), {
  placeholder: "帧率",
  onSelect: async (v) => {
    try {
      await request("SetProfileParameter", { parameterCategory: "Video", parameterName: "FPSCommon", parameterValue: v });
      flash("已保存");
    } catch (e) { flash(e?.message || "保存失败"); }
  },
});

async function sha256b64(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function parseTimecode(tc) {
  const m = /^(\d+):(\d+):(\d+)/.exec(String(tc || ""));
  if (!m) return 0;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000;
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function render() {
  dot.className = "";
  if (connState === "offline") { dot.classList.add("off"); label.textContent = "未连接 OBS"; }
  else if (connState === "connecting") { dot.classList.add("warn"); label.textContent = "连接 OBS…"; }
  else if (recState === "idle") { dot.classList.add("ok"); label.textContent = "待机"; }
  else if (recState === "recording") { dot.classList.add("rec"); label.textContent = `REC · ${fmt(Date.now() - recStartMs)}`; }
  else if (recState === "paused") { dot.classList.add("paused"); label.textContent = `已暂停 · ${fmt(Date.now() - recStartMs)}`; }

  const busy = recState === "recording" || recState === "paused";
  btnRec.classList.toggle("on", busy); // 圆点 ↔ 方块 图标动画切换
  btnPause.classList.toggle("on", recState === "paused"); // 暂停 ↔ 恢复
  btnPause.disabled = !busy;
}

setInterval(() => {
  if (connState === "online" && recState === "recording") render();
}, 250);

// ---- obs-websocket 连接 ----

function connect() {
  if (!cfg || !cfg.enabled) { connState = "offline"; render(); return setTimeout(connect, 4000); }
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  connState = "connecting";
  render();
  try {
    ws = new WebSocket(`ws://127.0.0.1:${cfg.port}`);
  } catch {
    return setTimeout(connect, 4000);
  }
  ws.onmessage = (ev) => onMessage(ev).catch(() => {});
  ws.onclose = () => { connState = "offline"; recState = "idle"; render(); setTimeout(connect, 4000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

async function onMessage(ev) {
  const m = JSON.parse(ev.data);
  if (m.op === 0) {
    // Hello：认证串 = base64(sha256(base64(sha256(pw+salt)) + challenge))
    // 只订阅 General(1)+Outputs(64)，默认全订阅会有每秒 30+ 条音频电平洪流
    const d = { rpcVersion: 1, eventSubscriptions: 65 };
    if (m.d.authentication) {
      const secret = await sha256b64(cfg.password + m.d.authentication.salt);
      d.authentication = await sha256b64(secret + m.d.authentication.challenge);
    }
    send(1, d);
  } else if (m.op === 2) {
    // Identified：同步一次当前录制状态（悬浮条晚于录制启动时也能对齐）
    connState = "online";
    render();
    request("GetRecordStatus")
      .then((r) => {
        if (r.outputPaused) setRec("paused", r.outputTimecode);
        else if (r.outputActive) setRec("recording", r.outputTimecode);
        else setRec("idle");
      })
      .catch(() => {});
  } else if (m.op === 7) {
    const p = pending.get(m.d.requestId);
    if (!p) return;
    pending.delete(m.d.requestId);
    if (m.d.requestStatus?.result) p.resolve(m.d.responseData || {});
    else p.reject(new Error(m.d.requestStatus?.comment || `请求失败 (code ${m.d.requestStatus?.code})`));
  } else if (m.op === 5) {
    // Event（注意：OBS 31 的 obs-websocket 5.5.6 实测事件 op=5，而非协议文档常写的 4）
    handleEvent(m.d);
  }
}

function send(op, d) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, d }));
}

function request(requestType, requestData) {
  return new Promise((resolve, reject) => {
    const id = `r${++reqId}`;
    pending.set(id, { resolve, reject });
    send(6, { requestType, requestId: id, ...(requestData ? { requestData } : {}) });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${requestType} 超时`));
      }
    }, 8000);
  });
}

function setRec(state, timecode) {
  recState = state;
  if (state === "recording") recStartMs = Date.now() - parseTimecode(timecode);
  render();
}

function handleEvent(d) {
  if (d.eventType !== "RecordStateChanged") return;
  const e = d.eventData || {};
  const s = String(e.outputState || "");
  if (e.outputPath) lastOutputPath = e.outputPath; // STARTED/STOPPED 事件带完整录像路径
  if (s.endsWith("PAUSED")) setRec("paused", e.outputTimecode);
  else if (s.endsWith("RESUMED")) setRec("recording", e.outputTimecode);
  else if (s.endsWith("STARTED")) setRec("recording", e.outputTimecode);
  else if (s.endsWith("STOPPING") || s.endsWith("STOPPED")) setRec("idle");
}

function showToast(savedPath) {
  const name = String(savedPath || "").split(/[\\/]/).pop() || "录像";
  toastText.textContent = `已保存：${name}`;
  toastText.title = savedPath || "";
  toastOpen.onclick = () => invoke("reveal_saved", { path: savedPath }).catch(() => {});
  toastOpen.style.display = "";
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 8000);
}

function showToastError(e) {
  toastText.textContent = e?.message || String(e);
  toastOpen.style.display = "none";
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    toastOpen.style.display = "";
  }, 4000);
}

// ---- 录制控制 ----

btnRec.addEventListener("click", () => {
  const stop = recState === "recording" || recState === "paused";
  (stop ? request("StopRecord") : request("StartRecord"))
    .then((r) => { if (stop && (r.outputPath || lastOutputPath)) showToast(r.outputPath || lastOutputPath); })
    .catch(showToastError);
});

btnPause.addEventListener("click", () => {
  request("ToggleRecordPause").catch(showToastError);
});

// 播放最近一次录像（本会话事件记录优先，其次扫录像目录最新文件）
btnPlay.addEventListener("click", async () => {
  try {
    let target = lastOutputPath;
    if (!target && curDir) target = await invoke("latest_video", { dir: curDir });
    if (!target) {
      const r = await request("GetRecordDirectory");
      curDir = r.recordDirectory || "";
      if (curDir) target = await invoke("latest_video", { dir: curDir });
    }
    if (!target) return showToastError(new Error("还没有录像文件"));
    await invoke("open_folder", { path: target }); // open_path 对文件 = 系统默认播放器
  } catch (e) {
    showToastError(e);
  }
});

btnClose.addEventListener("click", () => win.close());

// ---- 设置面板 ----

function flash(msg) {
  panelMsg.textContent = msg;
  setTimeout(() => { if (panelMsg.textContent === msg) panelMsg.textContent = ""; }, 2500);
}

async function togglePanel(force) {
  panelOpen = force !== undefined ? force : !panelOpen;
  if (panelOpen) {
    await win.setSize(new LogicalSize(430, PANEL_H));
    requestAnimationFrame(() => panel.classList.add("show"));
    // 贴近屏幕底部时上移窗口，避免面板出屏
    try {
      const scale = await win.scaleFactor();
      const pos = await win.outerPosition();
      const mon = await win.currentMonitor();
      if (mon) {
        const monBottom = mon.position.y + mon.size.height;
        const needH = Math.round(PANEL_H * scale);
        if (pos.y + needH > monBottom) {
          savedY = pos.y;
          await win.setPosition(new PhysicalPosition(pos.x, Math.max(mon.position.y, monBottom - needH)));
        }
      }
    } catch {}
    loadSettings();
    loadWindows();
  } else {
    panel.classList.remove("show");
    closeAllDropdowns();
    setTimeout(async () => {
      await win.setSize(new LogicalSize(430, BAR_H));
      if (savedY !== null) {
        try {
          const pos = await win.outerPosition();
          await win.setPosition(new PhysicalPosition(pos.x, savedY));
        } catch {}
        savedY = null;
      }
    }, 300); // 等面板收起动画完成再缩窗
  }
}

btnGear.addEventListener("click", () => togglePanel());

async function loadSettings() {
  dirText.textContent = "读取中…";
  dirText.title = "";
  try {
    const r = await request("GetRecordDirectory");
    curDir = r.recordDirectory || "";
    dirText.textContent = curDir || "(未设置)";
    dirText.title = curDir;
  } catch {
    dirText.textContent = "读取失败";
  }
  // 格式/码率/编码器仅支持 Simple 输出模式
  let simple = true;
  try {
    const mode = await request("GetProfileParameter", { parameterCategory: "Output", parameterName: "Mode" });
    simple = mode.parameterValue !== "Advanced";
  } catch {}
  ddFormat.setDisabled(!simple);
  ddEncoder.setDisabled(!simple);
  inVbitrate.disabled = inAbitrate.disabled = !simple;
  panelHint.textContent = simple
    ? "格式与码率在下次开始录制时生效"
    : "当前 OBS 为高级输出模式：文件夹与窗口可直接用，格式与码率请在 OBS 设置中修改";
  panelHint.classList.toggle("err", !simple);
  if (!simple) return;
  const FMT_LABELS = { mkv: "MKV（损坏可恢复，推荐）", mp4: "MP4（兼容性最好）", hybrid_mp4: "混合 MP4（MP4 + 可恢复）", fmp4: "碎片化 MP4", mov: "MOV" };
  const ENC_LABELS = { nvenc: "NVIDIA NVENC（GPU 硬编，推荐）", x264: "软件 x264（CPU 编码）", qsv: "Intel 快速同步 (QSV)", amd: "AMD AMF" };
  try {
    const fmt = await request("GetProfileParameter", { parameterCategory: "SimpleOutput", parameterName: "RecFormat2" });
    const v = fmt.parameterValue || "mkv";
    ddFormat.setItems([{ value: v, label: FMT_LABELS[v] || v },
      ...Object.entries(FMT_LABELS).filter(([k]) => k !== v).map(([value, label]) => ({ value, label }))]);
    ddFormat.setValue(v, false);
  } catch {}
  try {
    const enc = await request("GetProfileParameter", { parameterCategory: "SimpleOutput", parameterName: "RecEncoder" });
    const v = enc.parameterValue || "nvenc";
    ddEncoder.setItems([{ value: v, label: ENC_LABELS[v] || v },
      ...Object.entries(ENC_LABELS).filter(([k]) => k !== v).map(([value, label]) => ({ value, label }))]);
    ddEncoder.setValue(v, false);
  } catch {}
  try {
    const vb = await request("GetProfileParameter", { parameterCategory: "SimpleOutput", parameterName: "VBitrate" });
    if (vb.parameterValue) inVbitrate.value = vb.parameterValue;
  } catch {}
  try {
    const ab = await request("GetProfileParameter", { parameterCategory: "SimpleOutput", parameterName: "ABitrate" });
    if (ab.parameterValue) inAbitrate.value = ab.parameterValue;
  } catch {}
  // 录制帧率（Video 段 FPSCommon；FPSType=0 才是常用值模式）
  try {
    const ftype = await request("GetProfileParameter", { parameterCategory: "Video", parameterName: "FPSType" });
    if (ftype.parameterValue === "0") {
      ddFps.setDisabled(false);
      const fps = await request("GetProfileParameter", { parameterCategory: "Video", parameterName: "FPSCommon" });
      const cur = fps.parameterValue || "60";
      const PRESETS = ["10", "15", "20", "24", "25", "29.97", "30", "48", "50", "59.94", "60"];
      const vals = PRESETS.includes(cur) ? PRESETS : [cur, ...PRESETS];
      ddFps.setItems(vals.map((v) => ({ value: v, label: `${v} fps` })));
      ddFps.setValue(cur, false);
    } else {
      ddFps.setDisabled(true);
      ddFps.setItems([]);
      ddFps.setValue(null, false);
    }
  } catch {}
}

btnOpenDir.addEventListener("click", () => {
  if (curDir) invoke("open_folder", { path: curDir }).catch((e) => flash(e?.message || "打开失败"));
});

btnPickDir.addEventListener("click", async () => {
  try {
    const picked = await invoke("pick_folder");
    if (!picked) return; // 用户取消
    await request("SetRecordDirectory", { recordDirectory: picked });
    curDir = picked;
    dirText.textContent = curDir;
    dirText.title = curDir;
    flash("已更新");
  } catch (e) {
    flash(e?.message || "更改失败");
  }
});

async function saveBitrate(input, name) {
  const v = parseInt(input.value, 10);
  if (!Number.isFinite(v) || v <= 0) return flash("请输入有效码率");
  try {
    await request("SetProfileParameter", { parameterCategory: "SimpleOutput", parameterName: name, parameterValue: String(v) });
    flash("已保存");
  } catch (e) {
    flash(e?.message || "保存失败");
  }
}

inVbitrate.addEventListener("change", () => saveBitrate(inVbitrate, "VBitrate"));
inAbitrate.addEventListener("change", () => saveBitrate(inAbitrate, "ABitrate"));

// ---- 录制窗口切换 ----

let monitorName = ""; // 显示器采集源名

async function loadSceneInfo() {
  try {
    const sl = await request("GetSceneList");
    sceneName = sl.currentProgramSceneName || "";
    const il = await request("GetSceneItemList", { sceneName });
    const items = il.sceneItems || [];
    let mon = items.find((i) => i.inputKind === "monitor_capture");
    if (!mon) {
      // 没有显示器采集源：创建一个隐藏的（用枚举的第一台显示器）
      let firstId = "";
      try {
        const ds = await invoke("list_displays");
        firstId = ds[0]?.monitor_id || "";
      } catch {}
      const created = await request("CreateInput", {
        sceneName, inputName: "悬浮条·显示器采集", inputKind: "monitor_capture",
        inputSettings: firstId ? { monitor_id: firstId } : {}, sceneItemEnabled: false,
      });
      mon = { sourceName: "悬浮条·显示器采集", sceneItemId: created.sceneItemId, sceneItemEnabled: false };
    }
    monitorName = mon.sourceName;
    monitorItemId = mon.sceneItemId;
    let wcap = items.find((i) => i.inputKind === "window_capture");
    if (!wcap) {
      // 场景里还没有窗口采集源：创建一个隐藏的，切换时才显示
      const created = await request("CreateInput", {
        sceneName, inputName: WINCAP_NAME, inputKind: "window_capture",
        inputSettings: {}, sceneItemEnabled: false,
      });
      wcap = { sceneItemId: created.sceneItemId, sceneItemEnabled: false };
    }
    windowItemId = wcap.sceneItemId;
    // 回填下拉当前选择：显示器项用 monitor_id 匹配，窗口项用 window 串匹配
    if (mon.sceneItemEnabled || !wcap.sceneItemEnabled) {
      const s = await request("GetInputSettings", { inputName: monitorName });
      const mid = s.inputSettings?.monitor_id || "";
      return mid ? "__mon:" + mid : "__none";
    }
    const s = await request("GetInputSettings", { inputName: WINCAP_NAME });
    return s.inputSettings?.window || "__none";
  } catch {
    return "__none";
  }
}

async function loadWindows() {
  if (loadingWindows) return;
  loadingWindows = true;
  btnWinRefresh.textContent = "刷新中…";
  try {
    const [cur, displays, entries] = await Promise.all([
      loadSceneInfo(),
      invoke("list_displays"),
      invoke("list_windows"),
    ]);
    const items = [{ group: "显示器" }];
    for (const d of displays) {
      items.push({ value: "__mon:" + d.monitor_id, label: d.label, title: d.label });
      targetDims["__mon:" + d.monitor_id] = { width: d.width, height: d.height };
    }
    items.push({ group: "应用窗口" });
    for (const w of entries) {
      items.push({
        value: w.obs_window, label: w.label, hwnd: w.hwnd,
        onHover: windowItemHover(w), onLeave: windowItemLeave(),
      });
      targetDims[w.obs_window] = { width: w.width, height: w.height };
    }
    ddWindow.setItems(items);
    suppressSave = true;
    ddWindow.setValue(items.some((i) => i.value === cur) ? cur : "__none", false);
    suppressSave = false;
  } catch {}
  btnWinRefresh.textContent = "刷新列表";
  loadingWindows = false;
}

btnWinRefresh.addEventListener("click", loadWindows);

// ---- 实时统计（常驻信息条，启动即轮询） ----

function startStats() {
  if (statsTimer) return;
  statsTimer = setInterval(tickStats, 1000);
  tickStats();
}

function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  gpuTick = 0;
  sizeSamples = [];
  [stBitrate, stFps, stCpu, stMem, stGpu].forEach((el) => (el.textContent = "—"));
}

async function tickStats() {
  if (connState !== "online") return;
  // OBS 进程统计
  try {
    const s = await request("GetStats");
    stCpu.textContent = s.cpuUsage.toFixed(1) + "%";
    stMem.textContent = Math.round(s.memoryUsage) + " MB";
    const drop = s.outputTotalFrames > 0 ? (s.outputSkippedFrames / s.outputTotalFrames) * 100 : 0;
    stFps.textContent = drop >= 1
      ? `${s.activeFps.toFixed(0)} ⚠${drop.toFixed(1)}%`
      : s.activeFps.toFixed(0);
  } catch {}
  // GPU（整机 + NVENC 编码器），2 秒一次
  if (++gpuTick % 2 === 0) {
    try {
      const g = await invoke("gpu_stats");
      stGpu.textContent = g ? `${g.gpu}%/编${g.enc}` : "不可用";
    } catch { stGpu.textContent = "不可用"; }
  }
  // 码率（按录像文件增速，3 个采样点滑动窗口）；时长已由主条 REC 计时显示
  if (recState === "recording") {
    if (lastOutputPath) {
      try {
        const size = await invoke("rec_file_size", { path: lastOutputPath });
        if (size != null) {
          sizeSamples.push({ t: Date.now(), size });
          while (sizeSamples.length > 3) sizeSamples.shift();
          if (sizeSamples.length >= 2) {
            const a = sizeSamples[0], b = sizeSamples[sizeSamples.length - 1];
            const kbps = Math.round(((b.size - a.size) * 8) / Math.max(1, b.t - a.t) / 1000);
            stBitrate.textContent = kbps.toLocaleString() + " kbps";
          }
        }
      } catch {}
    }
  } else {
    stBitrate.textContent = "—";
    sizeSamples = [];
  }
}

// ---- 启动 ----

render();
startStats(); // 信息条常驻统计
invoke("get_obs_config")
  .then((c) => { cfg = c; connect(); })
  .catch(() => { connState = "offline"; render(); });
