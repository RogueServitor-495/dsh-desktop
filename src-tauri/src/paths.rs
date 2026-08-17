//! Locate the node executable and the dsh bin.js entry used to spawn the runtime.
//!
//! Detection order: an explicit user override (settings) wins, then the
//! **bundled runtime** shipped inside the app bundle (node + dsh under
//! Contents/Resources/runtime), then the system (PATH / well-known install
//! dirs). The bundled runtime makes the app self-contained: it runs on
//! machines that have no Node.js installed at all. Cross-platform: the
//! bundled tree uses node-<platform>-<arch> (darwin/win32 × arm64/x64).
use std::path::{Path, PathBuf};

/// Architecture tag used inside the bundled runtime tree.
pub fn arch_tag() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

/// Platform tag used inside the bundled runtime tree (node-<platform>-<arch>).
pub fn runtime_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else {
        "darwin"
    }
}

/// Directory name of the bundled node for this platform/arch.
pub fn node_dir_name() -> String {
    format!("node-{}-{}", runtime_platform(), arch_tag())
}

/// Root of the bundled runtime (node + dsh + versions.json).
///
/// Candidates, in order:
/// - release layout: <exe_dir>/../Resources/runtime (macOS .app) or
///   <exe_dir>/../runtime (Windows: binary + resources sit together)
/// - dev tree: src-tauri/resources/runtime (compile-time manifest dir)
pub fn runtime_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            #[cfg(target_os = "macos")]
            if let Some(contents) = parent.parent() {
                candidates.push(contents.join("Resources").join("runtime"));
                candidates.push(contents.join("Resources").join("resources").join("runtime"));
            }
            #[cfg(windows)]
            candidates.push(parent.join("runtime"));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("runtime"),
    );
    for c in candidates {
        if c.is_dir() {
            return Some(c);
        }
    }
    None
}

/// Bundled node executable for the current platform/arch, if present.
pub fn bundled_node() -> Option<PathBuf> {
    let root = runtime_root()?;
    let dir = root.join(node_dir_name());
    #[cfg(windows)]
    let p = dir.join("node.exe");
    #[cfg(not(windows))]
    let p = dir.join("bin").join("node");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// Bundled dsh bin.js, if the bundle is present.
pub fn bundled_dsh() -> Option<PathBuf> {
    let root = runtime_root()?;
    let p = root
        .join("dsh")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// Bundled pnpm executable dir (dsh/node_modules/.bin), used for plugin ops.
pub fn bundled_pnpm_dir() -> Option<PathBuf> {
    let root = runtime_root()?;
    let p = root.join("dsh").join("node_modules").join(".bin");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// The pnpm executable inside the bundled .bin dir (pnpm on unix, pnpm.cmd on Windows).
pub fn bundled_pnpm_bin() -> Option<PathBuf> {
    let dir = bundled_pnpm_dir()?;
    #[cfg(windows)]
    let p = dir.join("pnpm.cmd");
    #[cfg(not(windows))]
    let p = dir.join("pnpm");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// Raw content of the bundled versions.json (node/dsh versions for the UI).
pub fn bundled_versions() -> Option<String> {
    let root = runtime_root()?;
    std::fs::read_to_string(root.join("versions.json")).ok()
}

/// Apply Windows console suppression to a child process so helper subprocesses
/// (powershell, taskkill, where.exe, node --version, plugin ops) never flash a
/// console window when spawned from the GUI app. No-op on non-Windows.
pub fn hide_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Resolve a command name through PATH: "where" on Windows, sh -lc on unix.
pub fn which(cmd: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut w = std::process::Command::new("where.exe");
        w.arg(cmd);
        hide_console(&mut w);
        let out = w.output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(PathBuf::from(s))
        }
    }
    #[cfg(not(windows))]
    {
        // Login shell env is what a GUI-launched app lacks, so ask sh -lc for PATH resolution.
        let out = std::process::Command::new("sh")
            .args(["-lc", &format!("command -v {}", cmd)])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(PathBuf::from(s))
        }
    }
}

fn newest_matching(glob_dir: &Path, sub: &str) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(glob_dir) {
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let cand = e.path().join(sub);
            if cand.is_file() {
                let mtime = std::fs::metadata(&cand).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                    best = Some((mtime, cand));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}
/// Find the node executable: explicit path, bundled runtime, well-known dirs, then PATH.
pub fn detect_node(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("node path not found: {}", p.display()));
    }
    if let Some(b) = bundled_node() {
        return Ok(b);
    }
    #[cfg(windows)]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let cands = [
            PathBuf::from(&pf).join("nodejs").join("node.exe"),
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        ];
        for c in cands {
            if c.is_file() {
                return Ok(c);
            }
        }
        if let Some(p) = which("node") {
            if p.is_file() {
                return Ok(p);
            }
        }
        // nvm-windows fallback
        if let Ok(appdata) = std::env::var("APPDATA") {
            let nvm_dir = Path::new(&appdata).join("nvm");
            if let Some(p) = newest_matching(&nvm_dir, "node.exe") {
                return Ok(p);
            }
        }
    }
    #[cfg(not(windows))]
    {
        for cand in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if Path::new(cand).is_file() {
                return Ok(PathBuf::from(cand));
            }
        }
        if let Some(p) = which("node") {
            if p.is_file() {
                return Ok(p);
            }
        }
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        if !home.as_os_str().is_empty() {
            if let Some(p) = newest_matching(&home.join(".nvm/versions/node"), "bin/node") {
                return Ok(p);
            }
            if let Some(p) = newest_matching(&home.join(".volta/tools/image"), "bin/node") {
                return Ok(p);
            }
        }
    }
    Err("node 未找到 — App 内置运行时缺失，或请在设置中指定 node 路径".into())
}

/// Find dsh's bin.js: explicit path, bundled runtime, PATH, then the npx cache.
pub fn detect_dsh(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("dsh bin.js not found: {}", p.display()));
    }
    if let Some(b) = bundled_dsh() {
        return Ok(b);
    }
    if let Some(p) = which("dsh") {
        if let Ok(c) = std::fs::canonicalize(&p) {
            if c.is_file() {
                return Ok(c);
            }
        }
        if p.is_file() {
            return Ok(p);
        }
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        if !home.as_os_str().is_empty() {
            if let Some(p) = newest_matching(&home.join(".npm/_npx"), "node_modules/@deepseek-ai/dsh/lib/bin.js") {
                return Ok(p);
            }
            if let Some(p) = newest_matching(&home.join(".npm/_npx"), "node_modules/.bin/dsh") {
                if let Ok(c) = std::fs::canonicalize(&p) {
                    if c.is_file() {
                        return Ok(c);
                    }
                }
            }
        }
    }
    Err("dsh 未找到 — App 内置运行时缺失，或请设置 dsh 路径".into())
}

/// PATH for the child: bundled runtime bins first, then the current env, then
/// common tool dirs so dsh's subprocesses (node-pty, npm, pnpm) resolve.
pub fn child_path() -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut dirs: Vec<String> = Vec::new();
    if let Some(root) = runtime_root() {
        let nd = root.join(node_dir_name());
        #[cfg(windows)]
        dirs.push(nd.display().to_string());
        #[cfg(not(windows))]
        dirs.push(nd.join("bin").display().to_string());
        dirs.push(root.join("dsh").join("node_modules").join(".bin").display().to_string());
    }
    if let Ok(p) = std::env::var("PATH") {
        dirs.extend(p.split(sep).map(|s| s.to_string()));
    }
    if cfg!(windows) {
        // keep the system dirs reachable for child processes
        for extra in [
            r"C:\Windows\System32",
            r"C:\Windows",
            r"C:\Windows\System32\WindowsPowerShell\v1.0",
        ] {
            if !dirs.iter().any(|d| d == extra) {
                dirs.push(extra.to_string());
            }
        }
    } else {
        for extra in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            if !dirs.iter().any(|d| d == extra) {
                dirs.push(extra.to_string());
            }
        }
    }
    dirs.join(sep)
}
