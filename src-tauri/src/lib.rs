//! DSH Runtime Manager — Tauri backend.
mod paths;
mod plugins;
mod runtime;
mod settings;

use runtime::RuntimeCore;
use settings::Settings;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Listener, Manager, State};
use tauri_plugin_autostart::ManagerExt;

/// Menu handles refreshed by 'update_tray' as runtime status changes.
pub struct TrayUi {
    pub status: tauri::menu::MenuItem<tauri::Wry>,
    pub start: tauri::menu::MenuItem<tauri::Wry>,
    pub stop: tauri::menu::MenuItem<tauri::Wry>,
    pub restart: tauri::menu::MenuItem<tauri::Wry>,
    pub autostart: tauri::menu::CheckMenuItem<tauri::Wry>,
}

pub struct AppState {
    pub core: Arc<Mutex<RuntimeCore>>,
    pub settings: Mutex<Settings>,
    pub data_dir: PathBuf,
    pub tray: Mutex<Option<TrayUi>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub text: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub end: u64,
    pub lines: Vec<LogLine>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: runtime::StatusInfo,
    pub settings: Settings,
    pub node: String,
    pub dsh: String,
    pub gui_url: String,
    pub autostart_enabled: bool,
    /// The exact command line the app will use to launch the runtime.
    pub effective_cmd: String,
    /// True when node + dsh come from the bundled runtime shipped in the app.
    pub bundled: bool,
    /// Short "node vX · dsh Y" summary of the bundled runtime ("" when absent).
    pub bundle_info: String,
}

fn snapshot_of(app: &AppHandle, state: &State<'_, AppState>) -> Snapshot {
    let settings = state.settings.lock().unwrap().clone();
    let status = {
        let g = state.core.lock().unwrap();
        runtime::snapshot(&g)
    };
    let node_res = paths::detect_node(settings.node_path.as_deref());
    let dsh_res = paths::detect_dsh(settings.dsh_bin.as_deref());
    let node = node_res
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("⚠ {e}"));
    let dsh = dsh_res
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("⚠ {e}"));
    let bundled = match (&node_res, &dsh_res) {
        (Ok(n), Ok(d)) => {
            paths::bundled_node().map(|b| &b == n).unwrap_or(false)
                && paths::bundled_dsh().map(|b| &b == d).unwrap_or(false)
        }
        _ => false,
    };
    let bundle_info = paths::bundled_versions()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| {
            let n = v.get("nodeVersion").and_then(|x| x.as_str()).unwrap_or("?");
            let d = v.get("dshVersion").and_then(|x| x.as_str()).unwrap_or("?");
            format!("node v{n} · dsh {d}")
        })
        .unwrap_or_default();
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let gui_url = format!("http://127.0.0.1:{}", status.port);
    let effective_cmd = match (node_res, dsh_res, runtime::build_launch_args(&settings, status.port)) {
        (Ok(n), Ok(d), Ok(args)) => runtime::command_preview(&n, &d, &args),
        (_, _, Err(e)) => format!("⚠ {e}"),
        _ => "⚠ 未找到 node 或 dsh".to_string(),
    };
    Snapshot {
        status,
        settings,
        node,
        dsh,
        gui_url,
        autostart_enabled,
        effective_cmd,
        bundled,
        bundle_info,
    }
}

// ── tray helpers ─────────────────────────────────────────────────────────────

/// Show (or lazily create) the manager panel window. It is a secondary
/// window in the client model — the main window is the DSH GUI itself.
fn show_control(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("control") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    use tauri::WebviewWindowBuilder;
    if let Ok(w) = WebviewWindowBuilder::new(app, "control", tauri::WebviewUrl::App("index.html".into()))
        .title("DSH 管理面板")
        .inner_size(1020.0, 780.0)
        .min_inner_size(780.0, 580.0)
        .center()
        .build()
    {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn open_control(app: AppHandle) {
    show_control(&app);
}

/// Bring the DSH GUI window (the app's main window) to the front.
fn focus_gui(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("gui") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn open_gui_inner(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}", settings.port);
    if settings.gui_in_app {
        use tauri::WebviewWindowBuilder;
        if let Some(w) = app.get_webview_window("gui") {
            let _ = w.set_focus();
            return Ok(());
        }
        let url_parsed = url.parse().map_err(|e| format!("bad url: {e}"))?;
        WebviewWindowBuilder::new(app, "gui", tauri::WebviewUrl::External(url_parsed))
            .title(format!("DSH — {url}"))
            .inner_size(1280.0, 840.0)
            .build()
            .map_err(|e| format!("cannot open GUI window: {e}"))?;
        Ok(())
    } else {
        std::process::Command::new("open")
            .arg(&url)
            .status()
            .map_err(|e| format!("open failed: {e}"))?;
        Ok(())
    }
}

/// Refresh the tray menu (status line, enable/disable, autostart check).
fn update_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let (running, phase, port) = {
        let g = state.core.lock().unwrap();
        (g.child.is_some(), g.phase.clone(), g.port)
    };
    let label = match phase.as_str() {
        "starting" => "启动中…".to_string(),
        "running" => format!("运行中 · http://127.0.0.1:{port}"),
        "stopping" => "停止中…".to_string(),
        _ => "已停止".to_string(),
    };
    let tray_guard = state.tray.lock().unwrap();
    if let Some(t) = tray_guard.as_ref() {
        let _ = t.status.set_text(format!("DSH 运行时：{label}"));
        let _ = t.start.set_enabled(!running && phase != "starting" && phase != "stopping");
        let _ = t.stop.set_enabled(running);
        let _ = t.restart.set_enabled(running);
        let _ = t.autostart.set_checked(autostart_enabled);
    }
}

/// Run a tray menu action on the async runtime, then refresh the tray.
fn tray_action(app: &AppHandle, action: &str) {
    let state = app.state::<AppState>();
    let core = state.core.clone();
    let settings = state.settings.lock().unwrap().clone();
    let app_ui = app.clone();
    match action {
        "start" => {
            let app_bg = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    runtime::start(&app_bg, &core, &settings)
                })
                .await;
                update_tray(&app_ui);
            });
        }
        "stop" => {
            let app_bg = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tauri::async_runtime::spawn_blocking(move || runtime::stop(&app_bg, &core))
                    .await;
                update_tray(&app_ui);
            });
        }
        "restart" => {
            let app_bg = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    runtime::restart(&app_bg, &core, &settings)
                })
                .await;
                update_tray(&app_ui);
            });
        }
        "autostart" => {
            let enabled = app_ui.autolaunch().is_enabled().unwrap_or(false);
            let _ = if enabled {
                app_ui.autolaunch().disable()
            } else {
                app_ui.autolaunch().enable()
            };
            update_tray(&app_ui);
        }
        _ => {}
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let status = MenuItem::with_id(app, "tray-status", "DSH 运行时：—", false, None::<&str>)?;
    let focus_gui_item = MenuItem::with_id(app, "tray-focus-gui", "显示 DSH 主界面", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "tray-start", "启动运行时", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "tray-stop", "停止运行时", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "tray-restart", "重启运行时", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "tray-show", "管理面板", true, None::<&str>)?;
    let open_gui = MenuItem::with_id(app, "tray-open-gui", "在浏览器打开 DSH 界面", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "tray-autostart", "开机自启", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &status as &dyn IsMenuItem<tauri::Wry>,
            &sep1,
            &focus_gui_item,
            &start,
            &stop,
            &restart,
            &sep2,
            &show,
            &open_gui,
            &autostart,
            &sep3,
            &quit,
        ],
    )?;

    let icon = tauri::image::Image::new_owned(
        include_bytes!("../icons/tray-icon.rgba").to_vec(),
        32,
        32,
    );

    TrayIconBuilder::with_id("dsh-tray")
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DSH")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-focus-gui" => focus_gui(app),
            "tray-start" => tray_action(app, "start"),
            "tray-stop" => tray_action(app, "stop"),
            "tray-restart" => tray_action(app, "restart"),
            "tray-show" => show_control(app),
            "tray-open-gui" => {
                let state = app.state::<AppState>();
                let settings = state.settings.lock().unwrap().clone();
                let _ = open_gui_inner(app, &settings);
            }
            "tray-autostart" => tray_action(app, "autostart"),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_gui(tray.app_handle());
            }
        })
        .build(app)?;

    app.state::<AppState>().tray.lock().unwrap().replace(TrayUi {
        status,
        start,
        stop,
        restart,
        autostart,
    });
    Ok(())
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_snapshot(app: AppHandle, state: State<'_, AppState>) -> Snapshot {
    snapshot_of(&app, &state)
}

#[tauri::command]
async fn start_runtime(app: AppHandle, state: State<'_, AppState>) -> Result<u32, String> {
    let core = state.core.clone();
    let settings = state.settings.lock().unwrap().clone();
    let app_bg = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || runtime::start(&app_bg, &core, &settings))
        .await
        .map_err(|e| format!("task failed: {e}"))?;
    update_tray(&app);
    result
}

#[tauri::command]
async fn stop_runtime(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let core = state.core.clone();
    let app_bg = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || runtime::stop(&app_bg, &core))
        .await
        .map_err(|e| format!("task failed: {e}"))?;
    update_tray(&app);
    result
}

#[tauri::command]
async fn restart_runtime(app: AppHandle, state: State<'_, AppState>) -> Result<u32, String> {
    let core = state.core.clone();
    let settings = state.settings.lock().unwrap().clone();
    let app_bg = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || runtime::restart(&app_bg, &core, &settings))
        .await
        .map_err(|e| format!("task failed: {e}"))?;
    update_tray(&app);
    result
}

#[tauri::command]
fn get_logs(state: State<'_, AppState>, after: u64) -> LogPage {
    let (end, items) = runtime::logs_since(&state.core, after);
    LogPage {
        end,
        lines: items
            .into_iter()
            .map(|(seq, text)| LogLine { seq, text })
            .collect(),
    }
}

#[tauri::command]
fn clear_logs(state: State<'_, AppState>) -> u64 {
    runtime::clear_logs(&state.core)
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    settings::save(&state.data_dir, &settings)?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn open_gui(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    open_gui_inner(&app, &settings)
}

#[tauri::command]
fn reveal_logs(state: State<'_, AppState>) -> Result<(), String> {
    let path = match state.core.lock().unwrap().log_file.clone() {
        Some(p) => p,
        None => state.data_dir.join("logs/runtime.log"),
    };
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("reveal failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())?;
    }
    update_tray(&app);
    Ok(())
}

// ── plugin management ───────────────────────────────────────────────────────

/// If the runtime is running, restart it so plugin/overlay changes take effect.
fn restart_after_plugin_change(app: &AppHandle, state: &State<'_, AppState>) {
    let running = state.core.lock().unwrap().child.is_some();
    if !running {
        return;
    }
    let app2 = app.clone();
    let app_bg = app.clone();
    let core2 = state.core.clone();
    let settings2 = state.settings.lock().unwrap().clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            runtime::restart(&app_bg, &core2, &settings2)
        })
        .await;
        update_tray(&app2);
    });
}

#[tauri::command]
fn list_plugins(state: State<'_, AppState>) -> Vec<plugins::PluginInfo> {
    let profile = state.settings.lock().unwrap().profile.clone();
    plugins::list_plugins(&profile)
}

#[tauri::command]
async fn add_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    spec: String,
) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let node = paths::detect_node(settings.node_path.as_deref())?;
    let dsh = paths::detect_dsh(settings.dsh_bin.as_deref())?;
    let data_dir = state.data_dir.clone();
    let profile = settings.profile.clone();
    let workspace = settings.workspace.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let args = vec!["add".to_string(), spec, "-w".to_string()];
        plugins::run_plugin_op(
            &data_dir,
            &profile,
            &node,
            &dsh,
            &args,
            Path::new(&workspace),
        )
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?;
    match result {
        Ok(out) => {
            restart_after_plugin_change(&app, &state);
            Ok(out)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn remove_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let node = paths::detect_node(settings.node_path.as_deref())?;
    let dsh = paths::detect_dsh(settings.dsh_bin.as_deref())?;
    let data_dir = state.data_dir.clone();
    let profile = settings.profile.clone();
    let workspace = settings.workspace.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        plugins::remove_plugin(
            &data_dir,
            &profile,
            &name,
            &node,
            &dsh,
            Path::new(&workspace),
        )
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?;
    match result {
        Ok(out) => {
            restart_after_plugin_change(&app, &state);
            Ok(out)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn set_plugin_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let profile = state.settings.lock().unwrap().profile.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        plugins::set_plugin_enabled(&profile, &name, enabled)
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?;
    result?;
    restart_after_plugin_change(&app, &state);
    Ok(())
}

#[tauri::command]
fn get_runtime_info(state: State<'_, AppState>) -> plugins::RuntimeInfo {
    let settings = state.settings.lock().unwrap().clone();
    let profile = settings.profile.clone();
    let dsh_version = (|| -> String {
        let (Ok(node_p), Ok(dsh_p)) = (
            paths::detect_node(settings.node_path.as_deref()),
            paths::detect_dsh(settings.dsh_bin.as_deref()),
        ) else {
            return "未知".into();
        };
        let out = match std::process::Command::new(node_p)
            .arg(dsh_p)
            .arg("--version")
            .output()
        {
            Ok(o) => o,
            Err(_) => return "未知".into(),
        };
        if !out.status.success() {
            return "未知".into();
        }
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    })();
    let node_version = match paths::detect_node(settings.node_path.as_deref()) {
        Ok(p) => std::process::Command::new(&p)
            .arg("--version")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "未知".into()),
        Err(_) => "未知".into(),
    };
    let count = plugins::list_plugins(&profile).len();
    let dir = plugins::profile_dir(&profile);
    let overlay_path = plugins::overlay_path(&profile);
    let overlay = overlay_path.is_file();
    plugins::RuntimeInfo {
        dsh_version,
        node_version,
        profile: profile.clone(),
        profile_dir: dir.display().to_string(),
        plugin_count: count,
        overlay_path: overlay_path.display().to_string(),
        overlay,
    }
}

// ── entry ────────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let settings = settings::load(&data_dir);
            let start_on_launch = settings.start_on_launch;
            let core = Arc::new(Mutex::new(RuntimeCore::default()));
            {
                let mut g = core.lock().unwrap();
                g.port = settings.port;
            }
            app.manage(AppState {
                core: core.clone(),
                settings: Mutex::new(settings.clone()),
                data_dir: data_dir.clone(),
                tray: Mutex::new(None),
            });

            build_tray(app.handle())?;

            // keep the tray menu in sync with runtime-status changes
            let app_ev = app.handle().clone();
            let _ = app.listen("runtime-status", move |_| update_tray(&app_ev));
            update_tray(app.handle());

            // Scripted control hooks (--start-runtime / --stop-runtime /
            // --restart-runtime): also used by the automated verification loop.
            let argv: Vec<String> = std::env::args().collect();
            let action = argv.iter().find_map(|a| match a.as_str() {
                "--start-runtime" => Some("start"),
                "--stop-runtime" => Some("stop"),
                "--restart-runtime" => Some("restart"),
                _ => None,
            });
            // plugin ops for scripting/verification; results land in
            // <data_dir>/plugin-cli-out.txt
            let plugin_op: Option<(String, Vec<String>)> = {
                let mut found = None;
                let mut i = 1;
                while i < argv.len() {
                    match argv[i].as_str() {
                        "--plugin-list" => found = Some(("list".into(), Vec::new())),
                        "--plugin-add" if i + 1 < argv.len() => {
                            found = Some(("add".into(), vec![argv[i + 1].clone()]))
                        }
                        "--plugin-remove" if i + 1 < argv.len() => {
                            found = Some(("remove".into(), vec![argv[i + 1].clone()]))
                        }
                        "--plugin-set" if i + 2 < argv.len() => {
                            found = Some(("set".into(), vec![argv[i + 1].clone(), argv[i + 2].clone()]))
                        }
                        _ => {}
                    }
                    i += 1;
                }
                found
            };
            // Automation hook: open the manager panel window (--open-control).
            let open_control_cli = argv.iter().any(|a| a == "--open-control");
            if open_control_cli {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    show_control(&app_handle);
                });
            }
            let auto_start = start_on_launch && action.is_none();
            if auto_start || action.is_some() {
                let app_handle = app.handle().clone();
                let core2 = core.clone();
                let settings2 = settings.clone();
                let act = action.unwrap_or("start").to_string();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                    let res = match act.as_str() {
                        "stop" => runtime::stop(&app_handle, &core2),
                        "restart" => runtime::restart(&app_handle, &core2, &settings2).map(|_| ()),
                        _ => runtime::start(&app_handle, &core2, &settings2).map(|_| ()),
                    };
                    if let Err(e) = res {
                        eprintln!("[manager-cli] {e}");
                    }
                    update_tray(&app_handle);
                });
            }
            if let Some((kind, args)) = plugin_op {
                let app_handle = app.handle().clone();
                let core2 = core.clone();
                let settings2 = settings.clone();
                let data_dir2 = data_dir.clone();
                let hook_out = data_dir.join("plugin-cli-out.txt");
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1600));
                    let profile = settings2.profile.clone();
                    let result: Result<String, String> = (|| -> Result<String, String> {
                        match kind.as_str() {
                        "list" => {
                            let list = plugins::list_plugins(&profile);
                            serde_json::to_string(&list).map_err(|e| e.to_string())
                        }
                        "add" => {
                            let node = paths::detect_node(settings2.node_path.as_deref())?;
                            let dsh = paths::detect_dsh(settings2.dsh_bin.as_deref())?;
                            let spec = args.first().cloned().unwrap_or_default();
                            let pa = vec!["add".to_string(), spec, "-w".to_string()];
                            plugins::run_plugin_op(
                                &data_dir2,
                                &profile,
                                &node,
                                &dsh,
                                &pa,
                                Path::new(&settings2.workspace),
                            )
                        }
                        "remove" => {
                            let node = paths::detect_node(settings2.node_path.as_deref())?;
                            let dsh = paths::detect_dsh(settings2.dsh_bin.as_deref())?;
                            let name = args.first().cloned().unwrap_or_default();
                            plugins::remove_plugin(
                                &data_dir2,
                                &profile,
                                &name,
                                &node,
                                &dsh,
                                Path::new(&settings2.workspace),
                            )
                        }
                        "set" => {
                            let name = args.first().cloned().unwrap_or_default();
                            let enabled = args.get(1).map(|v| v == "on").unwrap_or(false);
                            plugins::set_plugin_enabled(&profile, &name, enabled)
                                .map(|_| format!("set {name} enabled={enabled}"))
                        }
                        _ => Err("unknown plugin op".into()),
                        }
                    })();
                    let text = match &result {
                        Ok(o) => format!("OK\n{o}"),
                        Err(e) => format!("ERR\n{e}"),
                    };
                    if kind.as_str() != "list" {
                        let running = core2.lock().unwrap().child.is_some();
                        let restart_note = if running {
                            match runtime::restart(&app_handle, &core2, &settings2) {
                                Ok(pid) => format!("\nRESTART ok pid {pid}"),
                                Err(e) => format!("\nRESTART err: {e}"),
                            }
                        } else {
                            "\nRESTART skipped: not running in this instance".to_string()
                        };
                        let _ = std::fs::write(&hook_out, format!("{text}{restart_note}"));
                    } else {
                        let _ = std::fs::write(&hook_out, text);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            start_runtime,
            stop_runtime,
            restart_runtime,
            get_logs,
            clear_logs,
            save_settings,
            open_gui,
            reveal_logs,
            autostart_set,
            list_plugins,
            add_plugin,
            remove_plugin,
            set_plugin_enabled,
            get_runtime_info,
            open_control,
        ])
        .on_window_event(|window, event| {
            // Client model: closing the main (GUI) window quits the app.
            // The dsh runtime keeps running (own session) and is adopted on
            // the next launch.
            if window.label() == "gui" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
