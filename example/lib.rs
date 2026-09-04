use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
struct ObsConfig {
    enabled: bool,
    port: u16,
    password: String,
}

/// 读取 OBS 自带的 obs-websocket 配置（OBS 28+ 内置），悬浮条据此直连，免手动填端口密码
#[tauri::command]
fn get_obs_config() -> Result<ObsConfig, String> {
    let base = std::env::var("APPDATA").map_err(|_| "无法定位 APPDATA 目录".to_string())?;
    let path = PathBuf::from(base)
        .join("obs-studio")
        .join("plugin_config")
        .join("obs-websocket")
        .join("config.json");
    let txt =
        fs::read_to_string(&path).map_err(|e| format!("读取 OBS WebSocket 配置失败: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&txt).map_err(|e| format!("解析 OBS 配置失败: {e}"))?;
    Ok(ObsConfig {
        enabled: v["server_enabled"].as_bool().unwrap_or(false),
        port: v["server_port"].as_u64().unwrap_or(4455) as u16,
        password: v["server_password"].as_str().unwrap_or("").to_string(),
    })
}

/// 在资源管理器中定位已保存的录像文件
#[tauri::command]
fn reveal_saved(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("打开文件夹失败: {e}"))
}

/// 直接打开录像文件夹本身
#[tauri::command]
fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path.to_string(), None::<&str>)
        .map_err(|e| format!("打开文件夹失败: {e}"))
}

/// 弹出系统文件夹选择对话框，返回所选路径（取消返回 null）
#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// 当前录像文件大小（字节），用于前端算实时码率
#[tauri::command]
fn rec_file_size(path: String) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// 扫描目录里最新的视频文件（按修改时间），返回完整路径
#[tauri::command]
fn latest_video(dir: String) -> Option<String> {
    const EXTS: [&str; 6] = ["mkv", "mp4", "mov", "m4v", "flv", "ts"];
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in std::fs::read_dir(&dir).ok()? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let is_video = path
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| EXTS.contains(&x.to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_video { continue; }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        if best.as_ref().map_or(true, |(t, _)| modified > *t) {
            best = Some((modified, path.to_string_lossy().to_string()));
        }
    }
    best.map(|(_, p)| p)
}

#[derive(Serialize)]
struct GpuStats {
    gpu: u32,
    enc: u32,
    mem_mb: u32,
}

/// nvidia-smi 查 GPU 利用率 / NVENC 编码器利用率 / 显存占用
#[tauri::command]
fn gpu_stats() -> Option<GpuStats> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=utilization.gpu,utilization.encoder,memory.used",
            "--format=csv,noheader,nounits",
        ])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：避免闪黑窗
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let first = s.lines().next()?; // 多 GPU 取第一块
    let n: Vec<u32> = first.split(',').filter_map(|p| p.trim().parse().ok()).collect();
    if n.len() >= 3 {
        Some(GpuStats { gpu: n[0], enc: n[1], mem_mb: n[2] })
    } else {
        None
    }
}

// ---- Windows 窗口枚举（供 OBS window_capture 选择） ----
// OBS 的 window 参数格式（libobs/util/windows/window-helpers.c 权威源码）：
// "title:class:executable"，exe 为纯文件名；特殊字符转义 ':'->"#3A"、'#'->"#22"
#[cfg(windows)]
mod win_enum {
    use serde::Serialize;
    use std::sync::Mutex;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    #[derive(Serialize)]
    pub struct WinEntry {
        pub label: String,      // 下拉显示："标题 — exe"
        pub obs_window: String, // OBS 格式："title:class:exe"（已转义）
        pub hwnd: isize,        // 原生窗口句柄（供悬停高亮）
    }

    static COLLECTED: Mutex<Vec<WinEntry>> = Mutex::new(Vec::new());

    fn to_string(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    fn obs_escape(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                '#' => out.push_str("#22"),
                ':' => out.push_str("#3A"),
                _ => out.push(c),
            }
        }
        out
    }

    fn exe_name(pid: u32) -> String {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(h);
            if ok.is_ok() {
                to_string(&buf[..len as usize]).rsplit('\\').next().unwrap_or("").to_string()
            } else {
                String::new()
            }
        }
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
        unsafe {
            let visible = IsWindowVisible(hwnd).as_bool()
                && GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 == 0
                && GetWindowTextLengthW(hwnd) > 0;
            if visible {
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid != std::process::id() {
                    // 排除悬浮条自己
                    let mut title_buf = [0u16; 512];
                    let n = GetWindowTextW(hwnd, &mut title_buf);
                    let title = to_string(&title_buf[..n as usize]);
                    if !title.is_empty() {
                        let mut class_buf = [0u16; 256];
                        let n = GetClassNameW(hwnd, &mut class_buf);
                        let class = to_string(&class_buf[..n as usize]);
                        let exe = exe_name(pid);
                        COLLECTED.lock().unwrap().push(WinEntry {
                            label: format!("{} — {}", title, exe),
                            obs_window: format!("{}:{}:{}", obs_escape(&title), obs_escape(&class), exe),
                            hwnd: hwnd.0 as isize,
                        });
                    }
                }
            }
        }
        BOOL(1) // 永远继续枚举
    }

    pub fn run() -> Vec<WinEntry> {
        COLLECTED.lock().unwrap().clear();
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(0));
        }
        let mut v = std::mem::take(&mut *COLLECTED.lock().unwrap());
        v.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        v
    }
}

/// 枚举当前可录制的顶层窗口
#[cfg(windows)]
#[tauri::command]
fn list_windows() -> Vec<win_enum::WinEntry> {
    win_enum::run()
}

// ---- 悬停高亮：在目标窗口四周画红框约 3 秒（画在屏幕 DC，任何窗口之上都可见） ----
#[cfg(windows)]
mod flash {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;
    use windows::Win32::Foundation::{COLORREF, HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreatePen, DeleteObject, GetDC, InvalidateRect, Rectangle, ReleaseDC, SelectObject,
        PS_SOLID,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    static GEN: AtomicU32 = AtomicU32::new(0);

    pub fn flash_border(hwnd_val: isize) {
        let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || unsafe {
            let hwnd = HWND(hwnd_val as *mut _);
            for _ in 0..10 {
                if GEN.load(Ordering::SeqCst) != gen { return; } // 已切到别的窗口
                let mut r = RECT::default();
                if GetWindowRect(hwnd, &mut r).is_err() { return; }
                let dc = GetDC(None);
                // 4px 亮红框（COLORREF = 0x00BBGGRR）
                let pen = CreatePen(PS_SOLID, 4, COLORREF(0x00_3C_46_FF));
                let old = SelectObject(dc, windows::Win32::Graphics::Gdi::HGDIOBJ::from(pen));
                let _ = Rectangle(dc, r.left, r.top, r.right, r.bottom);
                SelectObject(dc, old);
                let _ = DeleteObject(windows::Win32::Graphics::Gdi::HGDIOBJ::from(pen));
                ReleaseDC(None, dc);
                std::thread::sleep(Duration::from_millis(300));
            }
            // 结束后擦掉边框（强制目标区域重绘）
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                let _ = InvalidateRect(None, Some(&r), true);
            }
        });
    }
}

/// 悬停下拉项时高亮目标窗口（红框约 3 秒）
#[cfg(windows)]
#[tauri::command]
fn flash_window(hwnd: isize) {
    flash::flash_border(hwnd);
}

struct PosState {
    last: Mutex<Option<(i32, i32)>>,
    last_write: Mutex<Option<Instant>>,
}

fn pos_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("window-pos.json"))
}

fn save_pos(app: &tauri::AppHandle, x: i32, y: i32) {
    if let Some(f) = pos_file(app) {
        if let Some(dir) = f.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&f, format!(r#"{{"x":{x},"y":{y}}}"#));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PosState {
            last: Mutex::new(None),
            last_write: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_obs_config,
            reveal_saved,
            open_folder,
            pick_folder,
            rec_file_size,
            latest_video,
            gpu_stats,
            list_windows,
            flash_window
        ])
        .setup(|app| {
            if let Some(f) = pos_file(app.handle()) {
                if let Ok(txt) = fs::read_to_string(&f) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                        if let (Some(x), Some(y)) = (v["x"].as_i64(), v["y"].as_i64()) {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
                            }
                        }
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Moved(pos) = event {
                let app = window.app_handle();
                let state: tauri::State<PosState> = app.state();
                *state.last.lock().unwrap() = Some((pos.x, pos.y));
                let mut lw = state.last_write.lock().unwrap();
                if lw.map_or(true, |t| t.elapsed() > Duration::from_millis(600)) {
                    *lw = Some(Instant::now());
                    drop(lw);
                    if let Some((x, y)) = *state.last.lock().unwrap() {
                        save_pos(app, x, y);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
