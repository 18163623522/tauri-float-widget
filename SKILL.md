---
name: tauri-float-widget
description: 用 Tauri 做桌面常驻悬浮工具条（置顶毛玻璃控制条/HUD/状态监视器）的设计规范与完整架构模板。悬浮条 + 齿轮展开设置面板 + 实时统计网格模式，含 Windows 侧全部踩坑。做任何"贴边小工具/悬浮控制条/常驻 HUD"时使用。
---

# Tauri 悬浮工具条（Float Widget）

参考实现：`D:\001_Archive\AI\obs-float-bar\`（OBS 录制悬浮控制条，完整可编译）。
技术栈：Tauri 2 + 原生 HTML/CSS/JS（无前端框架），Rust 侧只做系统能力桥接。

## 何时用

- 需要**常置顶**的迷你控制条：录屏/直播控制、音乐播放条、下载进度条、计时器
- 需要**实时统计 HUD**：CPU/GPU/码率/FPS 等格子化数据展示
- 小工具本体逻辑在某个本地服务（WebSocket/HTTP API）上，悬浮条只是壳

## UI 设计规范（实测好看的一套）

### 一体化外壳（关键：三层共享一个毛玻璃容器，视觉不可分割）
```html
<div id="shell">            <!-- inset:0，背景/圆角/毛玻璃/边框全在这层 -->
  <div id="bar">…</div>      <!-- 主条 60px：状态点+文字+按钮组 -->
  <div id="info-strip">…</div <!-- 信息条 26px：常驻统计，底色加深 rgba(0,0,0,.22) -->
  <div id="panel">…</div>    <!-- 设置面板：展开时出现，border-top 分隔 -->
</div>
```
- shell：`background: rgba(22,22,24,0.88)` + `backdrop-filter: blur(24px)` + 边框 `1px rgba(255,255,255,0.08)` + 圆角 16px + 阴影 + `overflow:hidden`（内层不用再画圆角）
- 信息条文字 11px 灰（.55）+ 数值白（.82）/600/tabular-nums，`·` 分隔符（.18 透明度）
- 面板区背景再加一档暗（rgba(0,0,0,.14)）+ border-top 细线，层次自然

### 主悬浮条（430×60）
```
│ ● REC · 00:14:32     ⏸ ⏹ ▶ ⚙ ✕ │
```
- 状态点语义：灰=离线 黄=连接中 绿=就绪 红闪烁=工作中(`50%{opacity:.25}`) 橙=暂停
- 状态文字 13px/600、tabular-nums（计时数字不跳动）
- 按钮：36px 圆形、透明底、hover `rgba(255,255,255,.09)`、active `transform: scale(0.92)`（按压反馈）
- 齿轮 hover 旋转：`svg.gear-ic { transition: transform .3s } .btn:hover svg.gear-ic { rotate(60deg) }`
- 整条 `data-tauri-drag-region` 可拖动；toast 弹在条上方 `bottom: calc(100% + 8px)`

### 动画
- 面板展开：窗口 setSize 瞬时完成（原生 resize 无法动画），内容用 **stagger 渐入**掩盖——每个 field 加 `.anim`，`opacity:0 + translateY(-6px)` → `field-in 0.22s ease-out forwards`，`animation-delay` 依次递增 25ms
- toast 同款 field-in 入场

### 自定义下拉（原生 select 与毛玻璃风格不搭，全部替换）
- 结构：`.dd` 容器 = 触发按钮 `.dd-btn`（当前值 + 旋转 caret）+ 浮层 `.dd-list`
- 浮层**向上弹出**（`bottom: calc(100% + 6px)`）——shell `overflow:hidden` 会裁掉向下弹的列表，向上弹永不超窗
- 深底毛玻璃（rgba(32,32,36,.97) + blur(20px) + 圆角 10）、细滚动条、hover 行高亮、当前项 `✓` 蓝字
- 关闭时机：点击外部（document click）+ Escape + 选中项
- 入场动画 `dd-in 0.16s`（fade + 上移）

### 窗口选择交互（"哪个窗口是哪个"的辨识问题）
悬停下拉项 250ms 去抖后，目标窗口四周亮 4px 红框约 3 秒。**必须用分层覆盖窗**：
- `WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOOLWINDOW|WS_EX_TOPMOST|WS_EX_NOACTIVATE` + `WS_POPUP` 的空心小窗（`SetWindowRgn` 外矩形挖内矩形只剩边框，类背景刷红色），盖在 `GetWindowRect` 位置上
- 3 秒后自毁：`SetTimer` → 窗口过程 `WM_TIMER→DestroyWindow`、`WM_DESTROY→PostQuitMessage`，线程跑 `GetMessageW` 循环
- 优点：零闪烁（**不要**用 GDI 画屏幕 DC + `InvalidateRect` 擦除——强制目标区域重绘会曝白闪烁）、鼠标穿透、永远顶层
- 连续 hover 多窗口用 `AtomicU32 generation` + 全局 `OVERLAY: Mutex<Option<isize>>` 存旧覆盖窗 hwnd，新调用 `PostMessageW(WM_CLOSE)` 销毁旧的
- windows 0.58 坑：`WPARAM` 在 `Win32::Foundation`；`GetMessageW/PostMessageW/SetTimer/CombineRgn` 参数用裸类型不带 `Option` 包装（包了报 Param trait 错误）；`InvalidateRect` 在 `Win32_Graphics_Gdi`；`SelectObject` 要 `HGDIOBJ::from(pen)` 显式转换（`.into()` 报 E0283）

### 下拉浮层方向
**向下弹**（`top: calc(100% + 6px)`）符合直觉，但外壳 `overflow:hidden` 会裁剪——打开时 JS 动态限高：
```js
const avail = window.innerHeight - btn.getBoundingClientRect().bottom - 10;
list.style.maxHeight = Math.max(80, Math.min(216, avail)) + "px";
```
（空间不足的字段会自动滚动，而非被裁）

### 面板展开动画（真展开，不是瞬现）
窗口原生 resize 无法动画，用两层配合伪造：**先 setSize 再让面板 CSS 过渡**——
```css
#panel { max-height: 0; opacity: 0; padding: 0 16px; overflow: hidden; pointer-events: none;
  transition: max-height .3s cubic-bezier(.2,.8,.25,1), opacity .22s, padding .3s; }
#panel.show { max-height: 420px; opacity: 1; padding: 12px 16px; }
```
- 展开：`await setSize(...)` → `requestAnimationFrame(() => panel.classList.add("show"))`
- 收起：`remove("show")` → `setTimeout(300)` 后再 setSize 缩回（等动画完）
- 内容行 `.anim` 各自 `animation-delay` 递增（0.10s 起步 +40ms/行）

### 统计信息放主界面（不藏面板）
常驻信息条每秒轮询：码率（文件增速 3 采样滑动窗口）/ FPS（丢帧≥1% 标 ⚠）/ CPU / GPU / 内存。启动即轮询，与面板开关无关。

## 架构模板

### tauri.conf.json 窗口关键参数
```json
{ "width": 430, "height": 86, "decorations": false, "transparent": true,
  "alwaysOnTop": true, "skipTaskbar": true, "resizable": false,
  "shadow": false, "focus": false }
```
窗口高度三态：**86**（收起=主条60+信息条26）→ **478**（展开设置面板）；高度值必须与 CSS 尺寸严格同步。

### 面板展开的窗口尺寸切换（贴底自动上移）
```js
const { getCurrentWindow, LogicalSize, PhysicalPosition } = window.__TAURI__.window;
await win.setSize(new LogicalSize(430, PANEL_H));
// 展开前 outerPosition() + currentMonitor() 判断，pos.y + PANEL_H*scale 超屏底则上移并记 savedY，收起还原
```
所需 capabilities：`core:window:allow-set-size / allow-set-position / allow-outer-position / allow-current-monitor / allow-scale-factor / allow-start-dragging / allow-close`。

### "播放最近产物"按钮模式
优先级链：本会话事件记录的路径 → `latest_video(dir)` 扫目录最新视频文件（Rust 按扩展名+mtime）→ 都没有则 toast 提示。打开文件用 opener 的 `open_path`（= 系统默认程序）。

### Rust 侧模式
- 悬浮条要"零业务"：只放系统能力 command（打开文件/文件夹、原生对话框、枚举窗口、进程查询），业务全走前端 WebSocket/HTTP
- 位置记忆：`WindowEvent::Moved` 节流 600ms 写 `app_data_dir/window-pos.json`，setup 时读回 set_position
- 调用外部 exe（如 nvidia-smi）必须 `.creation_flags(0x0800_0000)`（CREATE_NO_WINDOW），否则闪黑窗
- 弹文件夹选择：`tauri-plugin-dialog`，command 里 `app.dialog().file().blocking_pick_folder()`（同步 command 跑在非主线程，blocking 安全）

## Windows 踩坑清单（全部实测）

1. **debug 版必有控制台黑窗**——`windows_subsystem = "windows"` 只在 release 生效。交付用 release。
2. **运行中的 exe 锁定编译**——报 `os error 5 拒绝访问`，先 `Stop-Process` 再 build。
3. **WebView2 忽略 `--remote-debugging-port`**（新版安全限制），CDP 验证 UI 不可行；协议层用 node 复刻客户端验证。
4. `cmd start` 启动第三方程序（如 OBS）会因工作目录错误秒退且无日志，用 `Start-Process -WorkingDirectory`。
5. 透明窗口的空白区域仍拦截鼠标，**不要**用"大窗口+局部可见"方案；用 setSize 动态改窗口实际大小。
6. 全订阅 obs-websocket 事件会收到每秒 30+ 条音频电平洪流，Identify 时收窄 `eventSubscriptions`。

## OBS 悬浮条专用协议坑（obs-websocket 5.5.6 / OBS 31）

- **Event 消息 op=5**（文档普遍写 4）；请求 op=6、响应 op=7。判错 op 的症状：请求正常、事件永不到、零报错。
- 认证串：`base64(sha256(base64(sha256(pw+salt)) + challenge))`，浏览器 crypto.subtle 可算。
- `Get/SetProfileParameter` 字段名：`parameterCategory / parameterName / parameterValue`（非文档的 category/name/value）。
- `StopRecord` 响应含 `outputPath`（非 savedPath）；`RecordStateChanged` 事件的 eventData.outputPath 同样可拿路径。
- 常用参数：SimpleOutput 的 RecFormat2/VBitrate/ABitrate/RecEncoder（x264|nvenc|qsv|amd）；GetRecordDirectory/SetRecordDirectory 管目录。
- 窗口采集参数 `window` 格式（libobs 源码权威）：`title:class:exe纯文件名`，转义 `:`→`#3A`、`#`→`#22`。
- 统计：GetStats 有 cpuUsage/memoryUsage/activeFps/丢帧，**无 GPU 无码率**——GPU 用 nvidia-smi，码率用录像文件增速（3 采样滑动窗口）。
