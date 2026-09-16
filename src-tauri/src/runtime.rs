//! Supervises the dsh runtime child process: spawn, graceful stop, restart,
//! log capture (ring buffer + file), readiness detection and status events.
use crate::paths;
use crate::settings::Settings;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const RING_CAP: usize = 4000;
const MAX_LINE_CHARS: usize = 4000;
const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(15);
const READY_POLL: Duration = Duration::from_millis(500);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub running: bool,
    pub phase: String,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub uptime_secs: Option<u64>,
    pub last_exit: Option<i32>,
    pub port: u16,
    pub ready: bool,
    /// Launch token parsed from the kernel's startup URL, or None on kernels
    /// that print a bare URL (before browser-session auth). The UI uses it to
    /// open the GUI; it is a session credential and is never logged.
    pub launch_token: Option<String>,
    pub log_file: String,
    pub log_seq: u64,
}

pub struct ChildHandle {
    pub pid: u32,
    pub pgid: i32,
    pub child: Child,
    readers: Vec<std::thread::JoinHandle<()>>,
    waiter: Option<std::thread::JoinHandle<()>>,
    ready_watcher: Option<std::thread::JoinHandle<()>>,
}

pub struct RuntimeCore {
    pub child: Option<ChildHandle>,
    /// Adopted external runtime (pid) — a dsh web this app did not spawn but
    /// found serving the port (orphan resume). Kept so the UI shows it as
    /// running and Stop/restart work on it.
    pub external: Option<u32>,
    pub phase: String,
    pub started_at: Option<Instant>,
    pub wall_started_at: Option<SystemTime>,
    pub last_exit: Option<i32>,
    pub ring: VecDeque<(u64, String)>,
    pub seq: u64,
    pub log_file: Option<PathBuf>,
    pub log_handle: Option<std::fs::File>,
    pub port: u16,
    pub ready: bool,
    /// Browser-session launch token captured from the child's startup URL
    /// (`dsh web: http://127.0.0.1:<port>/?token=<token>`). Kernels before
    /// 0.1.2-rc.1 print no token, so this stays None and every consumer falls
    /// back to the bare URL. Held in memory only: it must never reach the ring
    /// buffer, the log file, or the process command line.
    pub launch_token: Option<String>,
}

impl Default for RuntimeCore {
    fn default() -> Self {
        RuntimeCore {
            child: None,
            external: None,
            phase: "stopped".into(),
            started_at: None,
            wall_started_at: None,
            last_exit: None,
            ring: VecDeque::new(),
            seq: 0,
            log_file: None,
            log_handle: None,
            port: crate::settings::DEFAULT_PORT,
            ready: false,
            launch_token: None,
        }
    }
}

/// Send a graceful-stop signal to a process tree.
/// Unix: SIGTERM to the process group (dsh's graceful-drain contract).
/// Windows: taskkill /T without /F first (best effort graceful — only works on
/// windowed processes), then /F as a hard fallback after a short grace, because
/// the bundled node is a windowless console process that ignores WM_CLOSE.
fn signal_terminate(pid: u32, pgid: i32) {
    #[cfg(unix)]
    {
        unsafe {
            if libc::kill(-pgid, libc::SIGTERM) != 0 {
                let _ = libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = pgid; // no process groups on Windows; taskkill /T covers the tree
        // Graceful attempt.
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T"]);
        crate::paths::hide_console(&mut cmd);
        let _ = cmd.output();
        // Give a windowed target a moment to close; windowless node ignores the
        // WM_CLOSE and needs /F. Poll briefly instead of sleeping blindly.
        let deadline = Instant::now() + Duration::from_millis(1800);
        while Instant::now() < deadline {
            if !pid_alive(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        // Hard kill fallback.
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        crate::paths::hide_console(&mut cmd);
        let _ = cmd.output();
    }
}

/// Windows: is a process with this PID alive? (tasklist is cheap and
/// avoids needing admin rights to read the process table.)
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    if let Ok(proc) = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
    {
        let text = String::from_utf8_lossy(&proc.stdout);
        return text.contains(&pid.to_string()) && !text.contains("INFO: No tasks");
    }
    false
}

/// Force-kill a process tree after the graceful deadline.
/// Unix: SIGKILL to the process group. Windows: taskkill /T /F.
fn force_kill_tree(pid: u32, pgid: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
        let _ = libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = pgid;
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        crate::paths::hide_console(&mut cmd);
        let _ = cmd.output();
    }
}

/// Strip ANSI escape sequences so the log view stays clean.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c2) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Split one kernel output line into its loggable form and the launch token it
/// carried. The token is a browser-session credential: the redacted form is
/// what reaches the ring buffer, the log file and the UI, so `?token=<secret>`
/// never survives into `runtime.log`.
///
/// Hand-rolled on purpose — the crate set has no regex dependency.
fn take_launch_token(line: &str) -> (String, Option<String>) {
    /// Query parameter the web app appends to its startup URL.
    const MARK: &str = "?token=";
    /// Shortest value treated as a real token; the kernel mints 32 random
    /// bytes as base64url (43 chars), so this only filters noise.
    const MIN_LEN: usize = 20;
    let Some(at) = line.find(MARK) else {
        return (line.to_string(), None);
    };
    let start = at + MARK.len();
    let value: String = line[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if value.is_empty() {
        return (line.to_string(), None);
    }
    let mut redacted = String::with_capacity(line.len());
    redacted.push_str(&line[..start]);
    redacted.push_str("***");
    redacted.push_str(&line[start + value.len()..]);
    let token = if value.len() >= MIN_LEN { Some(value) } else { None };
    (redacted, token)
}

impl RuntimeCore {
    pub fn push_line(&mut self, line: String) {
        let line = strip_ansi(&line);
        let (line, token) = take_launch_token(&line);
        if let Some(t) = token {
            self.launch_token = Some(t);
        }
        let line: String = line.chars().take(MAX_LINE_CHARS).collect();
        if line.trim().is_empty() {
            return;
        }
        self.seq += 1;
        self.ring.push_back((self.seq, line.clone()));
        while self.ring.len() > RING_CAP {
            self.ring.pop_front();
        }
        if let Some(f) = self.log_handle.as_mut() {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    }
}

pub fn snapshot(g: &RuntimeCore) -> StatusInfo {
    StatusInfo {
        running: g.child.is_some() || g.external.is_some(),
        phase: g.phase.clone(),
        pid: g.child.as_ref().map(|c| c.pid).or(g.external),
        started_at: g
            .wall_started_at
            .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()),
        uptime_secs: g.started_at.map(|t| t.elapsed().as_secs()),
        last_exit: g.last_exit,
        port: g.port,
        ready: g.ready,
        launch_token: g.launch_token.clone(),
        log_file: g
            .log_file
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        log_seq: g.seq,
    }
}

fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let dir = data.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create logs dir: {e}"))?;
    Ok(dir)
}

/// Find an orphaned dsh runtime process (not spawned by this app) bound to the
/// port, by asking the OS who LISTENs on it. More robust than matching a
/// command line: external instances may use a different dsh path or arg form.
/// The owning process must look like node/dsh so we never adopt an unrelated
/// listener on the same port.
pub fn external_pid(port: u16) -> Option<u32> {
    let pids = external_pids_on_port(port);
    pids.into_iter().find(|&pid| looks_like_dsh_process(pid))
}

/// PIDs currently LISTENing on the port (Windows: Get-NetTCPConnection,
/// Unix: lsof; both are local, fast queries).
fn external_pids_on_port(port: u16) -> Vec<u32> {
    #[cfg(windows)]
    {
        let script = format!(
            "Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"
        );
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        crate::paths::hide_console(&mut cmd);
        let out = cmd.output();
        let out = match out {
            Ok(o) if o.status.success() => o,
            _ => return Vec::new(),
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .collect()
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
            .output();
        let out = match out {
            Ok(o) if o.status.success() => o,
            _ => return Vec::new(),
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .collect()
    }
}

/// A listening process is a dsh runtime if it is a node (Windows) / node-ish
/// process, i.e. an Electron-style launcher would not be adopted by accident.
fn looks_like_dsh_process(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let script = format!(
            "(Get-Process -Id {pid} -ErrorAction SilentlyContinue).ProcessName"
        );
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        crate::paths::hide_console(&mut cmd);
        let out = cmd.output();
        let out = match out {
            Ok(o) if o.status.success() => o,
            _ => return false,
        };
        let name = String::from_utf8_lossy(&out.stdout).trim().to_lowercase();
        name == "node" || name == "node.exe" || name.ends_with("node")
    }
    #[cfg(not(windows))]
    {
        let Ok(meta) = std::fs::read_link(format!("/proc/{pid}/exe")) else {
            return false;
        };
        let name = meta.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
        name.contains("node")
    }
}

fn tcp_ok(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
        let _ = s.set_read_timeout(Some(Duration::from_millis(400)));
        let _ = s.write_all(b"GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
        let mut buf = [0u8; 256];
        let _ = s.read(&mut buf);
        true
    } else {
        false
    }
}

pub fn start(app: &AppHandle, core: &Arc<Mutex<RuntimeCore>>, settings: &Settings) -> Result<u32, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let node = paths::detect_node(settings.node_path.as_deref())?;
    let dsh = paths::detect_dsh(settings.dsh_bin.as_deref(), settings.kernel.as_deref(), &data_dir)?;

    let mut g = core.lock().unwrap();
    if g.child.is_some() {
        return Err("runtime is already running".into());
    }
    let port = settings.port;
    if let Some(pid) = external_pid(port) {
        // Client model: a dsh web already serves this port (e.g. orphaned by a
        // previous app instance) — adopt it as "running" instead of failing, so
        // reopening the app resumes the live session. The runtime stays
        // untouched; Stop/restart operate on it via the external path.
        let ready = tcp_ok(port);
        g.external = Some(pid);
        g.port = port;
        g.phase = if ready { "running".into() } else { "starting".into() };
        g.ready = ready;
        // Adopted runtimes are not our child, so their stdout never reached us:
        // no token can be captured here. Clear any stale one from a previous run.
        g.launch_token = None;
        g.started_at = Some(Instant::now());
        g.wall_started_at = Some(SystemTime::now());
        g.last_exit = None;
        g.push_line(format!("[manager] adopted existing runtime pid {pid} on port {port}"));
        let status_snap = snapshot(&g);
        drop(g);
        let _ = app.emit("runtime-status", status_snap);
        return Ok(pid);
    }
    let workspace = settings.workspace.clone();
    g.port = port;
    g.phase = "starting".into();
    g.started_at = Some(Instant::now());
    g.wall_started_at = Some(SystemTime::now());
    g.last_exit = None;
    g.ready = false;
    g.launch_token = None;

    let log_path = logs_dir(app)?.join("runtime.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open log: {e}"))?;
    g.log_file = Some(log_path.clone());
    g.log_handle = Some(log_file);
    g.push_line(format!(
        "[manager] starting dsh profile '{}' on port {port}, workspace {workspace}",
        settings.profile
    ));

    // build launch args (validated, shared with the UI preview)
    let args = build_launch_args(settings, port, Some(&dsh))?;
    let mut cmd = Command::new(&node);
    cmd.arg(&dsh).args(&args);
    let overlay = crate::plugins::overlay_path(&settings.profile);
    if overlay.is_file() {
        g.push_line(format!("[manager] plugin overlay: {}", overlay.display()));
    }
    cmd.current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", paths::child_path_for(settings.kernel.as_deref(), &data_dir));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: the closure runs in the forked child right before exec; it only
        // calls setsid() (async-signal-safe) and never touches captured state.
        unsafe {
            cmd.pre_exec(|| {
                // New session: child becomes session leader (pgid == pid), so group
                // signals never leak to unrelated processes.
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Own process group (Ctrl+C won't leak) + no console window on spawn.
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| {
        g.phase = "stopped".into();
        g.started_at = None;
        g.wall_started_at = None;
        format!("failed to spawn dsh: {e}")
    })?;
    let pid = child.id();
    let pgid = pid as i32;
    let out = child.stdout.take().ok_or("no stdout pipe")?;
    let err = child.stderr.take().ok_or("no stderr pipe")?;
    g.child = Some(ChildHandle {
        pid,
        pgid,
        child,
        readers: Vec::new(),
        waiter: None,
        ready_watcher: None,
    });

    // stdout / stderr readers → ring buffer + log file
    let c1 = core.clone();
    let h1 = std::thread::spawn(move || {
        let reader = BufReader::new(out);
        for line in reader.lines() {
            if let Ok(l) = line {
                c1.lock().unwrap().push_line(l);
            }
        }
    });
    let c2 = core.clone();
    let h2 = std::thread::spawn(move || {
        let reader = BufReader::new(err);
        for line in reader.lines() {
            if let Ok(l) = line {
                c2.lock().unwrap().push_line(l);
            }
        }
    });
    let ch = g.child.as_mut().unwrap();
    ch.readers.push(h1);
    ch.readers.push(h2);

    // readiness watcher: only report ready when BOTH the port answers AND the
    // spawned child is still alive — otherwise an orphaned listener on the same
    // port (EADDRINUSE case) would make us claim ready while our child died.
    let c3 = core.clone();
    let app2 = app.clone();
    let h3 = std::thread::spawn(move || {
        loop {
            let (child_alive, child_exit) = {
                let mut g = c3.lock().unwrap();
                match g.child.as_mut() {
                    None => return,
                    Some(ch) => match ch.child.try_wait() {
                        Ok(Some(st)) => (false, Some(st.code())),
                        Ok(None) => (true, None),
                        Err(_) => (false, None),
                    },
                }
            };
            if !child_alive {
                // child exited before ready — stop probing; the exit waiter
                // owns the transition to stopped. Log once for diagnosis.
                let mut g = c3.lock().unwrap();
                if !g.ready && g.phase == "starting" {
                    let code = child_exit
                        .map(|c| c.map(|n| n.to_string()).unwrap_or_else(|| "?".into()))
                        .unwrap_or_else(|| "?".into());
                    g.push_line(format!("[manager] child exited before ready (code {code})"));
                }
                return;
            }
            if tcp_ok(port) {
                let status = {
                    let mut g = c3.lock().unwrap();
                    if g.ready {
                        return;
                    }
                    // double-check the child is still alive (it may have died
                    // between the probe and now)
                    let alive_now = match g.child.as_mut() {
                        Some(ch) => match ch.child.try_wait() {
                            Ok(None) => true,
                            _ => false,
                        },
                        None => false,
                    };
                    if !alive_now {
                        return;
                    }
                    g.ready = true;
                    g.phase = "running".into();
                    g.push_line(format!("[manager] runtime ready at http://127.0.0.1:{port}"));
                    snapshot(&g)
                };
                // emit after releasing the core lock (listeners re-lock it)
                let _ = app2.emit("runtime-status", status);
                return;
            }
            std::thread::sleep(READY_POLL);
        }
    });
    let ch = g.child.as_mut().unwrap();
    ch.ready_watcher = Some(h3);

    // exit waiter: watches for exit, and only during a stop request enforces a
    // graceful-drain deadline before SIGKILLing the group. A healthy long-running
    // runtime is never force-killed.
    let c4 = core.clone();
    let app3 = app.clone();
    let h4 = std::thread::spawn(move || {
        let mut force_deadline: Option<Instant> = None;
        let mut status: Option<std::process::ExitStatus> = None;
        loop {
            let mut exited = false;
            let stopping = {
                let g = c4.lock().unwrap();
                g.phase == "stopping"
            };
            {
                let mut g = c4.lock().unwrap();
                if let Some(ch) = g.child.as_mut() {
                    match ch.child.try_wait() {
                        Ok(Some(st)) => {
                            status = Some(st);
                            exited = true;
                        }
                        Ok(None) => {}
                        Err(_) => {
                            exited = true;
                        }
                    }
                }
            }
            if exited {
                break;
            }
            if stopping && force_deadline.is_none() {
                force_deadline = Some(Instant::now() + GRACEFUL_TIMEOUT);
            }
            if let Some(d) = force_deadline {
                if Instant::now() >= d {
                    force_kill_tree(pid, pgid);
                    std::thread::sleep(Duration::from_millis(400));
                    {
                        let mut g = c4.lock().unwrap();
                        if let Some(ch) = g.child.as_mut() {
                            let _ = ch.child.kill();
                        }
                    }
                    std::thread::sleep(Duration::from_millis(300));
                    {
                        let mut g = c4.lock().unwrap();
                        if let Some(ch) = g.child.as_mut() {
                            if let Ok(Some(st)) = ch.child.try_wait() {
                                status = Some(st);
                            }
                        }
                    }
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let code = status.and_then(|s| s.code());
        let status_snap = {
            let mut g = c4.lock().unwrap();
            g.child = None;
            g.phase = "stopped".into();
            g.started_at = None;
            g.wall_started_at = None;
            g.ready = false;
            g.last_exit = code;
            match code {
                Some(0) => g.push_line("[manager] runtime stopped cleanly".into()),
                Some(c) => g.push_line(format!("[manager] runtime exited with code {c}")),
                None => g.push_line("[manager] runtime exited (no code)".into()),
            }
            snapshot(&g)
        };
        let _ = app3.emit("runtime-status", status_snap);
    });
    let ch = g.child.as_mut().unwrap();
    ch.waiter = Some(h4);

    let status_snap = snapshot(&g);
    drop(g);
    // emit after releasing the core lock (listeners re-lock it)
    let _ = app.emit("runtime-status", status_snap);
    Ok(pid)
}

/// Build the launch arguments for dsh from settings; validates unsafe values.
/// Launcher flags first (--profile/--patch), then web-app flags (--host/--port/--trusted-host).
///
/// `dsh` is the resolved bin.js, used only to gate version-specific flags on the
/// kernel's own capabilities; pass None when the path is unknown.
pub fn build_launch_args(settings: &Settings, port: u16, dsh: Option<&Path>) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    // Launcher-level flags MUST come first: dsh's parser passes through
    // everything after the first token it does not recognize (passThroughOptions),
    // so a web-app flag (--host) before --patch would swallow the overlay flag.
    args.push("--profile".into());
    args.push(settings.profile.clone());
    if settings.host == "0.0.0.0" {
        return Err(
            "--host 0.0.0.0 不被 dsh 支持（安全限制：会把远程代码执行暴露到网络）— 请使用 127.0.0.1，或通过 profile 的 cordis.patch.yml 覆盖 webserver host"
                .into(),
        );
    }
    let overlay = crate::plugins::overlay_path(&settings.profile);
    if overlay.is_file() {
        args.push("--patch".into());
        args.push(overlay.display().to_string());
    }
    // ── web-app level flags below ──
    if !settings.host.is_empty() {
        args.push("--host".into());
        args.push(settings.host.clone());
    }
    args.push("--port".into());
    args.push(port.to_string());
    for h in settings
        .trusted_hosts
        .split([',', ' '])
        .filter(|s| !s.trim().is_empty())
    {
        args.push("--trusted-host".into());
        args.push(h.trim().to_string());
    }
    // Kernels from 0.1.2-rc.1 on open the system browser when they start, which
    // a desktop app never wants; older kernels have no such flag and would
    // reject it, so the capability probe decides.
    if dsh.is_some_and(crate::kernel_caps::supports_browser_auth) {
        args.push("--no-open".into());
    }
    for piece in settings.extra_args.split_whitespace() {
        args.push(piece.to_string());
    }
    Ok(args)
}

/// Human-readable command line for the UI preview.
pub fn command_preview(node: &Path, dsh: &Path, args: &[String]) -> String {
    let mut s = format!("{} {}", node.display(), dsh.display());
    for a in args {
        if a.contains(' ') {
            s.push_str(&format!(" '{}'", a));
        } else {
            s.push(' ');
            s.push_str(a);
        }
    }
    s
}

/// Graceful stop: SIGTERM to the process group (DSH drains and exits 0).
pub fn stop(app: &AppHandle, core: &Arc<Mutex<RuntimeCore>>) -> Result<(), String> {
    let (pid, pgid, child_alive) = {
        let mut g = core.lock().unwrap();
        match g.child.as_mut() {
            Some(ch) => {
                let alive = match ch.child.try_wait() {
                    Ok(None) => true,
                    _ => false,
                };
                (ch.pid, ch.pgid, alive)
            }
            None => {
                let port = g.port;
                drop(g);
                // adopted external runtime, or any orphan serving the port —
                // delegate to the external path so Stop always works
                if external_pid(port).is_some() {
                    return stop_external(app, core, port);
                }
                return Err("runtime is not running".into());
            }
        }
    };
    if !child_alive {
        // The child already exited (e.g. crashed with EADDRINUSE) but we never
        // noticed: stop whatever is serving the port instead, or clean up the
        // stale child handle so the panel reflects the true state.
        let port = {
            let g = core.lock().unwrap();
            g.port
        };
        if external_pid(port).is_some() {
            return stop_external(app, core, port);
        }
        // No orphan on the port — just finalize the stale handle.
        {
            let status_snap = {
                let mut g = core.lock().unwrap();
                g.child = None;
                g.phase = "stopped".into();
                g.started_at = None;
                g.wall_started_at = None;
                g.ready = false;
                g.push_line("[manager] child was already gone; state finalized".into());
                snapshot(&g)
            };
            let _ = app.emit("runtime-status", status_snap);
        }
        return Ok(());
    }
    {
        let status_snap = {
            let mut g = core.lock().unwrap();
            g.phase = "stopping".into();
            g.push_line("[manager] sending SIGTERM (graceful stop)".into());
            snapshot(&g)
        };
        let _ = app.emit("runtime-status", status_snap);
    }
    signal_terminate(pid, pgid);
    Ok(())
}

/// Make sure the log file is open (used when adopting an external runtime).
fn ensure_log(app: &AppHandle, core: &Arc<Mutex<RuntimeCore>>) {
    let mut g = core.lock().unwrap();
    if g.log_handle.is_none() {
        if let Ok(dir) = logs_dir(app) {
            let path = dir.join("runtime.log");
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                g.log_file = Some(path);
                g.log_handle = Some(f);
            }
        }
    }
}

/// Stop an orphaned runtime this app did not spawn (e.g. after an app crash/quit).
pub fn stop_external(app: &AppHandle, core: &Arc<Mutex<RuntimeCore>>, port: u16) -> Result<(), String> {
    let pid = external_pid(port).ok_or_else(|| "no external runtime found on this port".to_string())?;
    ensure_log(app, core);
    {
        let status_snap = {
            let mut g = core.lock().unwrap();
            g.phase = "stopping".into();
            g.push_line(format!("[manager] adopting and stopping external runtime pid {pid}"));
            snapshot(&g)
        };
        let _ = app.emit("runtime-status", status_snap);
    }
    signal_terminate(pid, pid as i32);
    // Wait for the graceful drain to complete.
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if external_pid(port).is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let status_snap = {
        let mut g = core.lock().unwrap();
        g.phase = "stopped".into();
        g.ready = false;
        g.external = None;
        g.started_at = None;
        g.wall_started_at = None;
        match external_pid(port) {
            None => {
                g.push_line("[manager] external runtime stopped".into());
            }
            Some(p) => {
                g.push_line(format!("[manager] external runtime pid {p} ignored SIGTERM — forcing kill"));
                force_kill_tree(p, p as i32);
            }
        }
        snapshot(&g)
    };
    let _ = app.emit("runtime-status", status_snap);
    Ok(())
}

pub fn restart(app: &AppHandle, core: &Arc<Mutex<RuntimeCore>>, settings: &Settings) -> Result<u32, String> {
    let had_runtime = {
        let g = core.lock().unwrap();
        g.child.is_some() || g.external.is_some()
    };
    if had_runtime {
        stop(app, core)?;
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            let running = {
                let g = core.lock().unwrap();
                g.child.is_some() || g.external.is_some()
            };
            if !running {
                break;
            }
            if Instant::now() > deadline {
                return Err("timed out waiting for the runtime to stop".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    start(app, core, settings)
}

pub fn logs_since(core: &Arc<Mutex<RuntimeCore>>, after: u64) -> (u64, Vec<(u64, String)>) {
    let g = core.lock().unwrap();
    let items: Vec<(u64, String)> = g
        .ring
        .iter()
        .filter(|(s, _)| *s > after)
        .cloned()
        .collect();
    let end = items.last().map(|(s, _)| *s).unwrap_or(g.seq);
    (end, items)
}

pub fn clear_logs(core: &Arc<Mutex<RuntimeCore>>) -> u64 {
    let mut g = core.lock().unwrap();
    g.ring.clear();
    if let Some(p) = g.log_file.clone() {
        if let Ok(f) = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&p)
        {
            g.log_handle = Some(f);
        }
    }
    g.seq
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        let mut s = Settings::default();
        s.profile = "test-profile".into();
        s.trusted_hosts = String::new();
        s.extra_args = String::new();
        s
    }

    /// Throwaway kernel tree (`<dir>/lib/bin.js` + `package.json`) so the
    /// capability probe can read a version without a real install.
    fn fake_kernel(version: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-caps-{}-{}",
            std::process::id(),
            version.replace(['.', '-'], "_")
        ));
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!("{{\"name\":\"@deepseek-ai/dsh\",\"version\":\"{version}\"}}"),
        )
        .unwrap();
        let bin = dir.join("lib").join("bin.js");
        std::fs::write(&bin, "").unwrap();
        bin
    }

    /// The exact startup line a 0.1.2-rc.1+ kernel prints.
    const TOKENED_LINE: &str = "dsh web: http://127.0.0.1:3080/?token=Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTBhYmNkZWY";
    const TOKEN: &str = "Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTBhYmNkZWY";

    #[test]
    fn captures_the_launch_token_and_redacts_the_log_line() {
        let (redacted, token) = take_launch_token(TOKENED_LINE);
        assert_eq!(token.as_deref(), Some(TOKEN));
        assert!(!redacted.contains(TOKEN), "token survived redaction: {redacted}");
        assert!(redacted.contains("?token=***"), "redacted: {redacted}");
        assert!(
            redacted.starts_with("dsh web: http://127.0.0.1:3080/"),
            "redaction mangled the line: {redacted}"
        );
    }

    #[test]
    fn push_line_stores_the_token_but_never_logs_it() {
        let mut core = RuntimeCore::default();
        core.push_line(TOKENED_LINE.into());
        assert_eq!(core.launch_token.as_deref(), Some(TOKEN));
        let logged: String = core.ring.iter().map(|(_, l)| l.as_str()).collect();
        assert!(!logged.contains(TOKEN), "token reached the ring buffer: {logged}");
        assert!(logged.contains("?token=***"), "ring: {logged}");
    }

    #[test]
    fn a_bare_url_carries_no_token() {
        let (line, token) = take_launch_token("dsh web: http://127.0.0.1:3080");
        assert!(token.is_none());
        assert_eq!(line, "dsh web: http://127.0.0.1:3080");
    }

    /// A short lookalike is still redacted, but never mistaken for a real token.
    #[test]
    fn short_lookalikes_are_redacted_but_not_stored() {
        let (line, token) = take_launch_token("hint: append ?token=abc to the url");
        assert!(token.is_none());
        assert!(line.contains("?token=***"), "line: {line}");
    }

    #[test]
    fn no_open_is_added_only_for_kernels_that_support_it() {
        let s = settings();
        let new_kernel = fake_kernel("0.1.5-rc.2");
        let old_kernel = fake_kernel("0.1.0-rc.6");
        let with_new = build_launch_args(&s, 3199, Some(&new_kernel)).unwrap();
        let with_old = build_launch_args(&s, 3199, Some(&old_kernel)).unwrap();
        let unknown = build_launch_args(&s, 3199, None).unwrap();
        assert!(
            with_new.iter().any(|a| a == "--no-open"),
            "new kernel should get --no-open: {with_new:?}"
        );
        assert!(
            !with_old.iter().any(|a| a == "--no-open"),
            "old kernel has no such flag and must not receive it: {with_old:?}"
        );
        assert!(
            !unknown.iter().any(|a| a == "--no-open"),
            "unknown kernel must keep the old behaviour: {unknown:?}"
        );
        for args in [&with_new, &with_old, &unknown] {
            assert!(
                args.windows(2).any(|w| w[0] == "--port" && w[1] == "3199"),
                "port flag lost: {args:?}"
            );
        }
        let _ = std::fs::remove_dir_all(new_kernel.parent().unwrap().parent().unwrap());
        let _ = std::fs::remove_dir_all(old_kernel.parent().unwrap().parent().unwrap());
    }
}

