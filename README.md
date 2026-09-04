# tauri-float-widget

Tauri 桌面常驻悬浮工具条的设计规范与完整参考实现——毛玻璃一体化外壳（主条 + 常驻信息条 + 展开设置面板）、窗口位置记忆、贴底自动避让、stagger 渐入动画，以及 Windows / OBS WebSocket 全部实测踩坑。

参考成品：OBS 录制悬浮控制条（悬浮录制/暂停/停止、窗口选择、实时码率/FPS/CPU/GPU 统计、录像设置、一键播放最近录像）。

## 这是什么

一套经过完整实测打磨的「桌面悬浮小工具」模式：

- **一体化外壳**：主控制条、常驻统计信息条、展开式设置面板三层共享同一个毛玻璃圆角容器，视觉上是一整块
- **悬浮条即全部信息**：统计常驻主界面，不需要打开任何面板就能看到码率/FPS/CPU/GPU/内存
- **设置面板**：齿轮展开（窗口动态变高 + 内容 stagger 渐入 + 贴底自动上移），改完即持久化
- **零框架**：原生 HTML/CSS/JS，Rust 侧只做系统能力桥接（文件夹对话框、窗口枚举、进程查询、打开文件）

## 安装为 Agent Skill

把 `SKILL.md` 拷贝到你的 skills 目录（例如 `~/.zcode/skills/tauri-float-widget/SKILL.md` 或 `~/.claude/skills/tauri-float-widget/SKILL.md`），之后对 agent 说"做个悬浮小工具"即可自动套用这套规范。

## 仓库内容

- [`SKILL.md`](SKILL.md) — skill 本体：UI 设计规范 + 架构模板 + 踩坑清单
- [`example/`](example/) — 完整可编译参考工程的核心文件（OBS 悬浮控制条成品）
  - `index.html` / `main.js` — 前端全部（一体化外壳 UI + obs-websocket 协议实现）
  - `lib.rs` — Rust command（窗口枚举、GPU 查询、文件扫描、原生对话框）
  - `tauri.conf.json` / `Cargo.toml` / `capabilities.json` — 配置与权限

## 关键踩坑（详见 SKILL.md）

1. OBS 31 的 obs-websocket 5.5.6 **事件 op=5**（文档普遍写 4）——判错时请求正常、事件永不到、零报错
2. Profile 参数字段名是 `parameterCategory/parameterName/parameterValue`（非文档的 category/name）
3. 窗口采集参数格式 `title:class:exe纯文件名` + `#3A`/`#22` 转义（libobs 源码权威）
4. 默认事件订阅有每秒 30+ 条音频电平洪流，需收窄 `eventSubscriptions`
5. Tauri debug 版必有控制台黑窗；运行中 exe 锁定编译；WebView2 已禁 CDP 调试端口
6. 调 nvidia-smi 必须 `CREATE_NO_WINDOW`，否则闪黑窗
