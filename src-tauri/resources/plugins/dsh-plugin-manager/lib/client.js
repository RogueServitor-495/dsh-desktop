window.__ModuleLoader__.load({
	id: "dsh-plugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");

		/** Cordis plugin name — must equal package name, bundle id and settings namespace. */
		var name = "dsh-plugin-manager";
		/** Short service names for the client runtime. */
		var inject = ["slots", "locale"];
		/** Locale namespace — identical to the plugin name (AGENTS.md). */
		var NS = "dsh-plugin-manager";

		var API = {
			state: "/api/plugin-manager/state",
			toggle: "/api/plugin-manager/toggle",
			remove: "/api/plugin-manager/remove",
			import: "/api/plugin-manager/import",
			marketplace: "/api/plugin-manager/marketplace",
			update: "/api/plugin-manager/update",
			switch: "/api/plugin-manager/switch"
		};
		var TOKEN_KEY = "dsh-plugin-manager/token";

		/** Inline SVG icons (stroke = currentColor). */
		var ICON = {
			refresh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
			search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
			plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
			trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
			close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
			plugin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
			chevron: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
			check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
			alert: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
			external: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
			official: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
			package: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
			chip: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
			power: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
			star: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
			download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
			store: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M4 11v9h16v-9"/><line x1="9" y1="20" x2="9" y2="14"/><line x1="15" y1="20" x2="15" y2="14"/></svg>'
		};

		var STYLE_ID = "dsh-plugin-manager/client.css";
		var CSS = [
			/* ── floating action button ─────────────────────────────── */
			".dpm-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 16px;border:none;border-radius:999px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;box-shadow:0 6px 20px rgba(37,99,235,.35),0 1px 3px rgba(0,0,0,.15);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;user-select:none;transition:transform .18s ease,box-shadow .18s ease,filter .18s ease}",
			".dpm-fab:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 10px 28px rgba(37,99,235,.42),0 2px 6px rgba(0,0,0,.18);filter:brightness(1.06)}",
			".dpm-fab:active{transform:translateY(0) scale(.98)}",
			".dpm-fab svg{flex:none}",
			/* ── floating overlay + panel ───────────────────────────── */
			".dpm-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(15,18,26,.42);display:flex;align-items:flex-end;justify-content:flex-end;opacity:0;pointer-events:none;transition:opacity .2s ease;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}",
			".dpm-overlay.dpm-open{opacity:1;pointer-events:auto}",
			".dpm-panel{box-sizing:border-box;width:min(460px,100vw);max-height:86vh;display:flex;flex-direction:column;margin:14px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-alias-bg-module-platform,#fff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 24px 64px rgba(0,0,0,.32);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;transform:translateY(16px) scale(.98);transition:transform .2s ease;overflow:hidden}",
			".dpm-overlay.dpm-open .dpm-panel{transform:translateY(0) scale(1)}",
			".dpm-head{display:flex;align-items:center;gap:10px;padding:14px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.07));background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 6%,transparent),transparent)}",
			".dpm-head-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;flex:none}",
			".dpm-title{font-size:15px;font-weight:600;margin:0;flex:1}",
			".dpm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#646a73);cursor:pointer;transition:background .15s ease,color .15s ease}",
			".dpm-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07));color:var(--dsw-alias-label-primary,#1f2329)}",
			".dpm-icon-btn.dpm-spin svg{animation:dpm-spin .7s linear infinite}",
			"@keyframes dpm-spin{to{transform:rotate(360deg)}}",
			".dpm-body{overflow-y:auto;padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2,rgba(0,0,0,.15)) transparent}",
			/* ── settings view root ─────────────────────────────────── */
			".dpm-settings{width:100%;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary,#1f2329);font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}",
			".dpm-view-head{display:flex;align-items:center;gap:10px;margin-bottom:2px}",
			".dpm-view-head .dpm-title{font-size:14px;display:flex;align-items:center;gap:8px}",
			".dpm-view-head .dpm-title .dpm-head-icon{width:24px;height:24px;border-radius:7px}",
			/* ── section headers ────────────────────────────────────── */
			".dpm-section-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#646a73);margin:4px 0 8px;text-transform:uppercase;letter-spacing:.5px}",
			".dpm-section-title .dpm-sec-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary,#9aa0a6)}",
			".dpm-count{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-variant-numeric:tabular-nums;font-weight:500;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px}",
			/* ── import card ────────────────────────────────────────── */
			".dpm-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.02));padding:12px 14px;display:flex;flex-direction:column;gap:9px}",
			".dpm-import-label{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}",
			".dpm-import-label .dpm-sec-icon{color:var(--dsw-alias-state-business-primary,#2563eb)}",
			".dpm-import-row{display:flex;gap:8px}",
			".dpm-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.6));color:var(--dsw-alias-label-primary,#1f2329);border-radius:9px;padding:8px 11px;font:inherit;font-size:12px;outline:none;transition:border-color .15s ease,box-shadow .15s ease}",
			".dpm-input:focus{border-color:var(--dsw-alias-state-business-primary,#2563eb);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 16%,transparent)}",
			".dpm-input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a6)}",
			".dpm-btn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#1f2329);border-radius:9px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .15s ease,border-color .15s ease,transform .1s ease,opacity .15s ease}",
			".dpm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));border-color:var(--dsw-alias-border-l1,rgba(0,0,0,.2))}",
			".dpm-btn:active{transform:scale(.97)}",
			".dpm-btn.dpm-primary{background:linear-gradient(135deg,#2563eb,#4f46e5);border-color:transparent;color:#fff;font-weight:500}",
			".dpm-btn.dpm-primary:hover{filter:brightness(1.08);border-color:transparent}",
			".dpm-btn.dpm-danger{color:var(--dsw-alias-state-error-primary,#d1242f)}",
			".dpm-btn:disabled{opacity:.55;cursor:not-allowed;transform:none}",
			".dpm-hint{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;line-height:1.55}",
			".dpm-hint code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));border-radius:4px;padding:0 4px}",
			/* ── toolbar (search + chips) ───────────────────────────── */
			".dpm-toolbar{display:flex;flex-direction:column;gap:8px}",
			".dpm-search{position:relative;display:flex;align-items:center}",
			".dpm-search>svg{position:absolute;left:10px;color:var(--dsw-alias-label-tertiary,#9aa0a6);pointer-events:none}",
			".dpm-search .dpm-input{padding-left:31px}",
			".dpm-chips{display:flex;gap:6px;flex-wrap:wrap}",
			".dpm-chip{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#646a73);border-radius:999px;padding:4px 11px;font:inherit;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all .15s ease}",
			".dpm-chip:hover{border-color:var(--dsw-alias-border-l1,rgba(0,0,0,.25))}",
			".dpm-chip[data-on=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 38%,transparent);color:var(--dsw-alias-state-business-primary,#2563eb);font-weight:600}",
			/* ── plugin cards ───────────────────────────────────────── */
			".dpm-list{display:flex;flex-direction:column;gap:9px}",
			".dpm-item{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.02));padding:11px 13px;display:flex;flex-direction:column;gap:7px;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease;position:relative}",
			".dpm-item:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 30%,var(--dsw-alias-border-l2,rgba(0,0,0,.1)));box-shadow:0 4px 14px rgba(0,0,0,.06);transform:translateY(-1px)}",
			".dpm-item-top{display:flex;align-items:center;gap:9px;min-width:0}",
			".dpm-dot{width:9px;height:9px;border-radius:999px;flex:none;background:var(--dsw-alias-label-tertiary,#9aa0a6)}",
			".dpm-dot[data-phase=active]{background:var(--dsw-alias-state-success-primary,#1f883d);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f883d) 18%,transparent)}",
			".dpm-dot[data-phase=failed]{background:var(--dsw-alias-state-error-primary,#d1242f);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 18%,transparent)}",
			".dpm-dot[data-phase=pending],.dpm-dot[data-phase=loading]{background:var(--dsw-alias-state-business-primary,#2563eb);animation:dpm-pulse 1.4s ease-in-out infinite}",
			"@keyframes dpm-pulse{0%,100%{opacity:1}50%{opacity:.45}}",
			".dpm-item-id{font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dpm-item-name{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dpm-item-desc{color:var(--dsw-alias-label-secondary,#646a73);font-size:11.5px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
			".dpm-item-actions{margin-left:auto;display:flex;align-items:center;gap:4px;flex:none}",
			".dpm-switch{position:relative;width:36px;height:21px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.07));cursor:pointer;padding:0;transition:background .18s ease,border-color .18s ease,opacity .15s ease;flex:none}",
			".dpm-switch::after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .18s ease}",
			".dpm-switch[data-on=true]{background:var(--dsw-alias-state-success-primary,#1f883d);border-color:transparent}",
			".dpm-switch[data-on=true]::after{transform:translateX(15px)}",
			".dpm-switch.dpm-busy{opacity:.5;cursor:wait}",
			".dpm-remove{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);cursor:pointer;transition:background .15s ease,color .15s ease}",
			".dpm-remove:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 12%,transparent);color:var(--dsw-alias-state-error-primary,#d1242f)}",
			".dpm-item-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
			".dpm-tag{font-size:10.5px;line-height:1;padding:4px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#646a73);white-space:nowrap;display:inline-flex;align-items:center;gap:4px}",
			".dpm-tag[data-phase=active]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f883d) 12%,transparent);color:var(--dsw-alias-state-success-primary,#1f883d)}",
			".dpm-tag[data-phase=failed]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 12%,transparent);color:var(--dsw-alias-state-error-primary,#d1242f)}",
			".dpm-tag.dpm-off{opacity:.55}",
			".dpm-tag.dpm-official{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 10%,transparent);color:var(--dsw-alias-state-business-primary,#2563eb)}",
			".dpm-tag.dpm-external{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 13%,transparent);color:var(--dsw-alias-state-warning-primary,#d97706)}",
			".dpm-tag.dpm-installed{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f883d) 8%,transparent);color:var(--dsw-alias-state-success-primary,#1f883d)}",
			/* ── official rows ──────────────────────────────────────── */
			".dpm-official-row{display:flex;align-items:center;gap:9px;padding:8px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));border-radius:9px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.02));transition:border-color .15s ease,background .15s ease}",
			".dpm-official-row:hover{border-color:var(--dsw-alias-border-l1,rgba(0,0,0,.16));background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}",
			".dpm-official-row .dpm-item-id{font-weight:500;font-size:12px}",
			".dpm-official-row .dpm-item-name{font-size:11px}",
			".dpm-collapse{border:none;background:transparent;color:var(--dsw-alias-state-business-primary,#2563eb);cursor:pointer;font:inherit;font-size:12px;padding:6px 0;text-align:left;display:inline-flex;align-items:center;gap:5px;width:fit-content}",
			".dpm-collapse:hover{text-decoration:underline}",
			".dpm-collapse svg{transition:transform .18s ease}",
			".dpm-collapse[data-open=true] svg{transform:rotate(180deg)}",
			".dpm-url a{color:var(--dsw-alias-state-business-primary,#2563eb);text-decoration:none;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:10.5px}",
			".dpm-url a:hover{text-decoration:underline}",
			".dpm-tag.dpm-version{cursor:pointer;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.18))}",
			".dpm-tag.dpm-version:hover{border-color:var(--dsw-alias-state-business-primary,#2563eb);color:var(--dsw-alias-state-business-primary,#2563eb)}",
			/* ── messages / toast ───────────────────────────────────── */
			".dpm-msg{border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;display:none;border:1px solid transparent}",
			".dpm-msg.dpm-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 8%,transparent);color:var(--dsw-alias-state-error-primary,#d1242f);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 18%,transparent)}",
			".dpm-msg.dpm-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f883d) 8%,transparent);color:var(--dsw-alias-state-success-primary,#1f883d);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f883d) 18%,transparent)}",
			".dpm-toasts{position:fixed;top:14px;right:14px;z-index:2147483010;display:flex;flex-direction:column;gap:8px;pointer-events:none}",
			".dpm-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:9px;min-width:240px;max-width:340px;padding:10px 13px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-alias-bg-module-platform,#fff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 10px 32px rgba(0,0,0,.18);font:12.5px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;animation:dpm-toast-in .22s ease;word-break:break-word}",
			".dpm-toast.dpm-error .dpm-toast-icon{color:var(--dsw-alias-state-error-primary,#d1242f)}",
			".dpm-toast.dpm-ok .dpm-toast-icon{color:var(--dsw-alias-state-success-primary,#1f883d)}",
			".dpm-toast.dpm-info .dpm-toast-icon{color:var(--dsw-alias-state-business-primary,#2563eb)}",
			".dpm-toast-icon{flex:none;margin-top:1px;display:inline-flex}",
			".dpm-toast-close{margin-left:auto;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);cursor:pointer;padding:0 0 0 8px;display:inline-flex;align-items:center}",
			".dpm-toast-close:hover{color:var(--dsw-alias-label-primary,#1f2329)}",
			"@keyframes dpm-toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}",
			".dpm-toast.dpm-out{opacity:0;transform:translateX(8px);transition:opacity .2s ease,transform .2s ease}",
			/* ── confirm modal ──────────────────────────────────────── */
			".dpm-modal-overlay{position:fixed;inset:0;z-index:2147483005;background:rgba(15,18,26,.4);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);animation:dpm-fade .15s ease}",
			".dpm-modal{width:min(380px,92vw);border-radius:14px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-alias-bg-module-platform,#fff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 20px 56px rgba(0,0,0,.3);padding:18px;display:flex;flex-direction:column;gap:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;animation:dpm-modal-in .18s ease}",
			".dpm-modal-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:9px}",
			".dpm-modal-title .dpm-sec-icon{color:var(--dsw-alias-state-error-primary,#d1242f)}",
			".dpm-modal-desc{color:var(--dsw-alias-label-secondary,#646a73);font-size:12.5px;line-height:1.6}",
			".dpm-modal-desc code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));border-radius:4px;padding:1px 5px}",
			".dpm-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}",
			"@keyframes dpm-fade{from{opacity:0}to{opacity:1}}",
			"@keyframes dpm-modal-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}",
			/* ── footer chips ───────────────────────────────────────── */
			".dpm-foot{display:flex;gap:6px;flex-wrap:wrap;padding:10px 0 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.07));color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px}",
			".dpm-foot-chip{display:inline-flex;align-items:center;gap:5px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));border-radius:999px;padding:3px 9px}",
			".dpm-token-row{display:flex;gap:6px;margin-top:4px}",
			/* ── empty & skeleton ───────────────────────────────────── */
			".dpm-empty{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12.5px;text-align:center;padding:22px 10px;display:flex;flex-direction:column;align-items:center;gap:8px}",
			".dpm-empty .dpm-sec-icon{opacity:.5}",
			".dpm-skeleton{display:flex;flex-direction:column;gap:8px}",
			".dpm-sk-row{height:52px;border-radius:11px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04)) 25%,var(--dsw-alias-bg-layer-3,rgba(0,0,0,.08)) 37%,var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04)) 63%);background-size:400% 100%;animation:dpm-shimmer 1.3s ease infinite}",
			"@keyframes dpm-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}",
			/* ── marketplace ──────────────────────────────────────── */
			".dpm-mk-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".dpm-mk-head .dpm-title{font-size:14px;display:flex;align-items:center;gap:8px}",
			".dpm-mk-status{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
			".dpm-mk-list{display:flex;flex-direction:column;gap:9px}",
			".dpm-mk-item{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.02));padding:11px 13px;display:flex;flex-direction:column;gap:7px;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}",
			".dpm-mk-item:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 30%,var(--dsw-alias-border-l2,rgba(0,0,0,.1)));box-shadow:0 4px 14px rgba(0,0,0,.06);transform:translateY(-1px)}",
			".dpm-mk-top{display:flex;align-items:center;gap:9px;min-width:0}",
			".dpm-mk-name{font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dpm-mk-owner{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dpm-mk-actions{margin-left:auto;display:flex;align-items:center;gap:6px;flex:none}",
			".dpm-mk-install{display:inline-flex;align-items:center;gap:5px;border:1px solid transparent;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;border-radius:8px;padding:5px 11px;font:inherit;font-size:11.5px;font-weight:500;cursor:pointer;transition:filter .15s ease,opacity .15s ease,transform .1s ease}",
			".dpm-mk-install:hover{filter:brightness(1.08)}",
			".dpm-mk-install:active{transform:scale(.97)}",
			".dpm-mk-install:disabled{opacity:.55;cursor:not-allowed}",
			".dpm-mk-installed{display:inline-flex;align-items:center;gap:5px;border-radius:8px;padding:5px 10px;font-size:11.5px;font-weight:600;background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f883d) 12%,transparent);color:var(--dsw-alias-state-success-primary,#1f883d)}",
			".dpm-mk-desc{color:var(--dsw-alias-label-secondary,#646a73);font-size:11.5px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
			".dpm-mk-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
			".dpm-mk-tag{font-size:10.5px;line-height:1;padding:4px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#646a73);white-space:nowrap;display:inline-flex;align-items:center;gap:4px}",
			".dpm-mk-tag.dpm-mk-stars{color:var(--dsw-alias-state-warning-primary,#d97706);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 10%,transparent)}",
			".dpm-mk-tag.dpm-mk-standard{color:var(--dsw-alias-state-success-primary,#1f883d);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f883d) 10%,transparent)}",
			".dpm-mk-tag.dpm-mk-archived{color:var(--dsw-alias-state-error-primary,#d1242f);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 10%,transparent)}"
		].join("");

		/** @param {string} id @param {string} css */
		function ensureStyle(id, css) {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-manager";
			tag.dataset.pluginCss = id;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** @param {string} tag @param {string} [className] @param {string} [text] */
		function el(tag, className, text) {
			var node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== void 0) node.textContent = text;
			return node;
		}

		/** @param {string} html */
		function icon(html) {
			var span = document.createElement("span");
			span.className = "dpm-sec-icon";
			span.innerHTML = html;
			return span;
		}

		/** @param {string} path @param {object} [body] */
		async function api(path, body) {
			var headers = {};
			var token = localStorage.getItem(TOKEN_KEY);
			if (token) headers["x-plugin-manager-token"] = token;
			var payload = null;
			if (body !== void 0) {
				headers["Content-Type"] = "application/json";
				payload = JSON.stringify(body);
			}
			var res = await fetch(path, { method: body === void 0 ? "GET" : "POST", headers: headers, body: payload });
			var data = await res.json().catch(function () { return { ok: false, error: { code: "BAD_RESPONSE", message: "HTTP " + res.status } }; });
			if (res.status === 401) data.authRequired = true;
			return data;
		}

		function phaseLabel(phase) {
			return phase === null ? "未挂载" : phase === "active" ? "已挂载" : phase === "failed" ? "挂载失败" : phase === "pending" ? "等待依赖" : phase === "loading" ? "加载中" : "卸载中";
		}

		/** ── toast system ─────────────────────────────────────────── */
		var toastsHost = null;
		function ensureToasts() {
			if (toastsHost && document.body.contains(toastsHost)) return toastsHost;
			toastsHost = el("div", "dpm-toasts");
			document.body.appendChild(toastsHost);
			return toastsHost;
		}
		/** @param {"ok"|"error"|"info"} kind @param {string} message */
		function toast(kind, message) {
			if (typeof document === "undefined") return;
			var host = ensureToasts();
			var t = el("div", "dpm-toast " + (kind === "ok" ? "dpm-ok" : kind === "error" ? "dpm-error" : "dpm-info"));
			var tIcon = el("span", "dpm-toast-icon");
			tIcon.innerHTML = kind === "ok" ? ICON.check : kind === "error" ? ICON.alert : ICON.info;
			var text = el("span", null, message);
			var close = el("button", "dpm-toast-close");
			close.type = "button";
			close.innerHTML = ICON.close;
			var dismiss = function () {
				if (!t.isConnected) return;
				t.classList.add("dpm-out");
				setTimeout(function () { t.remove(); }, 220);
			};
			close.addEventListener("click", dismiss);
			setTimeout(dismiss, 4200);
			t.append(tIcon, text, close);
			host.appendChild(t);
		}

		/** ── confirm modal ────────────────────────────────────────── */
		/** @param {{ title: string, description: string, confirmText: string }} opts @returns {Promise<boolean>} */
		function confirmModal(opts) {
			return new Promise(function (resolvePromise) {
				var overlay = el("div", "dpm-modal-overlay");
				var modal = el("div", "dpm-modal");
				var title = el("div", "dpm-modal-title");
				title.appendChild(icon(ICON.alert));
				title.appendChild(document.createTextNode(opts.title));
				var desc = el("div", "dpm-modal-desc");
				desc.innerHTML = opts.description;
				var actions = el("div", "dpm-modal-actions");
				var cancel = el("button", "dpm-btn", "取消");
				var confirmBtn = el("button", "dpm-btn dpm-danger", opts.confirmText);
				cancel.type = "button";
				confirmBtn.type = "button";
				actions.append(cancel, confirmBtn);
				modal.append(title, desc, actions);
				overlay.appendChild(modal);
				document.body.appendChild(overlay);

				var cleanup = function (result) {
					overlay.remove();
					document.removeEventListener("keydown", onKey);
					resolvePromise(result);
				};
				var onKey = function (e) {
					if (e.key === "Escape") cleanup(false);
				};
				document.addEventListener("keydown", onKey);
				overlay.addEventListener("click", function (e) { if (e.target === overlay) cleanup(false); });
				cancel.addEventListener("click", function () { cleanup(false); });
				confirmBtn.addEventListener("click", function () { cleanup(true); });
			});
		}

		/**
		 * Build the manager view (import + external list + official list + footer).
		 * Shared by the floating FAB panel and the Settings → 插件 → 插件管理 tab.
		 * @param {HTMLElement} root
		 * @returns {{ refresh: (silent?: boolean) => Promise<void>, destroy: () => void }}
		 */
		function buildManagerView(root) {
			var state = null;
			var destroyed = false;
			var filter = "all"; // all | external | official
			var query = "";
			var officialExpanded = false;
			var officialShowAll = false;

			root.classList.add("dpm-settings");
			root.textContent = "";

			// ── header (settings view) ───────────────────────────────
			var head = el("div", "dpm-view-head");
			var headTitle = el("div", "dpm-title");
			var headIcon = el("span", "dpm-head-icon");
			headIcon.innerHTML = ICON.plugin;
			headTitle.appendChild(headIcon);
			headTitle.appendChild(document.createTextNode("插件管理"));
			var refreshBtn = el("button", "dpm-icon-btn");
			refreshBtn.type = "button";
			refreshBtn.title = "刷新";
			refreshBtn.innerHTML = ICON.refresh;
			head.append(headTitle, refreshBtn);
			root.appendChild(head);

			// ── import card ──────────────────────────────────────────
			var importCard = el("div", "dpm-card");
			var importLabel = el("div", "dpm-import-label");
			importLabel.appendChild(icon(ICON.plus));
			importLabel.appendChild(document.createTextNode("导入新插件"));
			var importRow = el("div", "dpm-import-row");
			var sourceInput = el("input", "dpm-input");
			sourceInput.placeholder = "git URL / npm 包名 / tarball URL / 本地路径";
			sourceInput.addEventListener("keydown", function (e) { if (e.key === "Enter") doImport(); });
			var importBtn = el("button", "dpm-btn dpm-primary", null);
			importBtn.type = "button";
			importBtn.innerHTML = ICON.plus;
			importBtn.appendChild(document.createTextNode("导入"));
			importRow.append(sourceInput, importBtn);
			var importHint = el("div", "dpm-hint");
			importHint.innerHTML = '支持 <code>git+https://…​.git</code>、<code>github:owner/repo</code>、npm 包名、<code>.tgz</code> URL、<code>file:./路径</code>，依赖经 pnpm 装入 profile。';
			importCard.append(importLabel, importRow, importHint);
			root.appendChild(importCard);

			// ── toolbar (search + filter chips) ─────────────────────
			var toolbar = el("div", "dpm-toolbar");
			var searchWrap = el("div", "dpm-search");
			searchWrap.innerHTML = ICON.search;
			var searchInput = el("input", "dpm-input");
			searchInput.placeholder = "搜索插件…";
			searchInput.addEventListener("input", function () { query = searchInput.value.trim().toLowerCase(); render(); });
			searchWrap.appendChild(searchInput);
			var chips = el("div", "dpm-chips");
			var chipDefs = [
				{ id: "all", label: "全部" },
				{ id: "external", label: "外部" },
				{ id: "official", label: "官方" }
			];
			var chipEls = {};
			chipDefs.forEach(function (def) {
				var c = el("button", "dpm-chip", def.label);
				c.type = "button";
				c.dataset.on = String(def.id === "all");
				c.addEventListener("click", function () {
					filter = def.id;
					Object.keys(chipEls).forEach(function (key) { chipEls[key].dataset.on = "false"; });
					c.dataset.on = "true";
					render();
				});
				chipEls[def.id] = c;
				chips.appendChild(c);
			});
			toolbar.append(searchWrap, chips);
			root.appendChild(toolbar);

			// ── inline message (import details / patch errors) ──────
			var msg = el("div", "dpm-msg");
			var setMsg = function (kind, text) {
				if (!text) { msg.className = "dpm-msg"; msg.textContent = ""; return; }
				msg.className = "dpm-msg " + (kind === "ok" ? "dpm-ok" : "dpm-error");
				msg.textContent = text;
			};
			root.appendChild(msg);

			// ── auth row ─────────────────────────────────────────────
			var authRow = el("div", "dpm-token-row");
			var tokenInput = el("input", "dpm-input");
			tokenInput.type = "password";
			tokenInput.placeholder = "manager token（必填）";
			var tokenBtn = el("button", "dpm-btn", "保存");
			tokenBtn.type = "button";
			authRow.append(tokenInput, tokenBtn);
			authRow.style.display = "none";
			root.appendChild(authRow);

			// ── dynamic area ─────────────────────────────────────────
			var listArea = el("div");
			root.appendChild(listArea);

			// ── footer ───────────────────────────────────────────────
			var foot = el("div", "dpm-foot");
			root.appendChild(foot);

			/** @param {any} item @returns {HTMLElement} */
			function renderExternalCard(item) {
				var card = el("div", "dpm-item");
				var top = el("div", "dpm-item-top");
				var dot = el("span", "dpm-dot");
				dot.dataset.phase = item.phase ?? "null";
				var idNode = el("span", "dpm-item-id", item.id);
				var actions = el("div", "dpm-item-actions");
				var sw = el("button", "dpm-switch");
				sw.type = "button";
				sw.setAttribute("role", "switch");
				sw.setAttribute("aria-checked", String(item.enabled));
				sw.dataset.on = String(item.enabled);
				sw.title = item.enabled ? "停用" : "启用";
				var rm = el("button", "dpm-remove");
				rm.type = "button";
				rm.title = "移除 " + item.id;
				rm.innerHTML = ICON.trash;
				var upd = el("button", "dpm-icon-btn", null);
				upd.type = "button";
				upd.title = "更新到最新版本";
				upd.innerHTML = ICON.refresh;
				actions.append(sw, upd, rm);
				top.append(dot, idNode, actions);
				card.appendChild(top);

				var nameRow = el("div", "dpm-item-name", item.name + (item.version ? " · v" + item.version : ""));
				card.appendChild(nameRow);

				// url line (clickable)
				if (item.url) {
					var urlRow = el("div", "dpm-item-name dpm-url");
					var a = document.createElement("a");
					a.href = item.url;
					a.target = "_blank";
					a.rel = "noopener noreferrer";
					a.textContent = item.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
					a.title = item.url;
					urlRow.appendChild(a);
					card.appendChild(urlRow);
				}

				if (item.description) {
					card.appendChild(el("div", "dpm-item-desc", item.description));
				}

				var meta = el("div", "dpm-item-meta");
				meta.appendChild(el("span", "dpm-tag dpm-external", item.source === "bundle" ? "外部 bundle" : "外部插件"));
				var phaseTag = el("span", "dpm-tag", phaseLabel(item.phase));
				phaseTag.dataset.phase = item.phase ?? "null";
				meta.appendChild(phaseTag);
				if (!item.live) meta.appendChild(el("span", "dpm-tag dpm-off", "未加载"));
				if (item.installed) meta.appendChild(el("span", "dpm-tag dpm-installed", "已安装"));
				else meta.appendChild(el("span", "dpm-tag dpm-off", "未安装依赖"));
				if (item.hasClient) meta.appendChild(el("span", "dpm-tag", "客户端"));
				if (item.bundlePatch) meta.appendChild(el("span", "dpm-tag", "bundle patch"));
				if (item.version) {
					var verTag = el("span", "dpm-tag dpm-version", "v" + item.version);
					verTag.title = "点击切换版本 / git 分支 / tag";
					verTag.addEventListener("click", async function () {
						var v = window.prompt("输入要切换的版本\n（git 插件：tag / 分支 / commit；npm 插件：版本号）", "");
						if (!v || !v.trim()) return;
						var res = await api(API.switch, { id: item.id, version: v.trim() });
						if (res.ok) {
							state = res.state;
							render();
							toast("ok", "已切换 " + res.packageName + " → " + (res.version || v.trim()));
						} else {
							toast("error", res.error?.message ?? "切换失败");
						}
					});
					meta.appendChild(verTag);
				}
				card.appendChild(meta);

				sw.addEventListener("click", async function () {
					sw.classList.add("dpm-busy");
					sw.disabled = true;
					var res = await api(API.toggle, { id: item.id, enabled: !item.enabled });
					sw.classList.remove("dpm-busy");
					sw.disabled = false;
					if (res.ok) {
						state = res.state;
						render();
						toast("ok", (res.enabled ? "已启用 " : "已停用 ") + res.id);
					} else {
						toast("error", res.error?.message ?? "操作失败");
					}
				});
				upd.addEventListener("click", async function () {
					upd.classList.add("dpm-spin");
					upd.disabled = true;
					var res = await api(API.update, { id: item.id });
					upd.classList.remove("dpm-spin");
					upd.disabled = false;
					if (res.ok) {
						state = res.state;
						render();
						toast("ok", "已更新 " + res.packageName + " → " + (res.version ? "v" + res.version : "最新"));
					} else {
						toast("error", res.error?.message ?? "更新失败");
					}
				});
				rm.addEventListener("click", async function () {
					var ok = await confirmModal({
						title: "移除插件",
						description: "将删除补丁行并执行 <code>pnpm remove " + item.name + "</code>，确定移除 <code>" + item.id + "</code> 吗？",
						confirmText: "确认移除"
					});
					if (!ok) return;
					rm.style.opacity = ".5";
					rm.disabled = true;
					var res = await api(API.remove, { id: item.id, packageName: item.name });
					if (res.ok) {
						state = res.state;
						render();
						toast("ok", "已移除 " + res.id + (res.dependencyRemoved === false ? "（依赖卸载失败，见输出）" : ""));
					} else {
						toast("error", res.error?.message ?? "移除失败");
					}
				});
				return card;
			}

			/** @param {any} item @returns {HTMLElement} */
			function renderOfficialRow(item) {
				var row = el("div", "dpm-official-row");
				var dot = el("span", "dpm-dot");
				dot.dataset.phase = item.phase ?? "null";
				var idNode = el("span", "dpm-item-id", item.id);
				var meta = el("span", "dpm-item-name", item.name || "");
				var tag = el("span", "dpm-tag " + (item.official ? "dpm-official" : "dpm-external"), item.official ? "官方内置" : "外部 bundle");
				row.append(dot, idNode, meta, tag);
				return row;
			}

			/** @param {any} item */
			function matchesQuery(item) {
				if (!query) return true;
				return (String(item.id) + " " + String(item.name ?? "")).toLowerCase().includes(query);
			}

			/** Render dynamic lists + footer from current state. */
			function render() {
				listArea.textContent = "";
				if (!state) return;

				var external = (state.managed ?? []).filter(function (m) { return m.category !== "official"; });
				var managedOfficial = (state.managed ?? []).filter(function (m) { return m.category === "official"; });
				var unmanaged = state.unmanaged ?? [];
				var officialAll = unmanaged.filter(function (u) { return !u.managable; })
					.map(function (u) { return { id: u.id, name: u.name, phase: u.phase }; })
					.concat(managedOfficial.map(function (m) { return { id: m.id, name: m.name, phase: m.phase }; }));

				var showExternal = filter !== "official";
				var showOfficial = filter !== "external";

				// bundle-managed section: marketplace/bundle plugins (manageable)
				var bundleItems = unmanaged
					.filter(function (u) { return u.managable; })
					.map(function (u) { return { ...u, source: "bundle", version: null, description: null, hasClient: false }; })
					.filter(matchesQuery);
				if (showExternal && bundleItems.length > 0) {
					var bTitle = el("div", "dpm-section-title");
					bTitle.appendChild(icon(ICON.download));
					bTitle.appendChild(document.createTextNode("外部 bundle 插件"));
					bTitle.appendChild(el("span", "dpm-count", String(bundleItems.length)));
					listArea.appendChild(bTitle);
					var bList = el("div", "dpm-list");
					bundleItems.forEach(function (item) { bList.appendChild(renderExternalCard(item)); });
					listArea.appendChild(bList);
				}

				if (showExternal) {
					var filtered = external.filter(matchesQuery);
					var extTitle = el("div", "dpm-section-title");
					extTitle.appendChild(icon(ICON.external));
					extTitle.appendChild(document.createTextNode("外部插件"));
					extTitle.appendChild(el("span", "dpm-count", String(filtered.length)));
					listArea.appendChild(extTitle);
					var extList = el("div", "dpm-list");
					if (filtered.length === 0) {
						var empty = el("div", "dpm-empty");
						empty.appendChild(icon(ICON.plugin));
						empty.appendChild(document.createTextNode(external.length === 0 ? "暂无外部插件，可在上方导入。" : "没有匹配的插件。"));
						extList.appendChild(empty);
					}
					filtered.forEach(function (item) { extList.appendChild(renderExternalCard(item)); });
					listArea.appendChild(extList);
				}

				if (showOfficial) {
					var offFiltered = officialAll.filter(matchesQuery);
					var offTitle = el("div", "dpm-section-title");
					var chevron = el("button", "dpm-collapse", null);
					chevron.type = "button";
					chevron.dataset.open = String(officialExpanded);
					chevron.innerHTML = ICON.chevron;
					chevron.title = officialExpanded ? "折叠" : "展开";
					chevron.addEventListener("click", function () {
						officialExpanded = !officialExpanded;
						officialShowAll = false;
						render();
					});
					offTitle.appendChild(icon(ICON.official));
					offTitle.appendChild(document.createTextNode("官方内置插件（只读）"));
					offTitle.appendChild(el("span", "dpm-count", String(offFiltered.length)));
					offTitle.appendChild(chevron);
					listArea.appendChild(offTitle);
					var offList = el("div", "dpm-list");
					if (officialExpanded) {
						var shown = officialShowAll ? offFiltered : offFiltered.slice(0, 40);
						shown.forEach(function (item) { offList.appendChild(renderOfficialRow(item)); });
						if (!officialShowAll && offFiltered.length > shown.length) {
							var more = el("button", "dpm-collapse", "展开全部 " + offFiltered.length + " 个");
							more.type = "button";
							more.addEventListener("click", function () {
								officialShowAll = true;
								render();
							});
							offList.appendChild(more);
						}
					} else {
						offList.appendChild(el("div", "dpm-hint", "共 " + offFiltered.length + " 个官方内置插件，点击右侧箭头展开查看。"));
					}
					listArea.appendChild(offList);
				}

				// footer chips
				foot.textContent = "";
				var t = state.toolchain || {};
				var chips = [];
				chips.push(el("span", "dpm-foot-chip", state.profile ? state.profile.name + " · " + state.profile.dir : ""));
				chips.push(el("span", "dpm-foot-chip", "node " + (t.node ?? "?")));
				chips.push(el("span", "dpm-foot-chip", t.pnpm ? "pnpm " + (t.pnpm.version ?? "") : "pnpm ✗"));
				chips.push(el("span", "dpm-foot-chip", t.git ? "git ✓" : "git ✗"));
				chips.forEach(function (c) { foot.appendChild(c); });
			}

			function showSkeleton() {
				listArea.textContent = "";
				var sk = el("div", "dpm-skeleton");
				for (var i = 0; i < 3; i += 1) sk.appendChild(el("div", "dpm-sk-row"));
				listArea.appendChild(sk);
			}

			/** @param {boolean} [silent] */
			async function refresh(silent) {
				if (destroyed) return;
				refreshBtn.classList.add("dpm-spin");
				if (!state && !silent) showSkeleton();
				var res = await api(API.state);
				refreshBtn.classList.remove("dpm-spin");
				if (destroyed) return;
				if (res.ok) {
					state = res;
					authRow.style.display = "none";
					setMsg(null, null);
					render();
					if (res.parseError) { setMsg("error", "patch 文件解析错误：" + res.parseError); toast("error", "patch 文件解析错误"); }
				} else {
					if (res.authRequired) {
						authRow.style.display = "flex";
						setMsg("error", "该实例配置了 manager token，请输入后重试。");
					} else {
						setMsg("error", res.error?.message ?? "无法读取插件状态");
					}
				}
			}

			async function doImport() {
				var source = sourceInput.value.trim();
				if (!source) { setMsg("error", "请输入插件来源。"); return; }
				importBtn.disabled = true;
				importBtn.classList.add("dpm-busy");
				importBtn.textContent = "导入中…";
				setMsg(null, null);
				var res = await api(API.import, { source: source });
				importBtn.disabled = false;
				importBtn.classList.remove("dpm-busy");
				importBtn.textContent = "";
				importBtn.innerHTML = ICON.plus;
				importBtn.appendChild(document.createTextNode("导入"));
				if (res.ok) {
					sourceInput.value = "";
					state = res.state;
					render();
					toast("ok", "已导入 " + res.packageName);
					setMsg("ok", "已导入 " + res.packageName + "（id: " + res.id + "）" + (res.note ? "\n" + res.note : ""));
				} else {
					var detail = res.error?.details ?? "";
					setMsg("error", (res.error?.message ?? "导入失败") + (detail ? "\n\n" + detail : ""));
					toast("error", res.error?.message ?? "导入失败");
				}
			}

			refreshBtn.addEventListener("click", function () { refresh(false); });
			tokenBtn.addEventListener("click", function () {
				var value = tokenInput.value.trim();
				if (!value) return;
				localStorage.setItem(TOKEN_KEY, value);
				tokenInput.value = "";
				refresh(false);
			});
			importBtn.addEventListener("click", doImport);

			showSkeleton();
			return {
				refresh: refresh,
				destroy: function () { destroyed = true; root.textContent = ""; }
			};
		}

		/**
		 * Build the marketplace view (GitHub dsh-plugin topic) into a container.
		 * @param {HTMLElement} root
		 * @returns {{ refresh: (silent?: boolean) => Promise<void>, destroy: () => void }}
		 */
		function buildMarketplaceView(root) {
			var market = null;
			var installedNames = new Set();
			var query = "";
			var busy = false;
			var destroyed = false;

			root.classList.add("dpm-settings");
			root.textContent = "";

			// ── head ────────────────────────────────────────────────
			var head = el("div", "dpm-mk-head");
			var title = el("div", "dpm-title");
			var headIcon = el("span", "dpm-head-icon");
			headIcon.innerHTML = ICON.store;
			title.appendChild(headIcon);
			title.appendChild(document.createTextNode("插件市场"));
			var refreshBtn = el("button", "dpm-icon-btn", null);
			refreshBtn.type = "button";
			refreshBtn.title = "刷新";
			refreshBtn.innerHTML = ICON.refresh;
			head.append(title, refreshBtn);
			root.appendChild(head);

			var status = el("div", "dpm-mk-status");
			root.appendChild(status);

			// ── search ──────────────────────────────────────────────
			var searchWrap = el("div", "dpm-search");
			searchWrap.innerHTML = ICON.search;
			var searchInput = el("input", "dpm-input");
			searchInput.placeholder = "搜索市场插件…";
			searchInput.addEventListener("input", function () { query = searchInput.value.trim().toLowerCase(); render(); });
			searchWrap.appendChild(searchInput);
			root.appendChild(searchWrap);

			var msg = el("div", "dpm-msg");
			root.appendChild(msg);

			var listArea = el("div");
			root.appendChild(listArea);

			/** @param {any} repo @returns {HTMLElement} */
			function renderRepoCard(repo) {
				var card = el("div", "dpm-mk-item");
				var top = el("div", "dpm-mk-top");
				var nameWrap = el("div", "dpm-mk-name");
				nameWrap.textContent = repo.name;
				nameWrap.title = repo.fullName;
				var actions = el("div", "dpm-mk-actions");
				if (repo.installed) {
					var installedTag = el("span", "dpm-mk-installed");
					installedTag.innerHTML = ICON.check;
					installedTag.appendChild(document.createTextNode("已安装"));
					actions.appendChild(installedTag);
				} else {
					var installBtn = el("button", "dpm-mk-install", null);
					installBtn.type = "button";
					installBtn.innerHTML = ICON.download;
					installBtn.appendChild(document.createTextNode("安装"));
					installBtn.disabled = busy || repo.archived;
					installBtn.title = repo.archived ? "仓库已归档" : "安装 " + repo.fullName;
					installBtn.addEventListener("click", function () { doInstall(repo, installBtn); });
					actions.appendChild(installBtn);
				}
				top.append(nameWrap, actions);
				card.appendChild(top);

				var ownerRow = el("div", "dpm-mk-owner", repo.owner + "/" + repo.name);
				card.appendChild(ownerRow);

				if (repo.description) card.appendChild(el("div", "dpm-mk-desc", repo.description));

				var meta = el("div", "dpm-mk-meta");
				if (repo.stars > 0) {
					var starTag = el("span", "dpm-mk-tag dpm-mk-stars", null);
					starTag.innerHTML = ICON.star;
					starTag.appendChild(document.createTextNode(" " + repo.stars));
					meta.appendChild(starTag);
				}
				if (repo.standard) meta.appendChild(el("span", "dpm-mk-tag dpm-mk-standard", "标准插件"));
				if (repo.language) meta.appendChild(el("span", "dpm-mk-tag", repo.language));
				if (repo.updatedAt) {
					var d = new Date(repo.updatedAt);
					meta.appendChild(el("span", "dpm-mk-tag", "更新 " + (Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10))));
				}
				if (repo.archived) meta.appendChild(el("span", "dpm-mk-tag dpm-mk-archived", "已归档"));
				if (repo.official) meta.appendChild(el("span", "dpm-mk-tag", "官方"));
				card.appendChild(meta);

				return card;
			}

			async function doInstall(repo, btn) {
				var ok = await confirmModal({
					title: "安装插件",
					description: "将从 <code>" + repo.fullName + "</code> 安装插件到当前 profile（pnpm add github:" + repo.fullName + "），继续吗？",
					confirmText: "确认安装"
				});
				if (!ok) return;
				btn.disabled = true;
				btn.textContent = "";
				btn.innerHTML = ICON.download;
				btn.appendChild(document.createTextNode("安装中…"));
				var res = await api(API.import, { source: "github:" + repo.fullName });
				btn.disabled = false;
				btn.textContent = "";
				btn.innerHTML = ICON.download;
				btn.appendChild(document.createTextNode("安装"));
				if (res.ok) {
					toast("ok", "已安装 " + res.packageName);
					refresh(false);
					// also refresh the manager view's installed list if present
					if (typeof window.__dpmRefreshManager === "function") window.__dpmRefreshManager();
				} else {
					toast("error", res.error?.message ?? "安装失败");
					msg.className = "dpm-msg dpm-error";
					msg.textContent = (res.error?.message ?? "安装失败") + (res.error?.details ? "\n\n" + res.error.details : "");
				}
			}

			function render() {
				listArea.textContent = "";
				if (!market) return;
				var filtered = market.repos.filter(function (r) {
					if (!query) return true;
					return (r.name + " " + r.fullName + " " + (r.description || "")).toLowerCase().includes(query);
				});
				var list = el("div", "dpm-mk-list");
				if (filtered.length === 0) {
					var empty = el("div", "dpm-empty");
					empty.appendChild(icon(ICON.store));
					empty.appendChild(document.createTextNode("没有匹配的插件。"));
					list.appendChild(empty);
				}
				filtered.forEach(function (r) { list.appendChild(renderRepoCard(r)); });
				listArea.appendChild(list);
			}

			function showSkeleton() {
				listArea.textContent = "";
				var sk = el("div", "dpm-skeleton");
				for (var i = 0; i < 4; i += 1) sk.appendChild(el("div", "dpm-sk-row"));
				listArea.appendChild(sk);
			}

			/** @param {boolean} [silent] */
			async function refresh(silent) {
				if (destroyed) return;
				refreshBtn.classList.add("dpm-spin");
				if (!market && !silent) showSkeleton();
				var [stateRes, marketRes] = await Promise.all([
					api(API.state),
					api(API.marketplace)
				]);
				refreshBtn.classList.remove("dpm-spin");
				if (destroyed) return;
				if (marketRes.ok) {
					market = marketRes;
					// the server already marks installed repos (patch rows + profile deps + bundles)
					var t = marketRes.rateLimit || {};
					status.textContent = "来源：GitHub topic dsh-plugin · 共 " + market.total + " 个仓库 · 已显示 " + market.repos.length +
						(t.remaining !== undefined ? " · API 余量 " + t.remaining + "/" + t.limit : "");
					msg.className = "dpm-msg";
					msg.textContent = "";
					render();
				} else {
					msg.className = "dpm-msg dpm-error";
					msg.textContent = marketRes.error?.message ?? "无法加载插件市场";
					toast("error", marketRes.error?.message ?? "无法加载插件市场");
				}
			}

			refreshBtn.addEventListener("click", function () { refresh(false); });
			showSkeleton();
			return {
				refresh: refresh,
				destroy: function () { destroyed = true; root.textContent = ""; }
			};
		}

		/**
		 * Settings → 插件 → 插件市场 tab. Thin React host that mounts the
		 * vanilla marketplace view.
		 */
		function ManagerMarketplaceTab() {
			var hostRef = react.useRef(null);
			react.useEffect(function () {
				if (!hostRef.current) return;
				var view = buildMarketplaceView(hostRef.current);
				view.refresh(true);
				return function () { view.destroy(); };
			}, []);
			return react_jsx_runtime.jsx("div", { ref: hostRef });
		}

		/**
		 * Settings → 插件 → 插件管理 tab. Thin React host that mounts the
		 * vanilla manager view (shared with the FAB panel).
		 */
		function ManagerSettingsTab() {
			var hostRef = react.useRef(null);
			react.useEffect(function () {
				if (!hostRef.current) return;
				var view = buildManagerView(hostRef.current);
				view.refresh(true);
				window.__dpmRefreshManager = function () { view.refresh(true); };
				return function () { view.destroy(); if (window.__dpmRefreshManager) window.__dpmRefreshManager = null; };
			}, []);
			return react_jsx_runtime.jsx("div", { ref: hostRef });
		}

		/** Floating quick-access button + panel (config `fab: false` disables). */
		function mountFab() {
			var fab = el("button", "dpm-fab", null);
			fab.type = "button";
			fab.title = "打开插件管理面板";
			fab.innerHTML = ICON.plugin;
			fab.appendChild(document.createTextNode("插件管理"));
			document.body.appendChild(fab);

			var overlay = el("div", "dpm-overlay");
			var panel = el("div", "dpm-panel");
			var head = el("div", "dpm-head");
			var headIcon = el("span", "dpm-head-icon");
			headIcon.innerHTML = ICON.plugin;
			var title = el("h3", "dpm-title", "插件管理");
			var close = el("button", "dpm-icon-btn", null);
			close.type = "button";
			close.title = "关闭 (Esc)";
			close.innerHTML = ICON.close;
			head.append(headIcon, title, close);
			panel.appendChild(head);
			var body = el("div", "dpm-body");
			panel.appendChild(body);
			overlay.appendChild(panel);
			document.body.appendChild(overlay);

			var view = buildManagerView(body);

			function open() { overlay.classList.add("dpm-open"); view.refresh(false); }
			function closePanel() { overlay.classList.remove("dpm-open"); }

			fab.addEventListener("click", open);
			close.addEventListener("click", closePanel);
			overlay.addEventListener("click", function (e) { if (e.target === overlay) closePanel(); });
			document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePanel(); });
			view.refresh(true).catch(function () {});
		}

		/** Locale dictionaries for the settings tab labels. */
		var zh = { tab: "插件管理", market: "插件市场" };
		var en = { tab: "Plugin manager", market: "Plugin market" };

		/**
		 * @param {import("@deepseek-ai/dsh-client-runtime").Context} ctx
		 * @param {Record<string, any>} [config]
		 */
		function apply(ctx, config) {
			config = config ?? {};
			ensureStyle(STYLE_ID, CSS);

			if (typeof ctx.locale?.register === "function") {
				ctx.locale.register(NS, { zh: zh, en: en });
			}
			var t = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : function (key) { return key; };

			// Integrate into Settings → 插件 as tabs (平替官方管理 + 插件市场).
			if (typeof ctx.slots?.inject === "function" && typeof ctx.slots?.register === "function") {
				ctx.slots.inject("settings.plugins.tab", function () {
					return ctx.slots.register({
						name: "settings.plugins.tab",
						id: "manager",
						order: 15,
						label: function () { return t("tab"); },
						locale: NS,
						inject: function () { return {}; }
					}, ManagerSettingsTab);
				});
				ctx.slots.inject("settings.plugins.tab", function () {
					return ctx.slots.register({
						name: "settings.plugins.tab",
						id: "marketplace",
						order: 20,
						label: function () { return t("market"); },
						locale: NS,
						inject: function () { return {}; }
					}, ManagerMarketplaceTab);
				});
			}

			// Optional floating quick access (config `fab: false` disables).
			if (config.fab !== false && typeof document !== "undefined") {
				if (document.body) mountFab();
				else document.addEventListener("DOMContentLoaded", function () { mountFab(); }, { once: true });
			}
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
