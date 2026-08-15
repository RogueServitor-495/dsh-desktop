//! Persisted user settings for the DSH runtime manager.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 3080;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Port the dsh web runtime binds to.
    pub port: u16,
    /// Workspace root the runtime boots in (invoking directory of dsh).
    pub workspace: String,
    /// Explicit node executable path; None = auto-detect.
    pub node_path: Option<String>,
    /// Explicit dsh bin.js path; None = auto-detect.
    pub dsh_bin: Option<String>,
    /// Start the runtime automatically when the app launches.
    pub start_on_launch: bool,
    /// Open the DSH GUI inside an app window (true) or the system browser (false).
    pub gui_in_app: bool,
    /// dsh profile name under $DSH_HOME/profiles.
    pub profile: String,
    /// Bind host for the web server (127.0.0.1 only; dsh rejects 0.0.0.0 for safety).
    pub host: String,
    /// Extra authorities accepted by the /api browser-trust fence (comma/space separated).
    pub trusted_hosts: String,
    /// Free-form extra launch arguments passed to dsh.
    pub extra_args: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            port: DEFAULT_PORT,
            workspace: std::env::var("HOME").unwrap_or_else(|_| ".".into()),
            node_path: None,
            dsh_bin: None,
            // Client 模式：双击打开即自动拉起运行时（可在管理面板关闭）
            start_on_launch: true,
            gui_in_app: true,
            profile: "web".to_string(),
            host: "127.0.0.1".to_string(),
            trusted_hosts: String::new(),
            extra_args: String::new(),
        }
    }
}

pub fn settings_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("settings.json")
}

pub fn load(data_dir: &std::path::Path) -> Settings {
    let path = settings_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(data_dir: &std::path::Path, s: &Settings) -> Result<(), String> {
    let path = settings_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create settings dir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("cannot write settings: {e}"))
}
