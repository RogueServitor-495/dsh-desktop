// dsh-plugin-manager — toolchain discovery and safe subprocess helpers.
//
// pnpm is the package manager that owns the profile directory (the same tool
// `dsh plugin --profile <name> add|remove` forwards to). It is discovered by
// config, then PATH, then the npx-store layout, then common install locations.
// On Windows we prefer pnpm's real Node entry (pnpm.cjs) so subprocesses run
// shell-free; .cmd/.bat shims fall back to cmd.exe with argument escaping.
// @ts-check

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** @param {string} file @returns {string | null} */
function existing(file) {
  if (!file) return null;
  return existsSync(file) ? file : null;
}

/** @param {string} name @returns {string | null} resolve a bin on PATH */
function onPath(name) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    if (process.platform === "win32") {
      // Prefer real executables / command shims over npm's extensionless
      // POSIX-style shim (which cannot be spawned directly on Windows).
      const win =
        existing(join(dir, name + ".exe")) ??
        existing(join(dir, name + ".cmd")) ??
        existing(join(dir, name + ".bat"));
      if (win) return win;
    }
    const candidate = existing(join(dir, name));
    if (candidate) return candidate;
  }
  return null;
}

/** npm's global bin prefix (Windows: %APPDATA%\npm; falls back to ~/AppData/Roaming/npm). */
function npmGlobalPrefix() {
  if (process.env.APPDATA) return join(process.env.APPDATA, "npm");
  return join(homedir(), "AppData", "Roaming", "npm");
}

/** pnpm's real Node entry, spawnable with `node <path>` (no shell needed). */
function pnpmNodeEntry() {
  const prefix = npmGlobalPrefix();
  if (!prefix) return null;
  const candidates = [
    join(prefix, "node_modules", "pnpm", "bin", "pnpm.cjs"),
    join(prefix, "node_modules", "pnpm", "bin", "pnpm.js")
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/** Glob-ish scan for a bin inside the npm npx store. */
function npxStoreBin(name) {
  const roots = [];
  if (process.env.npm_config_cache) roots.push(process.env.npm_config_cache);
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "npm-cache"));
  roots.push(join(homedir(), "AppData", "Local", "npm-cache"));
  roots.push(join(homedir(), ".npm"));
  for (const root of roots) {
    const npxRoot = join(root, "_npx");
    if (!existsSync(npxRoot)) continue;
    let entries;
    try { entries = readdirSync(npxRoot); } catch { continue; }
    for (const hash of entries) {
      const bin = join(npxRoot, hash, "node_modules", ".bin", name);
      if (existsSync(bin)) return bin;
      if (process.platform === "win32") {
        const win =
          existing(bin + ".exe") ??
          existing(bin + ".cmd") ??
          existing(bin + ".bat");
        if (win) return win;
      }
    }
  }
  return null;
}

/**
 * Resolve the pnpm binary (or its Node entry on Windows).
 * @param {string | undefined} configured
 * @returns {string | null} absolute path or bare name on PATH
 */
export function findPnpm(configured) {
  if (configured) return configured;
  if (process.platform === "win32") {
    return pnpmNodeEntry() ?? onPath("pnpm") ?? npxStoreBin("pnpm");
  }
  return (
    onPath("pnpm") ??
    npxStoreBin("pnpm") ??
    existing(join(homedir(), ".local", "share", "pnpm", "pnpm")) ??
    existing("/opt/homebrew/bin/pnpm") ??
    existing("/usr/local/bin/pnpm")
  );
}

/** @param {string | undefined} configured @returns {string | null} */
export function findGit(configured) {
  if (configured) return configured;
  if (process.platform === "win32") {
    return (
      onPath("git") ??
      existing("C:\\Program Files\\Git\\cmd\\git.exe") ??
      existing("C:\\Program Files\\Git\\bin\\git.exe") ??
      existing("C:\\Program Files (x86)\\Git\\cmd\\git.exe") ??
      existing(join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "cmd", "git.exe"))
    );
  }
  return onPath("git") ?? existing("/usr/bin/git") ?? existing("/opt/homebrew/bin/git");
}

/** The directory that holds the running node binary (prepended to PATH for children). */
export function nodeBinDir() {
  try {
    return dirname(process.execPath);
  } catch {
    return "";
  }
}

/** Quote one argument for a cmd.exe /c command line (best-effort, for .cmd shims). */
function cmdQuote(arg) {
  const s = String(arg);
  if (s.length === 0) return '""';
  if (!/[\s"^&|<>()%!]/.test(s)) return s;
  let out = "";
  for (const ch of s) {
    if ("^&|<>()%!".includes(ch)) out += "^" + ch;
    else if (ch === '"') out += '\\"';
    else out += ch;
  }
  return '"' + out + '"';
}

/**
 * Run a command capturing stdout/stderr.
 * On Windows: .cjs/.mjs/.js entries run via `node` (shell-free); .cmd/.bat
 * shims run via cmd.exe /c with each argument escaped; everything else spawns
 * directly. On other platforms the command is spawned directly (no shell).
 * @param {string} command absolute path or bare name
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, error?: string, signal?: string }>}
 */
export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const env = {
      ...process.env,
      PATH: [nodeBinDir(), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
      ...(options.env ?? {})
    };

    let cmd = command;
    let cmdArgs = args;
    let shell = false;
    if (process.platform === "win32") {
      if (/\.(cjs|mjs|js)$/i.test(command)) {
        // Run the Node entry with the current node binary (no shell).
        cmd = process.execPath;
        cmdArgs = [command, ...args];
      } else if (/\.(cmd|bat)$/i.test(command)) {
        // cmd.exe shim: /d disables autorun, /s strips quotes, /c runs + exits.
        cmd = process.env.ComSpec || "cmd.exe";
        cmdArgs = ["/d", "/s", "/c", [command, ...args].map(cmdQuote).join(" ")];
      }
    }

    const child = spawn(cmd, cmdArgs, {
      cwd: options.cwd,
      env,
      shell,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({ ok: false, code: null, stdout, stderr, error: `timed out after ${Math.round(timeoutMs / 1000)}s`, signal: "SIGKILL" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, code: null, stdout, stderr, error: err.message });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, code, stdout, stderr, signal: signal ?? void 0 });
    });
  });
}

/** Last N chars of a combined log, for surfacing in the UI. */
export function tail(log, n = 6000) {
  if (!log) return "";
  return log.length > n ? "…" + log.slice(-n) : log;
}
