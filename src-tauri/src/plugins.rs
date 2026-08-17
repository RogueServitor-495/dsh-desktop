//! DSH profile plugin management: list installed plugins with versions and
//! enablement, import/remove via pnpm (through the dsh plugin command with an
//! npx-based pnpm shim), and enable/disable via an app-owned patch overlay.
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
    pub description: String,
    pub kind: String,
    pub enabled: bool,
    pub recorded: bool,
    pub source: String,
    pub row_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub dsh_version: String,
    pub node_version: String,
    pub profile: String,
    pub profile_dir: String,
    pub plugin_count: usize,
    pub overlay_path: String,
    /// whether the app-owned overlay file exists (the runtime boots with --patch when it does)
    pub overlay: bool,
}

#[derive(Debug)]
struct PatchRow {
    id: Option<String>,
    name: Option<String>,
    disabled: Option<bool>,
}

pub fn dsh_home() -> PathBuf {
    std::env::var("DSH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".dsh"))
                .unwrap_or_else(|_| PathBuf::from("~/.dsh"))
        })
}

pub fn profile_dir(profile: &str) -> PathBuf {
    dsh_home().join("profiles").join(profile)
}

pub fn overlay_path(profile: &str) -> PathBuf {
    profile_dir(profile).join("manager.patch.yml")
}

fn read_text(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("cannot create dir: {e}"))?;
    }
    std::fs::write(path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

fn read_json(path: &Path) -> Result<Json, String> {
    let text = read_text(path)?;
    serde_json::from_str(&text).map_err(|e| format!("bad JSON in {}: {e}", path.display()))
}

fn str_of(v: Option<&serde_yaml::Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).map(String::from)
}

fn bool_of(v: Option<&serde_yaml::Value>) -> Option<bool> {
    v.and_then(|v| v.as_bool())
}

/// Collect patch rows (id/name/disabled) from a cordis patch file.
fn collect_rows(path: &Path) -> Vec<PatchRow> {
    let Ok(text) = read_text(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&text) else {
        return Vec::new();
    };
    let Some(items) = value.as_sequence() else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for item in items {
        let Some(map) = item.as_mapping() else {
            continue;
        };
        if let Some(insert) = map.get("insert").and_then(|v| v.as_sequence()) {
            for sub in insert {
                if let Some(m) = sub.as_mapping() {
                    rows.push(PatchRow {
                        id: str_of(m.get("id")),
                        name: str_of(m.get("name")),
                        disabled: bool_of(m.get("disabled")),
                    });
                }
            }
        } else if map.contains_key("id") {
            rows.push(PatchRow {
                id: str_of(map.get("id")),
                name: str_of(map.get("name")),
                disabled: bool_of(map.get("disabled")),
            });
        }
    }
    rows
}

/// Read a plugin's manifest from the profile node_modules (follows symlinks).
fn read_plugin_manifest(profile_dir: &Path, name: &str) -> Option<Json> {
    let path = profile_dir.join("node_modules").join(name).join("package.json");
    read_json(&path).ok()
}

fn plugin_version(manifest: &Json) -> String {
    manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string()
}

fn plugin_description(manifest: &Json) -> String {
    manifest
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// A plugin whose manifest declares dsh.bundle is a profile layer.
fn is_bundle_manifest(manifest: &Json) -> bool {
    manifest.get("dsh").and_then(|d| d.get("bundle")).is_some()
}

/// List installed plugins: node_modules scan merged with recorded deps and
/// bundles, annotated with version and enablement.
pub fn list_plugins(profile: &str) -> Vec<PluginInfo> {
    let dir = profile_dir(profile);
    let mut out: Vec<PluginInfo> = Vec::new();

    let mut deps: BTreeMap<String, String> = BTreeMap::new();
    let mut bundles: Vec<String> = Vec::new();
    let pkg_path = dir.join("package.json");
    if let Ok(pkg) = read_json(&pkg_path) {
        if let Some(d) = pkg.get("dependencies").and_then(|v| v.as_object()) {
            for (k, v) in d {
                deps.insert(k.clone(), v.as_str().unwrap_or("").to_string());
            }
        }
        if let Some(b) = pkg
            .get("dsh")
            .and_then(|d| d.get("profile"))
            .and_then(|p| p.get("bundles"))
            .and_then(|v| v.as_array())
        {
            for v in b {
                if let Some(s) = v.as_str() {
                    bundles.push(s.to_string());
                }
            }
        }
    }

    let mut rows: Vec<PatchRow> = Vec::new();
    rows.extend(collect_rows(&dir.join("cordis.patch.yml")));
    rows.extend(collect_rows(&overlay_path(profile)));

    let mut names: Vec<String> = Vec::new();
    let nm = dir.join("node_modules");
    if let Ok(entries) = std::fs::read_dir(&nm) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".pnpm" || name == ".bin" || name == ".modules.yaml" || name == "package.json" {
                continue;
            }
            if name.starts_with('@') && e.path().is_dir() {
                if let Ok(sub) = std::fs::read_dir(e.path()) {
                    for s in sub.flatten() {
                        let sub_name = s.file_name().to_string_lossy().into_owned();
                        names.push(format!("{name}/{sub_name}"));
                    }
                }
            } else {
                names.push(name);
            }
        }
    }
    let seen: std::collections::BTreeSet<String> = names.iter().cloned().collect();
    for k in deps.keys() {
        if !seen.contains(k) {
            names.push(k.clone());
        }
    }
    for b in &bundles {
        if !seen.contains(b) {
            names.push(b.clone());
        }
    }

    for name in names {
        let manifest = read_plugin_manifest(&dir, &name);
        let actual_name = manifest
            .as_ref()
            .and_then(|m| m.get("name"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| name.clone());
        let is_bundle = bundles.iter().any(|b| b == &actual_name)
            || manifest.as_ref().map(is_bundle_manifest).unwrap_or(false);
        // later rows win per field (overlay overrides the profile layer);
        // match by name OR row id (the app's overlay rows use id == plugin name)
        let row = rows.iter().rev().find(|r| {
            r.name.as_deref() == Some(actual_name.as_str())
                || r.id.as_deref() == Some(actual_name.as_str())
        });
        let enabled = is_bundle || row.map(|r| r.disabled != Some(true)).unwrap_or(false);
        let recorded = deps.contains_key(&actual_name);
        let source = deps.get(&actual_name).cloned().unwrap_or_default();
        let version = match &manifest {
            Some(m) => plugin_version(m),
            None if is_bundle => "内置".to_string(),
            None => "未安装".to_string(),
        };
        out.push(PluginInfo {
            name: actual_name,
            version,
            description: manifest.as_ref().map(plugin_description).unwrap_or_default(),
            kind: if is_bundle { "bundle".into() } else { "plugin".into() },
            enabled,
            recorded,
            source,
            row_id: row.and_then(|r| r.id.clone()),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Ensure pnpm is resolvable: prefer the bundled pnpm shipped inside the app
/// (works with the bundled node, no system Node needed), then PATH, else create
/// an npx shim so the dsh plugin forwarder finds a pnpm binary.
/// Returns extra PATH entries to prepend.
fn ensure_pnpm(data_dir: &Path) -> Result<Vec<String>, String> {
    if let Some(p) = crate::paths::bundled_pnpm_bin() {
        let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
        return Ok(vec![dir.display().to_string()]);
    }
    let probe = crate::paths::which("pnpm");
    if let Some(p) = probe {
        if p.is_file() {
            return Ok(Vec::new());
        }
    }
    let shim_dir = data_dir.join("bin");
    std::fs::create_dir_all(&shim_dir).map_err(|e| format!("cannot create shim dir: {e}"))?;
    let shim = shim_dir.join("pnpm");
    write_text(&shim, "#!/bin/sh\nexec npx --yes pnpm@9 \"$@\"\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755));
    }
    Ok(vec![shim_dir.to_string_lossy().into_owned()])
}

fn tail(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let mut s: Vec<char> = text.chars().collect();
        let skip = s.len() - max_chars;
        s.drain(..skip);
        s.into_iter().collect()
    }
}

/// Run one dsh plugin operation (add/remove/...) with pnpm resolvable.
pub fn run_plugin_op(
    data_dir: &Path,
    profile: &str,
    node: &Path,
    dsh_bin: &Path,
    pnpm_args: &[String],
    cwd: &Path,
) -> Result<String, String> {
    let shim_dirs = ensure_pnpm(data_dir)?;
    let base_path = crate::paths::child_path();
    let full_path = if shim_dirs.is_empty() {
        base_path
    } else {
        format!("{}:{}", shim_dirs.join(":"), base_path)
    };
    let mut cmd = Command::new(node);
    cmd.arg(dsh_bin)
        .arg("plugin")
        .arg("--profile")
        .arg(profile)
        .args(pnpm_args)
        .current_dir(cwd)
        .env("PATH", full_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::paths::hide_console(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("failed to run dsh plugin: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("failed waiting for pnpm: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(format!(
            "pnpm failed (exit {:?}):\n{}",
            out.status.code(),
            tail(&text, 3000)
        ));
    }
    Ok(tail(&text, 3000))
}

/// Write the app-owned overlay: rows that enable/disable patch-row plugins.
fn write_overlay(profile: &str, rows: Vec<serde_yaml::Value>) -> Result<(), String> {
    let path = overlay_path(profile);
    if rows.is_empty() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("cannot remove overlay: {e}"))?;
        }
        return Ok(());
    }
    let mut text = "# DSH Manager overlay (app-managed; later rows win per id)\n\n".to_string();
    for item in &rows {
        text.push_str(&yaml_row(item));
    }
    write_text(&path, &text)
}

/// YAML-safe single-quoted scalar.
fn yq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Serialize one overlay item with the exact indentation the cordis loader
/// expects: insert sub-items at 4 spaces, row keys at 2 spaces.
fn yaml_row(item: &serde_yaml::Value) -> String {
    let Some(map) = item.as_mapping() else {
        return String::new();
    };
    if let Some(insert) = map.get("insert").and_then(|v| v.as_sequence()) {
        let mut out = String::from("- insert:\n");
        for sub in insert {
            if let Some(m) = sub.as_mapping() {
                let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                out.push_str(&format!("    - id: {}\n", yq(id)));
                out.push_str(&format!("      name: {}\n", yq(name)));
            }
        }
        return out;
    }
    if let Some(id) = map.get("id").and_then(|v| v.as_str()) {
        let mut out = format!("- id: {}\n", yq(id));
        if let Some(d) = map.get("disabled") {
            if let Some(b) = d.as_bool() {
                out.push_str(&format!("  disabled: {}\n", b));
            }
        }
        return out;
    }
    String::new()
}

fn overlay_rows(profile: &str) -> Vec<serde_yaml::Value> {
    let path = overlay_path(profile);
    let Ok(text) = read_text(&path) else {
        return Vec::new();
    };
    serde_yaml::from_str::<Vec<serde_yaml::Value>>(&text).unwrap_or_default()
}

fn row_matches(m: &serde_yaml::Mapping, name: &str) -> bool {
    m.get("name").and_then(|v| v.as_str()) == Some(name)
        || m.get("id").and_then(|v| v.as_str()) == Some(name)
}

/// Remove rows whose name/id matches the plugin name from the overlay.
fn remove_overlay_rows(profile: &str, name: &str) -> Result<(), String> {
    let rows = overlay_rows(profile);
    let kept: Vec<serde_yaml::Value> = rows
        .into_iter()
        .filter_map(|item| {
            let Some(map) = item.as_mapping() else {
                return Some(item);
            };
            if let Some(list) = map.get("insert").and_then(|v| v.as_sequence()) {
                let subs: Vec<serde_yaml::Value> = list
                    .iter()
                    .filter(|sub| sub.as_mapping().map(|m| !row_matches(m, name)).unwrap_or(true))
                    .cloned()
                    .collect();
                if subs.is_empty() {
                    return None;
                }
                let mut new_map = serde_yaml::Mapping::new();
                new_map.insert(
                    serde_yaml::Value::String("insert".into()),
                    serde_yaml::Value::Sequence(subs),
                );
                return Some(serde_yaml::Value::Mapping(new_map));
            }
            if row_matches(map, name) {
                None
            } else {
                Some(item)
            }
        })
        .collect();
    write_overlay(profile, kept)
}

/// Enable/disable a plugin. Bundles toggle the profile bundle list; patch-row
/// plugins toggle the app-owned overlay (later rows win per field).
pub fn set_plugin_enabled(profile: &str, name: &str, enabled: bool) -> Result<(), String> {
    let dir = profile_dir(profile);
    let manifest = read_plugin_manifest(&dir, name);
    let is_bundle = manifest.as_ref().map(is_bundle_manifest).unwrap_or(false);
    if is_bundle {
        let pkg_path = dir.join("package.json");
        let mut pkg = read_json(&pkg_path)?;
        let profile_obj = pkg
            .get_mut("dsh")
            .and_then(|d| d.get_mut("profile"))
            .ok_or_else(|| "profile manifest has no dsh.profile".to_string())?;
        let bundles = profile_obj
            .get_mut("bundles")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| "dsh.profile.bundles is not a list".to_string())?;
        if enabled {
            if !bundles.iter().any(|b| b.as_str() == Some(name)) {
                bundles.push(Json::String(name.to_string()));
            }
        } else {
            bundles.retain(|b| b.as_str() != Some(name));
        }
        let pretty = serde_json::to_string_pretty(&pkg).map_err(|e| format!("serialize manifest: {e}"))?;
        write_text(&pkg_path, &format!("{pretty}\n"))?;
        return Ok(());
    }
    // patch-row plugin: rewrite the app-owned overlay
    let rows = overlay_rows(profile);
    let kept: Vec<serde_yaml::Value> = rows
        .into_iter()
        .filter_map(|item| {
            let Some(map) = item.as_mapping() else {
                return Some(item);
            };
            if let Some(list) = map.get("insert").and_then(|v| v.as_sequence()) {
                let subs: Vec<serde_yaml::Value> = list
                    .iter()
                    .filter(|sub| sub.as_mapping().map(|m| !row_matches(m, name)).unwrap_or(true))
                    .cloned()
                    .collect();
                if subs.is_empty() {
                    return None;
                }
                let mut new_map = serde_yaml::Mapping::new();
                new_map.insert(
                    serde_yaml::Value::String("insert".into()),
                    serde_yaml::Value::Sequence(subs),
                );
                return Some(serde_yaml::Value::Mapping(new_map));
            }
            if row_matches(map, name) {
                None
            } else {
                Some(item)
            }
        })
        .collect();
    let mut final_rows = kept;
    let mut sub = serde_yaml::Mapping::new();
    sub.insert(serde_yaml::Value::String("id".into()), serde_yaml::Value::String(name.into()));
    sub.insert(serde_yaml::Value::String("name".into()), serde_yaml::Value::String(name.into()));
    let mut insert_item = serde_yaml::Mapping::new();
    insert_item.insert(
        serde_yaml::Value::String("insert".into()),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(sub)]),
    );
    final_rows.push(serde_yaml::Value::Mapping(insert_item));
    if !enabled {
        let mut dis = serde_yaml::Mapping::new();
        dis.insert(serde_yaml::Value::String("id".into()), serde_yaml::Value::String(name.into()));
        dis.insert(serde_yaml::Value::String("disabled".into()), serde_yaml::Value::Bool(true));
        final_rows.push(serde_yaml::Value::Mapping(dis));
    }
    write_overlay(profile, final_rows)
}

/// Remove a plugin: pnpm remove, then drop patch rows (overlay + profile layer).
pub fn remove_plugin(
    data_dir: &Path,
    profile: &str,
    name: &str,
    node: &Path,
    dsh_bin: &Path,
    cwd: &Path,
) -> Result<String, String> {
    let args = vec!["remove".to_string(), name.to_string(), "-w".to_string()];
    let out = run_plugin_op(data_dir, profile, node, dsh_bin, &args, cwd)?;
    let _ = remove_overlay_rows(profile, name);
    let profile_patch = profile_dir(profile).join("cordis.patch.yml");
    let _ = remove_patch_rows_line_based(&profile_patch, name);
    Ok(out)
}

/// Recursive directory copy (std-only; used to seed the built-in plugin).
fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("cannot create {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("cannot read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read dir entry: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| format!("file type: {e}"))?.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("cannot copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// Ensure the built-in dsh-plugin-manager plugin is available and enabled:
/// 1) copy the bundled package into the profile's node_modules so it resolves
///    offline without a pnpm install (only when missing, never overwriting),
/// 2) enable it via the app-owned overlay (manager.patch.yml, passed with
///    --patch). Idempotent: existing overlay rows are preserved and the insert
///    row is only added once, so user edits are never clobbered.
pub fn ensure_default_plugins(profile: &str) -> Result<(), String> {
    if let Some(bundled) = crate::paths::bundled_plugin_dir() {
        let dest = profile_dir(profile).join("node_modules").join("dsh-plugin-manager");
        if !dest.join("package.json").is_file() {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create profile node_modules: {e}"))?;
            }
            copy_dir(&bundled, &dest)?;
        }
    }
    let mut rows = overlay_rows(profile);
    let already = rows.iter().any(|item| {
        item.as_mapping()
            .and_then(|m| m.get("insert"))
            .and_then(|v| v.as_sequence())
            .map_or(false, |subs| {
                subs.iter()
                    .any(|s| s.as_mapping().map(|m| row_matches(m, "dsh-plugin-manager")).unwrap_or(false))
            })
    });
    if already {
        return Ok(());
    }
    let mut sub = serde_yaml::Mapping::new();
    sub.insert(
        serde_yaml::Value::String("id".into()),
        serde_yaml::Value::String("dsh-plugin-manager".into()),
    );
    sub.insert(
        serde_yaml::Value::String("name".into()),
        serde_yaml::Value::String("dsh-plugin-manager".into()),
    );
    let mut insert_item = serde_yaml::Mapping::new();
    insert_item.insert(
        serde_yaml::Value::String("insert".into()),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(sub)]),
    );
    rows.push(serde_yaml::Value::Mapping(insert_item));
    write_overlay(profile, rows)
}

/// Line-based removal of patch rows referencing the target from a patch file,
/// preserving comments and unrelated structure. Returns true when changed.
fn remove_patch_rows_line_based(path: &Path, target: &str) -> Result<bool, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(false);
    };
    let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if indent != 2 && indent != 6 {
            continue;
        }
        if !trimmed.starts_with("name:") {
            continue;
        }
        let value = trimmed["name:".len()..].trim();
        let value = value.trim_matches(|c| c == '\'' || c == '"');
        if value != target {
            continue;
        }
        let item_indent = if indent == 2 { 0 } else { 4 };
        let mut start = i;
        while start > 0 {
            let prev = &lines[start - 1];
            let pt = prev.trim_start();
            let pi = prev.len() - pt.len();
            if pt.starts_with("- ") && pi == item_indent {
                start -= 1; // include the item start line itself
                break;
            }
            start -= 1;
        }
        let mut end = i + 1;
        while end < lines.len() {
            let l = &lines[end];
            let t = l.trim_start();
            let ind = l.len() - t.len();
            if ind <= item_indent && (t.starts_with("- ") || !t.is_empty()) {
                break;
            }
            end += 1;
        }
        ranges.push((start, end));
    }
    if ranges.is_empty() {
        return Ok(false);
    }
    ranges.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in ranges {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }
    let mut final_ranges: Vec<(usize, usize)> = Vec::new();
    for (s, e) in &merged {
        let mut s = *s;
        let e = *e;
        if s > 0 {
            let above = lines[s - 1].trim_start().to_string();
            if above.starts_with("- insert:") {
                let more_subs = e < lines.len()
                    && lines[e].trim_start().starts_with("- ")
                    && (lines[e].len() - lines[e].trim_start().len()) == 4;
                if !more_subs {
                    s -= 1;
                    if s > 0 && lines[s - 1].trim().is_empty() {
                        s -= 1;
                    }
                }
            }
        }
        final_ranges.push((s, e));
    }
    let mut result = String::new();
    let mut prev = 0;
    for (s, e) in &final_ranges {
        result.push_str(&lines[prev..*s].join("\n"));
        prev = *e;
        result.push('\n');
    }
    result.push_str(&lines[prev..].join("\n"));
    let mut collapsed = String::new();
    let mut blanks = 0usize;
    for l in result.split('\n') {
        if l.trim().is_empty() {
            if blanks < 1 {
                collapsed.push('\n');
            }
            blanks += 1;
        } else {
            collapsed.push_str(l);
            collapsed.push('\n');
            blanks = 0;
        }
    }
    let collapsed = collapsed.trim_end().to_string() + "\n";
    write_text(path, &collapsed)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_fake_profile() -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("dsh-mgr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("DSH_HOME", &home);
        let dir = profile_dir("test-profile");
        std::fs::create_dir_all(dir.join("node_modules/fake-plugin-a")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/fake-bundle")).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{
  "name": "dsh-profile-test",
  "private": true,
  "dependencies": { "fake-plugin-a": "^1.0.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "fake-bundle"] } }
}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("node_modules/fake-plugin-a/package.json"),
            r#"{ "name": "fake-plugin-a", "version": "1.0.0", "main": "lib/index.js" }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("node_modules/fake-bundle/package.json"),
            r#"{ "name": "fake-bundle", "version": "2.0.0", "dsh": { "bundle": { "patch": "x" } } }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("cordis.patch.yml"),
            "- insert:\n    - id: fake-plugin-a\n      name: 'fake-plugin-a'\n",
        )
        .unwrap();
        home
    }

    #[test]
    fn list_enable_disable_and_bundle_toggle() {
        let home = setup_fake_profile();

        let plugins = list_plugins("test-profile");
        let a = plugins.iter().find(|p| p.name == "fake-plugin-a").unwrap();
        assert_eq!(a.version, "1.0.0");
        assert_eq!(a.kind, "plugin");
        assert!(a.enabled, "patch row should enable it");
        assert!(a.recorded);
        let b = plugins.iter().find(|p| p.name == "fake-bundle").unwrap();
        assert_eq!(b.kind, "bundle");
        assert!(b.enabled);

        // disable the patch-row plugin via overlay
        set_plugin_enabled("test-profile", "fake-plugin-a", false).unwrap();
        let overlay_text = std::fs::read_to_string(overlay_path("test-profile")).unwrap();
        assert!(overlay_text.contains("disabled: true"), "overlay: {overlay_text}");
        let plugins = list_plugins("test-profile");
        assert!(!plugins.iter().find(|p| p.name == "fake-plugin-a").unwrap().enabled);

        // re-enable
        set_plugin_enabled("test-profile", "fake-plugin-a", true).unwrap();
        let plugins = list_plugins("test-profile");
        assert!(plugins.iter().find(|p| p.name == "fake-plugin-a").unwrap().enabled);
        let overlay_text = std::fs::read_to_string(overlay_path("test-profile")).unwrap();
        assert!(!overlay_text.contains("disabled: true"), "overlay: {overlay_text}");

        // bundle toggle: remove from bundles list
        set_plugin_enabled("test-profile", "fake-bundle", false).unwrap();
        let pkg: Json = serde_json::from_str(
            &std::fs::read_to_string(profile_dir("test-profile").join("package.json")).unwrap(),
        )
        .unwrap();
        let bundles = pkg["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].as_str().unwrap(), "@deepseek-ai/dsh-base");

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn line_based_removal_preserves_comments() {
        // copy the REAL web profile patch to temp and remove one insert row
        let home = std::env::temp_dir().join(format!("dsh-mgr-remove-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let real = "/Users/snake/.dsh/profiles/web/cordis.patch.yml";
        let copy = home.join("cordis.patch.yml");
        std::fs::copy(real, &copy).unwrap();
        let before = std::fs::read_to_string(&copy).unwrap();
        assert!(before.contains("dsh-plugin-deepseek-usage"));

        let changed = remove_patch_rows_line_based(&copy, "dsh-plugin-deepseek-usage").unwrap();
        assert!(changed);
        let after = std::fs::read_to_string(&copy).unwrap();
        assert!(!after.contains("deepseek-usage"), "row not removed: {after}");
        assert!(after.contains("webserver"), "unrelated row lost: {after}");
        assert!(after.contains("#"), "comments lost: {after}");
        // must still parse as YAML
        serde_yaml::from_str::<serde_yaml::Value>(&after).expect("patch must parse");

        let _ = std::fs::remove_dir_all(&home);
    }
}
