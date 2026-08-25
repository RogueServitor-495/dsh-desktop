//! User-managed dsh kernel versions: list installed, query the npm registry,
//! install and delete. A "kernel" is a self-contained npm install of
//! @deepseek-ai/dsh under <data_dir>/kernels/<version>; it runs on the node
//! binary bundled with the app, so no system Node.js is required to install
//! or use one. settings.kernel selects the active kernel (None = bundled).
use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::paths;

pub const DSH_PACKAGE: &str = "@deepseek-ai/dsh";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelEntry {
    /// Version string as selected/installed.
    pub version: String,
    /// Install directory ("" for the bundled runtime).
    pub dir: String,
    /// Currently selected in settings.
    pub active: bool,
    /// The runtime files are actually present (bin.js found).
    pub installed: bool,
}

/// Versions reply for the panel: the bundled runtime plus user kernels.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelList {
    pub bundled_version: String,
    pub bundled_active: bool,
    pub kernels: Vec<KernelEntry>,
    /// Version currently selected in settings (None = bundled).
    pub selected: Option<String>,
}

/// A version (or dist-tag) is safe if it can never traverse paths.
fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
}

/// Run a command to completion with a hard timeout, capturing output.
fn run_capture_timeout(mut cmd: Command, timeout: Duration) -> Result<std::process::Output, String> {
    crate::paths::hide_console(&mut cmd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("命令超时".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    }
    child
        .wait_with_output()
        .map_err(|e| format!("collect output failed: {e}"))
}

/// node + npm-cli invocation that never requires a system Node.js: prefer the
/// node/npm shipped inside the app bundle, fall back to PATH npm for dev trees.
fn npm_invocation() -> Result<(String, Vec<String>), String> {
    if let (Some(node), Some(cli)) = (paths::bundled_node(), paths::bundled_npm_cli()) {
        return Ok((node.display().to_string(), vec![cli.display().to_string()]));
    }
    #[cfg(windows)]
    return Ok(("npm.cmd".into(), Vec::new()));
    #[cfg(not(windows))]
    return Ok(("npm".into(), Vec::new()));
}

/// Spawn npm with the child PATH (so native deps resolve) and capture output.
fn run_npm(args: &[String], timeout: Duration) -> Result<String, String> {
    let (cmd, prefix) = npm_invocation()?;
    let mut c = Command::new(&cmd);
    c.args(&prefix)
        .args(args)
        .env("PATH", paths::child_path());
    let out = run_capture_timeout(c, timeout)?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        let tail: String = text.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("npm 失败（退出码 {:?}）:\n{tail}", out.status.code()));
    }
    Ok(text)
}

/// Version recorded in an installed kernel's manifest.
fn manifest_version(dir: &Path) -> Option<String> {
    let p = dir
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let text = std::fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(String::from)
}

/// List installed kernels plus the bundled runtime.
pub fn list_kernels(data_dir: &Path, selected: Option<&str>) -> KernelList {
    let bundled_version = paths::bundled_versions()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("dshVersion")
                .and_then(|x| x.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "?".into());
    let selected = selected.map(|s| s.trim()).filter(|s| !s.is_empty());
    let mut kernels: Vec<KernelEntry> = Vec::new();
    let root = paths::kernels_root(data_dir);
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) || !valid_version(&name) {
                continue;
            }
            let dir = e.path();
            let bin = dir
                .join("node_modules")
                .join("@deepseek-ai")
                .join("dsh")
                .join("lib")
                .join("bin.js");
            let version = manifest_version(&dir).unwrap_or_else(|| name.clone());
            kernels.push(KernelEntry {
                version,
                dir: dir.display().to_string(),
                active: selected == Some(name.as_str()),
                installed: bin.is_file(),
            });
        }
    }
    kernels.sort_by(|a, b| b.version.cmp(&a.version));
    KernelList {
        bundled_active: selected.is_none(),
        bundled_version,
        kernels,
        selected: selected.map(String::from),
    }
}

/// Available @deepseek-ai/dsh versions from the npm registry, newest first.
pub fn registry_versions() -> Result<Vec<String>, String> {
    let out = run_npm(
        &[
            "view".to_string(),
            DSH_PACKAGE.to_string(),
            "versions".to_string(),
            "--json".to_string(),
        ],
        QUERY_TIMEOUT,
    )?;
    let trimmed = out.trim();
    // npm may print warnings before the JSON; find the first '[' line.
    let start = trimmed.find('[').ok_or("registry 返回了无法解析的内容")?;
    let json: Vec<String> = serde_json::from_str(&trimmed[start..])
        .map_err(|e| format!("解析 registry 版本列表失败: {e}"))?;
    let mut v = json;
    v.reverse(); // newest first
    Ok(v)
}

/// Resolve a dist-tag ("latest") to a concrete version.
fn resolve_spec(version: &str) -> Result<String, String> {
    if version != "latest" {
        return Ok(version.to_string());
    }
    let out = run_npm(
        &[
            "view".to_string(),
            DSH_PACKAGE.to_string(),
            "version".to_string(),
        ],
        QUERY_TIMEOUT,
    )?;
    let v = out.trim().lines().last().unwrap_or("").trim().to_string();
    if v.is_empty() {
        return Err("无法解析 latest 版本".into());
    }
    Ok(v)
}

/// Install a kernel version into <data_dir>/kernels/<version>.
/// Returns the concrete installed version.
pub fn install_kernel(data_dir: &Path, version: &str) -> Result<String, String> {
    let version = resolve_spec(version.trim())?;
    if !valid_version(&version) {
        return Err(format!("非法版本号: {version}"));
    }
    let dir = paths::kernel_dir(data_dir, &version);
    let bin = dir
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if bin.is_file() {
        return Ok(version); // already installed
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("清理旧安装失败: {e}"))?;
    }
    std::fs::create_dir_all(paths::kernels_root(data_dir))
        .map_err(|e| format!("创建 kernels 目录失败: {e}"))?;
    let display = dir.display().to_string();
    run_npm(
        &[
            "install".to_string(),
            format!("{DSH_PACKAGE}@{version}"),
            "--prefix".to_string(),
            display,
            "--omit=dev".to_string(),
            "--no-audit".to_string(),
            "--no-fund".to_string(),
            "--no-update-notifier".to_string(),
            "--loglevel=error".to_string(),
        ],
        INSTALL_TIMEOUT,
    )?;
    if !bin.is_file() {
        return Err("安装完成但未找到 dsh 入口（bin.js）— 请重试或检查网络".into());
    }
    Ok(version)
}

/// Delete an installed kernel. Refuses to remove the active one.
pub fn delete_kernel(data_dir: &Path, version: &str, active: Option<&str>) -> Result<(), String> {
    if !valid_version(version) {
        return Err(format!("非法版本号: {version}"));
    }
    if active.map(|a| a.trim()) == Some(version) {
        return Err("该内核正在使用中 — 请先切换回内置运行时再删除".into());
    }
    let dir = paths::kernel_dir(data_dir, version);
    if !dir.is_dir() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))
}
