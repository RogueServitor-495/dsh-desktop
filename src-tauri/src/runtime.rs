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
        }
    }
}

/// Send a graceful-stop signal to a process tree.
/// Unix: SIGTERM to the process group (dsh's graceful-drain contract).
/// Windows: taskkill without /F (best effort; Windows has no POSIX signals).
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
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .output();
    }
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
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
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

impl RuntimeCore {
    pub fn push_line(&mut self, line: String) {
        let line = strip_ansi(&line);
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

/// Find an orphaned dsh runtime process (not spawned by this app) bound to the port.
/// Matches the current spawn form (--profile X --port N) and legacy (web --port N).
pub fn external_pid(port: u16) -> Option<u32> {
    #[cfg(windows)]
    {
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object {{ $_.CommandLine -like '*lib/bin.js*' -and $_.CommandLine -like '*--port {port}*' }} | Select-Object -First 1 -ExpandProperty ProcessId"
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        return String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| l.trim().parse::<u32>().ok());
    }
    #[cfg(not(windows))]
    {
        let pattern = format!("lib/bin.js.*--port {port}");
        let out = std::process::Command::new("pgrep")
            .args(["-f", &pattern])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .and_then(|l| l.trim().parse::<u32>().ok())
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
    let node = paths::detect_node(settings.node_path.as_deref())?;
    let dsh = paths::detect_dsh(settings.dsh_bin.as_deref())?;

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
    let args = build_launch_args(settings, port)?;
    let mut cmd = Command::new(&node);
    cmd.arg(&dsh).args(&args);
    let overlay = crate::plugins::overlay_path(&settings.profile);
    if overlay.is_file() {
        g.push_line(format!("[manager] plugin overlay: {}", overlay.display()));
    }
    cmd.current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", paths::child_path());
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

    // readiness watcher
    let c3 = core.clone();
    let app2 = app.clone();
    let h3 = std::thread::spawn(move || {
        loop {
            {
                let g = c3.lock().unwrap();
                if g.child.is_none() {
                    return;
                }
            }
            if tcp_ok(port) {
                let status = {
                    let mut g = c3.lock().unwrap();
                    if g.ready {
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
pub fn build_launch_args(settings: &Settings, port: u16) -> Result<Vec<String>, String> {
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
    let (pid, pgid) = {
        let g = core.lock().unwrap();
        match g.child.as_ref() {
            Some(ch) => (ch.pid, ch.pgid),
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
