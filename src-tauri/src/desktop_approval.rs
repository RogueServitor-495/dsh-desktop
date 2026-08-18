//! Desktop approval popup: when the embedded DSH UI needs a permission approval,
//! a small always-on-top window lets the user allow/reject without hunting for
//! the approval in the main window.
//!
//! A tiny bridge script injected into the "gui" webview watches the DSH UI's
//! approval panel (root carries data-approval-key) and signals Rust; Rust
//! shows the popup, and the popup's buttons route the decision back to the
//! bridge, which clicks the real Allow/Reject button in the DSH UI.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Injected into the DSH UI page (loading.html and the runtime UI): watches for
/// a pending approval panel and relays it to/from Rust. Idempotent.
const BRIDGE_JS: &str = r#"(function () {
  if (window.__dshApprovalBridge) return;
  if (!window.__TAURI__ || !window.__TAURI__.event) return; // retry on next injection
  window.__dshApprovalBridge = true;
  var KEY = '[data-approval-key]';
  var last = null;
  var lastTheme = null;
  function panel() { return document.querySelector(KEY); }
  function emit(name, payload) {
    try {
      if (window.__TAURI__ && window.__TAURI__.event) window.__TAURI__.event.emit(name, payload || {});
    } catch (e) {}
  }
  setInterval(function () {
    var el = panel();
    var key = el ? (el.getAttribute('data-approval-key') || 'approval') : null;
    if (key && key !== last) {
      last = key;
      var headline = (el.querySelector('[class*="headline"]') || {}).textContent || '';
      var command = (el.querySelector('[class*="command"]') || {}).textContent || '';
      emit('approval-pending', { key: key, headline: headline, command: command });
    } else if (!key && last) {
      last = null;
      emit('approval-resolved', {});
    }
    // Follow the DSH light/dark theme (body[data-ds-dark-theme]); emit on change
    // (lastTheme starts null so the current theme is reported once on load).
    var dark = !!(document.body && document.body.hasAttribute('data-ds-dark-theme'));
    if (dark !== lastTheme) {
      lastTheme = dark;
      emit('dsh-theme', { dark: dark });
    }
  }, 400);
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('approval-answer', function (e) {
      var el = panel();
      if (!el) return;
      var outcome = e.payload && e.payload.outcome;
      var buttons = Array.prototype.slice.call(el.querySelectorAll('button'));
      var target = null;
      for (var i = 0; i < buttons.length; i++) {
        var t = (buttons[i].textContent || '').trim();
        if (outcome === 'allowed-once' && /允许一次|allow once/i.test(t)) target = buttons[i];
        if (outcome === 'rejected' && /拒绝|reject/i.test(t)) target = buttons[i];
      }
      if (!target && buttons.length) {
        // ApprovalPanel action row: reject first, allow (primary) last.
        target = outcome === 'rejected' ? buttons[0] : buttons[buttons.length - 1];
      }
      if (target && !target.disabled) target.click();
    });
  }
})();"#;

/// Set up the bridge injection loop and the popup event wiring.
pub fn wire(app: &AppHandle) {
    // Re-inject the bridge into the gui webview periodically: page navigations
    // (loading.html -> runtime UI) wipe globals, and eval is idempotent.
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            if let Some(gui) = app.get_webview_window("gui") {
                let _ = gui.eval(BRIDGE_JS);
            }
            std::thread::sleep(Duration::from_millis(1200));
        });
    }
    // An approval appeared in the DSH UI -> show the popup.
    {
        let app = app.clone();
        app.clone().listen("approval-pending", move |event| {
            // tauri::Event::payload() returns &str directly (2.x)
            let value = serde_json::from_str::<Value>(event.payload()).unwrap_or_else(|_| json!({}));
            let _ = show_popup(&app, value);
        });
    }
    // The approval was resolved in the DSH UI -> hide the popup.
    {
        let app = app.clone();
        app.clone().listen("approval-resolved", move |_event| hide_popup(&app));
    }
    // Popup auto-timeout -> just hide.
    {
        let app = app.clone();
        app.clone().listen("approval-popup-timeout", move |_event| hide_popup(&app));
    }
    // DSH light/dark theme -> popup, so the popup follows the DSH setting.
    {
        let app = app.clone();
        app.clone().listen("dsh-theme", move |event| {
            let value = serde_json::from_str::<Value>(event.payload()).unwrap_or_else(|_| json!({}));
            if let Some(popup) = app.get_webview_window("approval-popup") {
                let _ = popup.emit("approval-popup-theme", value);
            }
        });
    }
    // Popup buttons -> forward the decision to the gui webview's bridge and
    // bring the DSH window to the front so the user sees it settle.
    {
        let app = app.clone();
        app.clone().listen("approval-popup-answer", move |event| {
            // tauri::Event::payload() returns &str directly (2.x)
            let value = serde_json::from_str::<Value>(event.payload()).unwrap_or_else(|_| json!({}));
            if let Some(gui) = app.get_webview_window("gui") {
                let _ = gui.emit("approval-answer", value);
                let _ = gui.show();
                let _ = gui.set_focus();
            }
            hide_popup(&app);
        });
    }
}

fn ensure_popup(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("approval-popup") {
        return Some(w);
    }
    WebviewWindowBuilder::new(app, "approval-popup", WebviewUrl::App("approval.html".into()))
        .title("需要审批")
        .inner_size(400.0, 230.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .ok()
}

/// Place the popup at the bottom-right of the monitor the main DSH window is
/// on (16px margin), so it does not sit at the default top-left.
fn position_bottom_right(app: &AppHandle, w: &WebviewWindow) {
    let monitor = app
        .get_webview_window("gui")
        .and_then(|g| g.current_monitor().ok().flatten())
        .or_else(|| w.current_monitor().ok().flatten());
    if let Some(mon) = monitor {
        let msize = *mon.size();
        let scale = mon.scale_factor();
        let wsize = w.outer_size().unwrap_or_default();
        let margin = (16.0 * scale) as i32;
        let x = (msize.width as i32 - wsize.width as i32 - margin).max(0);
        let y = (msize.height as i32 - wsize.height as i32 - margin).max(0);
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

fn show_popup(app: &AppHandle, value: Value) -> Result<(), String> {
    let w = ensure_popup(app).ok_or("cannot create approval popup window")?;
    position_bottom_right(app, &w);
    let _ = w.emit("approval-popup-data", value);
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

fn hide_popup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("approval-popup") {
        let _ = w.hide();
    }
}
