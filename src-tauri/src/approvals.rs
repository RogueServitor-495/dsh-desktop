//! Kernel-level approval stream.
//!
//! The embedded DSH UI only renders its approval panel for the conversation
//! currently on screen, so a pending approval in a background conversation
//! never reached the desktop popup. This module watches the kernel directly:
//! `GET /api/events.mux` (a downlink WebSocket) broadcasts `approval/requested` /
//! `approval/resolved` frames for every session no matter what the UI
//! shows (and replays still-pending ones on connect), while
//! `POST /api/respond` settles a pending approval by its envelope rpcId.
//! The DOM bridge in desktop_approval.rs stays as the display and fallback
//! path for approvals whose panel is actually visible.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::{desktop_approval, AppState};

/// One approval known to the desktop, from the kernel stream, the DOM bridge,
/// or both. Keyed by the shared identity `a:<rpcId>`: the kernel's pending
/// rpcId, which the DSH UI also renders as data-approval-key.
#[derive(Clone)]
struct Entry {
    key: String,
    rpc_id: Option<String>,
    session_id: Option<String>,
    approval_id: Option<String>,
    headline: String,
    command: String,
}

static PENDING: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

fn pending_lock() -> std::sync::MutexGuard<'static, Vec<Entry>> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

fn current_lock() -> std::sync::MutexGuard<'static, Option<String>> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner())
}

fn port_of(app: &AppHandle) -> Option<u16> {
    let state = app.try_state::<AppState>()?;
    let core = state.core.lock().unwrap_or_else(|e| e.into_inner());
    Some(core.port)
}

fn popup_payload(entry: &Entry) -> Value {
    json!({ "key": entry.key, "headline": entry.headline, "command": entry.command })
}

/// Background thread: keep one downlink WebSocket to the kernel's mux stream
/// and surface every approval frame as a desktop event. Reconnects until exit.
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        let opened = port_of(&app).and_then(|p| open_ws(p).ok());
        match opened {
            Some(mut conn) => {
                // A reconnect's replay re-adds still-pending approvals, so any
                // kernel-sourced entry is dropped first: approvals that
                // resolved while the stream was down must not linger.
                prune_kernel_entries(&app);
                run_ws(&app, &mut conn);
                // Kernel restarting or stream dropped: back off briefly.
                std::thread::sleep(Duration::from_millis(800));
            }
            None => std::thread::sleep(Duration::from_millis(1500)),
        }
    });
}

/// Drop kernel-tracked entries before a replay and clear the popup when its
/// approval no longer has kernel backing.
fn prune_kernel_entries(app: &AppHandle) {
    {
        let mut g = pending_lock();
        g.retain(|e| e.approval_id.is_none());
    }
    let stale = match &*current_lock() {
        Some(k) => !pending_lock().iter().any(|e| &e.key == k),
        None => false,
    };
    if stale {
        *current_lock() = None;
        desktop_approval::hide_popup(app);
    }
}

/// One downlink WebSocket to the kernel's mux stream. Frames arrive as
/// text messages shaped exactly like the SSE envelope:
/// `{type:"server-request", rpcId, method, payload}`. The socket is
/// downlink-only: any client frame makes the server close it (1008), so
/// nothing is ever sent except a protocol-required Pong.
struct WsConn {
    stream: TcpStream,
    acc: Vec<u8>,
}

/// 16 random bytes via a time/address-seeded LCG (no external crates).
fn ws_key_seed() -> [u8; 16] {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15);
    let stack = &nanos as *const u64 as u64;
    let mut state = nanos ^ stack.rotate_left(17) ^ 0xA0761D6478BD642F;
    let mut key = [0u8; 16];
    for byte in key.iter_mut() {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *byte = (state >> 33) as u8;
    }
    key
}

/// Standard base64 of 16 bytes (24 chars, padded) for Sec-WebSocket-Key.
fn base64_16(bytes: &[u8; 16]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(24);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Open the downlink: HTTP/1.1 Upgrade handshake, then keep the raw socket.
fn open_ws(port: u16) -> Result<WsConn, String> {
    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;
    let mut stream = stream;
    let key = base64_16(&ws_key_seed());
    let request = format!(
        "GET /api/events.mux HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("closed during websocket handshake".into());
        }
        head.push_str(&line);
        if line == "\r\n" || line == "\n" {
            break;
        }
    }
    if !head.lines().next().map(|l| l.contains(" 101")).unwrap_or(false) {
        return Err(format!("websocket handshake: {}", head.lines().next().unwrap_or("").trim_end()));
    }
    Ok(WsConn {
        stream: reader.into_inner(),
        acc: Vec::new(),
    })
}

impl WsConn {
    /// Pull more bytes from the socket into the accumulator. Read timeouts
    /// are normal quiet-idle, reported as Ok(false).
    fn fill(&mut self) -> Result<bool, String> {
        let mut chunk = [0u8; 8192];
        match self.stream.read(&mut chunk) {
            Ok(0) => Err("closed".into()),
            Ok(n) => {
                self.acc.extend_from_slice(&chunk[..n]);
                Ok(true)
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                Ok(false)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    /// Try to take one complete frame from the accumulator.
    fn take_frame(&mut self) -> Option<(u8, Vec<u8>)> {
        if self.acc.len() < 2 {
            return None;
        }
        let b0 = self.acc[0];
        let b1 = self.acc[1];
        let masked = b1 & 0x80 != 0;
        let len7 = (b1 & 0x7F) as usize;
        let (len, header) = if len7 < 126 {
            (len7, 2usize)
        } else if len7 == 126 {
            if self.acc.len() < 4 {
                return None;
            }
            ((((self.acc[2] as usize) << 8) | self.acc[3] as usize), 4)
        } else {
            if self.acc.len() < 10 {
                return None;
            }
            let mut len = 0usize;
            for i in 2..10 {
                len = (len << 8) | self.acc[i] as usize;
            }
            (len, 10)
        };
        let mask_len = if masked { 4 } else { 0 };
        if self.acc.len() < header + mask_len + len {
            return None;
        }
        let mut payload: Vec<u8> = self.acc[header + mask_len..header + mask_len + len].to_vec();
        if masked {
            let mask = &self.acc[header..header + 4];
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[i % 4];
            }
        }
        self.acc.drain(..header + mask_len + len);
        Some((b0 & 0x0F, payload))
    }

    /// Send one masked client frame (Pong / Close only).
    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), String> {
        let mut frame = vec![0x80 | opcode];
        let len = payload.len();
        if len < 126 {
            frame.push(0x80 | len as u8);
        } else if len <= 0xFFFF {
            frame.push(0x80 | 126);
            frame.push((len >> 8) as u8);
            frame.push(len as u8);
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        let seed = ws_key_seed();
        frame.extend_from_slice(&seed);
        for (i, byte) in payload.iter().enumerate() {
            frame.push(byte ^ seed[i % 4]);
        }
        self.stream.write_all(&frame).map_err(|e| e.to_string())?;
        self.stream.flush().map_err(|e| e.to_string())
    }
}

/// Consume WebSocket frames until the stream dies, dispatching text frames.
fn run_ws(app: &AppHandle, conn: &mut WsConn) {
    let mut fragmented: Vec<u8> = Vec::new();
    loop {
        // Need at least one more byte; fill() also absorbs quiet-idle timeouts.
        match conn.fill() {
            Ok(true) | Ok(false) => {}
            Err(_) => return,
        }
        while let Some((opcode, payload)) = conn.take_frame() {
            match opcode {
                0x1 | 0x2 => {
                    // The kernel sends one unfragmented frame per message.
                    let mut text = payload;
                    if !fragmented.is_empty() {
                        let mut whole = std::mem::take(&mut fragmented);
                        whole.extend_from_slice(&text);
                        text = whole;
                    }
                    let body = String::from_utf8_lossy(&text).to_string();
                    handle_ws_message(app, &body);
                }
                0x0 => {
                    // Continuation frame: accumulate until a fin text arrives
                    // (the kernel never fragments; defensive only).
                    fragmented.extend_from_slice(&payload);
                    if let Ok(body) = String::from_utf8(fragmented.clone()) {
                        fragmented.clear();
                        handle_ws_message(app, &body);
                    }
                }
                0x8 => return, // close
                0x9 => {
                    // Ping -> Pong (masked, downlink-only socket stays clean).
                    if conn.send_frame(0xA, &payload).is_err() {
                        return;
                    }
                }
                _ => {}
            }
        }
    }
}

/// One WS text message = a ServerRequest envelope; dispatch approval frames.
fn handle_ws_message(app: &AppHandle, data: &str) {
    let v: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("server-request") {
        return;
    }
    let rpc_id = v
        .get("rpcId")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    let payload = match v.get("payload") {
        Some(p) => p.clone(),
        None => return,
    };
    match payload.get("type").and_then(|t| t.as_str()) {
        Some("approval/requested") => {
            let key = format!("a:{rpc_id}");
            let tool = payload.get("toolName").and_then(|t| t.as_str()).unwrap_or("");
            let reason = payload.get("reason").and_then(|t| t.as_str()).unwrap_or("");
            let headline = if !reason.is_empty() {
                reason.to_string()
            } else if !tool.is_empty() {
                format!("需要审批：{tool}")
            } else {
                "DSH 需要审批".to_string()
            };
            let _ = app.emit(
                "approval-pending",
                json!({
                    "key": key,
                    "rpcId": rpc_id,
                    "sessionId": payload.get("sessionId"),
                    "approvalId": payload.get("approvalId"),
                    "headline": headline,
                    "command": ""
                }),
            );
        }
        Some("approval/resolved") => {
            let _ = app.emit("approval-kernel-resolved", payload);
        }
        _ => {}
    }
}

/// Track an approval reported by either source (kernel stream or DOM bridge)
/// and show the popup when nothing else is being shown.
pub fn report_pending(app: &AppHandle, value: Value) {
    let key = match value.get("key").and_then(|k| k.as_str()) {
        Some(k) if !k.is_empty() => k.to_string(),
        _ => return,
    };
    let rpc_id = value
        .get("rpcId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| key.strip_prefix("a:").map(str::to_string));
    let session_id = value.get("sessionId").and_then(|v| v.as_str()).map(str::to_string);
    let approval_id = value.get("approvalId").and_then(|v| v.as_str()).map(str::to_string);
    let headline = value
        .get("headline")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let command = value
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Upsert; keep richer text a previous report may already have carried.
    {
        let mut g = pending_lock();
        if let Some(slot) = g.iter_mut().find(|e| e.key == key) {
            if !headline.is_empty() {
                slot.headline = headline;
            }
            if !command.is_empty() {
                slot.command = command;
            }
            if session_id.is_some() {
                slot.session_id = session_id.clone();
            }
            if approval_id.is_some() {
                slot.approval_id = approval_id.clone();
            }
            if rpc_id.is_some() {
                slot.rpc_id = rpc_id.clone();
            }
        } else {
            g.push(Entry {
                key: key.clone(),
                rpc_id,
                session_id,
                approval_id,
                headline,
                command,
            });
        }
    }
    let show = match &*current_lock() {
        None => true,
        Some(k) => k == &key,
    };
    if show {
        let entry = pending_lock().iter().find(|e| e.key == key).cloned();
        *current_lock() = Some(key);
        if let Some(entry) = entry {
            let _ = desktop_approval::show_popup(app, popup_payload(&entry));
        }
    }
}

/// Kernel `approval/resolved`: the exact pending entry is known, so remove it
/// and advance when it owned the popup.
pub fn report_kernel_resolved(app: &AppHandle, value: Value) {
    let approval_id = match value.get("approvalId").and_then(|v| v.as_str()) {
        Some(a) => a.to_string(),
        None => return,
    };
    let session_id = value.get("sessionId").and_then(|v| v.as_str()).map(str::to_string);
    let removed = {
        let mut g = pending_lock();
        let pos = g.iter().position(|e| {
            e.approval_id.as_deref() == Some(approval_id.as_str())
                && (session_id.is_none() || e.session_id == session_id)
        });
        pos.map(|i| g.remove(i).key)
    };
    if let Some(key) = removed {
        advance_if_current(app, &key);
    }
}

/// The DSH UI's approval panel went away (answered there or through the
/// popup): hide and surface the next pending approval, if any.
pub fn report_bridge_resolved(app: &AppHandle) {
    *current_lock() = None;
    desktop_approval::hide_popup(app);
    show_next(app);
}

/// Popup dismissed without an answer (timeout / dead fallback path): hide but
/// do not chain into the next one.
pub fn report_popup_closed(app: &AppHandle) {
    *current_lock() = None;
    desktop_approval::hide_popup(app);
}

/// Answer the currently shown approval against the kernel
/// (`POST /api/respond`). Returns true when no DOM-click fallback is needed:
/// accepted means the kernel settled it; not-pending means it was answered
/// elsewhere or the entry is stale — either way the entry is dropped.
pub fn answer_current(app: &AppHandle, outcome: &str) -> bool {
    if outcome != "allowed-once" && outcome != "rejected" {
        return false;
    }
    let key = match &*current_lock() {
        Some(k) => k.clone(),
        None => return false,
    };
    let entry = pending_lock().iter().find(|e| e.key == key).cloned();
    let entry = match entry {
        Some(e) => e,
        None => return false,
    };
    let (rpc_id, session_id, approval_id) = match (&entry.rpc_id, &entry.session_id, &entry.approval_id) {
        (Some(r), Some(s), Some(a)) => (r.clone(), s.clone(), a.clone()),
        _ => return false,
    };
    let port = match port_of(app) {
        Some(p) => p,
        None => return false,
    };
    match http_respond(port, &rpc_id, &session_id, &approval_id, outcome) {
        Ok(_) => {
            {
                let mut g = pending_lock();
                g.retain(|e| e.key != key);
            }
            *current_lock() = None;
            desktop_approval::hide_popup(app);
            show_next(app);
            true
        }
        // Kernel unreachable: let the bridge click the real panel instead.
        Err(_) => false,
    }
}

fn advance_if_current(app: &AppHandle, key: &str) {
    let was_current = {
        let c = current_lock();
        c.as_deref() == Some(key)
    };
    if was_current {
        *current_lock() = None;
        desktop_approval::hide_popup(app);
        show_next(app);
    }
}

fn show_next(app: &AppHandle) {
    let next = pending_lock().first().cloned();
    if let Some(entry) = next {
        *current_lock() = Some(entry.key.clone());
        let _ = desktop_approval::show_popup(app, popup_payload(&entry));
    }
}

/// POST the client-response envelope the kernel's pending table routes by.
fn http_respond(
    port: u16,
    rpc_id: &str,
    session_id: &str,
    approval_id: &str,
    outcome: &str,
) -> Result<bool, String> {
    let body = json!({
        "type": "client-response",
        "rpcId": rpc_id,
        "result": {
            "ok": true,
            "value": {
                "sessionId": session_id,
                "approvalId": approval_id,
                "outcome": outcome
            }
        }
    })
    .to_string();
    let reply = http_request(port, "POST", "/api/respond", Some(&body))?;
    let v: Value =
        serde_json::from_str(reply.trim()).map_err(|e| format!("bad respond reply: {e}"))?;
    Ok(v.get("accepted").and_then(|a| a.as_bool()).unwrap_or(false))
}

/// Minimal HTTP/1.0 client over a raw TcpStream: close-delimited bodies, no
/// chunk decoding needed on this path, no new dependencies.
fn http_request(port: u16, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let mut stream = stream;
    let mut request = format!("{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(b) = body {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", b.as_bytes().len()));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    if let Some(b) = body {
        stream.write_all(b.as_bytes()).map_err(|e| e.to_string())?;
    }
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let sep = text
        .find("\r\n\r\n")
        .map(|i| i + 4)
        .or_else(|| text.find("\n\n").map(|i| i + 2))
        .ok_or_else(|| "malformed http response".to_string())?;
    let status_ok = text.lines().next().map(|l| l.contains(" 200")).unwrap_or(false);
    if !status_ok {
        return Err(format!("http status: {}", text.lines().next().unwrap_or("")));
    }
    Ok(text[sep..].to_string())
}