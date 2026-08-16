#!/usr/bin/env node
/**
 * bundle-runtime.mjs — build the self-contained runtime tree used by the app:
 *
 *   src-tauri/resources/runtime/
 *   ├── node-darwin-arm64/   (official Node.js LTS binary, arm64)
 *   ├── node-darwin-x64/     (official Node.js LTS binary, x64)
 *   ├── dsh/                 (self-contained npm install of @deepseek-ai/dsh + deps,
 *   │                         cross-arch native addons, and pnpm for plugin mgmt)
 *   └── versions.json        (pinned versions for display)
 *
 * The app then spawns this bundled node instead of any system node, so it runs
 * on machines without Node.js installed.
 *
 * Env overrides: BUNDLE_NODE_MAJOR (default 24 = active LTS), BUNDLE_DSH_VERSION.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RES = path.join(ROOT, "src-tauri", "resources", "runtime");
const CACHE = path.join(ROOT, ".runtime-cache");

const NODE_MAJOR = process.env.BUNDLE_NODE_MAJOR || "24";
const DSH_VERSION = process.env.BUNDLE_DSH_VERSION || "0.1.0-rc.6";
const DIST_BASE = "https://nodejs.org/dist";
// Node's child_process cannot reliably exec bare .cmd/.bat names on Windows —
// use the explicit npm.cmd there (GitHub Actions windows runners have it on PATH).
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
// Which node platforms to bundle. Default: all. CI sets e.g. "win32-x64" or
// "darwin-arm64" to keep installers small (GitHub artifacts are capped ~500MB).
const BUNDLE_PLATFORMS = (process.env.BUNDLE_PLATFORMS || "darwin-arm64,darwin-x64,win32-x64")
  .split(",").map((s) => s.trim()).filter(Boolean);
const wantPlatform = (platform, arch) => BUNDLE_PLATFORMS.includes(platform + "-" + arch);

function log(...a) { console.log("[bundle]", ...a); }
// Windows cannot spawn .cmd/.bat directly (CreateProcessW -> EINVAL); run them
// through cmd.exe /c. On unix, plain execFileSync.
function run(cmd, args, opts = {}) {
  log("$", cmd, ...args);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    return execFileSync("cmd", ["/c", cmd, ...args], { stdio: "inherit", ...opts });
  }
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}
// Like run() but captures stdout (used for "npm view").
function spawnCapture(cmd, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    return execFileSync("cmd", ["/c", cmd, ...args], { stdio: "pipe" });
  }
  return execFileSync(cmd, args, { stdio: "pipe" });
}
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("GET " + url + " -> " + r.status);
  return r.json();
}
async function download(url, dest) {
  if (existsSync(dest)) { log("cached", dest); return; }
  log("download", url);
  const r = await fetch(url);
  if (!r.ok) throw new Error("GET " + url + " -> " + r.status);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}
async function extract(archive, destDir) {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  // bsdtar (macOS/Windows) auto-detects gzip and zip; strip the top dir.
  // Use execFileSync (no shell) so Windows backslash paths are never mangled.
  run("tar", ["-xf", archive, "-C", destDir, "--strip-components=1"]);
}

// ── 1. resolve node version (latest of the chosen LTS major) ────────────────
log("resolve node v" + NODE_MAJOR + " from " + DIST_BASE + "/index.json");
const index = await fetchJson(DIST_BASE + "/index.json");
const pick = index.find((e) => e.version.startsWith("v" + NODE_MAJOR + ".") && e.lts);
if (!pick) throw new Error("no LTS release found for node v" + NODE_MAJOR);
const NODE_VERSION = pick.version; // e.g. v24.x.y
log("node version:", NODE_VERSION, "(lts:", pick.lts + ")");

// ── 2. download + extract node for macOS (arm64/x64) + Windows (x64) ──────
await mkdir(CACHE, { recursive: true });
const nodeTargets = [
  { platform: "darwin", arch: "arm64", dist: "darwin-arm64", ext: "tar.gz", bin: ["bin", "node"] },
  { platform: "darwin", arch: "x64", dist: "darwin-x64", ext: "tar.gz", bin: ["bin", "node"] },
  { platform: "win32", arch: "x64", dist: "win-x64", ext: "zip", bin: ["node.exe"] },
].filter((t) => wantPlatform(t.platform, t.arch));
if (nodeTargets.length === 0) throw new Error("BUNDLE_PLATFORMS selects no node targets: " + BUNDLE_PLATFORMS);
for (const t of nodeTargets) {
  const tag = `${t.platform}-${t.arch}`;
  const archive = `node-${NODE_VERSION}-${t.dist}.${t.ext}`;
  const local = path.join(CACHE, archive);
  const dest = path.join(RES, "node-" + tag);
  const binPath = path.join(dest, ...t.bin);
  if (existsSync(binPath)) {
    log("node", tag, "already present, keep");
    continue;
  }
  await download(`${DIST_BASE}/${NODE_VERSION}/${archive}`, local);
  await extract(local, dest);
  let ver = "extracted";
  if (t.platform === (process.platform === "win32" ? "win32" : "darwin") && process.arch === (t.arch === "arm64" ? "arm64" : "x64")) {
    try { ver = execFileSync(binPath, ["--version"]).toString().trim(); } catch { /* non-host binary */ }
  }
  log("bundled node", tag, ver);
}

// ── 3. self-contained dsh install ───────────────────────────────────────────
const dshDir = path.join(RES, "dsh");
await mkdir(dshDir, { recursive: true });
await writeFile(
  path.join(dshDir, "package.json"),
  JSON.stringify(
    {
      name: "dsh-runtime-bundle",
      private: true,
      version: "1.0.0",
      description: "Self-contained install of the DeepSeek Harness CLI + runtime deps",
      dependencies: { "@deepseek-ai/dsh": DSH_VERSION },
    },
    null,
    2
  ) + "\n"
);
const dshInstalled = existsSync(path.join(dshDir, "node_modules", "@deepseek-ai", "dsh", "package.json"));
if (!dshInstalled) {
  log("npm install @deepseek-ai/dsh@" + DSH_VERSION + " (omit dev)");
  run(NPM, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-update-notifier"], { cwd: dshDir });
} else {
  log("dsh install already present, keep");
}

// cross-arch native optional packages so the bundle works on both Apple Silicon
// and Intel Macs regardless of the build machine arch
const natives = [
  // macOS: Apple Silicon + Intel
  "node-addon-require-builtin-darwin-arm64",
  "node-addon-require-builtin-darwin-x64",
  "@img/sharp-darwin-arm64",
  "@img/sharp-darwin-x64",
  "@img/sharp-libvips-darwin-arm64",
  "@img/sharp-libvips-darwin-x64",
  "@koromix/koffi-darwin-arm64",
  "@koromix/koffi-darwin-x64",
  // Windows: x64
  "node-addon-require-builtin-win32-x64-msvc",
  "@img/sharp-win32-x64",
  "@img/sharp-libvips-win32-x64",
  "@koromix/koffi-win32-x64",
].filter((pkg) => BUNDLE_PLATFORMS.some((tag) => pkg.includes(tag)));
const resolvable = [];
for (const pkg of natives) {
  try {
    const v = spawnCapture(NPM, ["view", pkg, "version"]).toString().trim();
    resolvable.push(pkg + "@" + v);
    log("native pkg", pkg, "->", v);
  } catch {
    log("WARN: package not resolvable, skipping:", pkg);
  }
}
// Cross-arch native optional packages (so the bundle runs on both Apple
// Silicon and Intel Macs) + pnpm for plugin management — installed in ONE
// command because npm prunes extraneous (--no-save) packages on every run.
// --force: npm rejects explicit installs of packages whose os/cpu don't match
// the build machine (e.g. darwin-x64 on an arm64 Mac); we want both arches.
const extras = [...resolvable, "pnpm@9"];
const allExtrasPresent = extras.every((spec) => {
  const name = spec.split("@").slice(0, -1).join("@") || spec;
  const bare = spec.startsWith("@") ? spec.split("@").slice(0, 2).join("@") : spec.split("@")[0];
  const p = path.join(dshDir, "node_modules", ...bare.split("/"));
  return existsSync(p);
});
if (!allExtrasPresent) {
  log("npm install cross-arch natives + pnpm");
  run(NPM, ["install", "--force", "--omit=dev", "--no-save", "--no-audit", "--no-fund", "--no-update-notifier", ...extras], { cwd: dshDir });
} else {
  log("cross-arch natives + pnpm already present, keep");
}

// Replace the .bin/pnpm SYMLINK with a real arch-aware wrapper: when dsh
// spawns "pnpm" via Node's spawnSync (libuv), the shebang script is NOT
// realpath'd, so a symlink makes "require('../dist/pnpm.cjs')" resolve against
// .bin/ and fail. A real wrapper execs the bundled node with the real
// pnpm.cjs, so plugin ops work with no system node on both arches.
const pnpmReal = path.join(dshDir, "node_modules", "pnpm", "bin", "pnpm.cjs");
const binDir = path.join(dshDir, "node_modules", ".bin");
if (existsSync(pnpmReal)) {
  // POSIX wrapper (macOS / Linux)
  const pnpmSh = path.join(binDir, "pnpm");
  await rm(pnpmSh, { force: true });
  await writeFile(
    pnpmSh,
    [
      "#!/bin/sh",
      "# generated by bundle-runtime.mjs — pnpm wrapper using the bundled node",
      'here="$(cd "$(dirname "$0")" && pwd)"',
      'os="$(uname -s)"',
      '[ "$os" = "Darwin" ] && p="darwin" || p="darwin"',
      'm="$(uname -m)"',
      '[ "$m" = "arm64" ] && tag="arm64" || tag="x64"',
      'node="$here/../../../node-$p-$tag/bin/node"',
      'exec "$node" "$here/../pnpm/bin/pnpm.cjs" "$@"',
      "",
    ].join("\n")
  );
  await chmod(pnpmSh, 0o755);
  log("pnpm POSIX wrapper installed");
  // Windows wrapper (cmd)
  const pnpmCmd = path.join(binDir, "pnpm.cmd");
  await rm(pnpmCmd, { force: true });
  await writeFile(
    pnpmCmd,
    [
      "@echo off",
      "rem generated by bundle-runtime.mjs - pnpm wrapper using the bundled node",
      "setlocal",
      'set "HERE=%~dp0"',
      'if "%PROCESSOR_ARCHITECTURE%"=="ARM64" (set "TAG=arm64") else (set "TAG=x64")',
      'set "NODE=%HERE%..\..\..\node-win32-%TAG%\node.exe"',
      '"%NODE%" "%HERE%..\pnpm\bin\pnpm.cjs" %*',
      "exit /b %errorlevel%",
      "",
    ].join("\r\n")
  );
  log("pnpm Windows wrapper installed (pnpm.cmd)");
  await rm(path.join(binDir, "pnpm.ps1"), { force: true });
} else {
  log("WARN: pnpm real path missing:", pnpmReal);
}
// ── 3.5 trim (safe) ───────────────────────────────────────────────────────
// macOS node dist ships headers/man pages we never use; node-pty ships
// prebuilds for every OS; sharp ships a wasm build. Removing them keeps the
// app bundle lean. Windows pty prebuilds (win32-x64) are kept — needed there.
for (const arch of ["arm64", "x64"]) {
  if (!wantPlatform("darwin", arch)) continue;
  const nd = path.join(RES, "node-darwin-" + arch);
  await rm(path.join(nd, "include"), { recursive: true, force: true });
  await rm(path.join(nd, "share"), { recursive: true, force: true });
  await rm(path.join(nd, "CHANGELOG.md"), { force: true });
}
const ptyPre = path.join(dshDir, "node_modules", "node-pty", "prebuilds");
if (existsSync(ptyPre)) {
  const ptyKeep = new Set(BUNDLE_PLATFORMS.map((t) => t.replace("-", "-")));
  const ptyDirs = ["win32-arm64", "win32-x64", "win32-ia32", "linux-x64", "linux-arm64", "linux-arm", "linux-ia32", "freebsd-x64", "openbsd-x64", "sunos-x64"];
  for (const dir of ptyDirs) {
    if (!ptyKeep.has(dir.replace("-", "-"))) {
      await rm(path.join(ptyPre, dir), { recursive: true, force: true });
    }
  }
}
await rm(path.join(dshDir, "node_modules", "@img", "sharp-wasm32"), { recursive: true, force: true });
log("trim done");

// ── 4. verify + manifest ────────────────────────────────────────────────────
const dshPkg = JSON.parse(
  await readFile(path.join(dshDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8")
);
const binJs = path.join(dshDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (!existsSync(binJs)) throw new Error("bundled dsh bin.js missing: " + binJs);
const pnpmBin = path.join(dshDir, "node_modules", ".bin", "pnpm");
if (!existsSync(pnpmBin)) throw new Error("bundled pnpm missing: " + pnpmBin);

// smoke: bundled node (HOST platform) runs bundled dsh — CI may only have
// win32-x64 or darwin-arm64 in the tree, so never hardcode a platform.
const hostPlatform = process.platform === "win32" ? "win32" : "darwin";
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const hostNodeDir = path.join(RES, "node-" + hostPlatform + "-" + hostArch);
const hostNodeBin = process.platform === "win32"
  ? path.join(hostNodeDir, "node.exe")
  : path.join(hostNodeDir, "bin", "node");
if (!existsSync(hostNodeBin)) {
  log("WARN: no host node in bundle (" + hostNodeBin + ") — skipping smoke");
} else {
  const out = spawnCapture(hostNodeBin, [binJs, "-V"]).toString().trim();
  log("smoke: bundled node + dsh -V ->", out);
}

const manifest = {
  nodeVersion: NODE_VERSION.replace(/^v/, ""),
  nodeLts: pick.lts || null,
  dshVersion: dshPkg.version,
  platforms: BUNDLE_PLATFORMS.slice(),
  pnpm: "9",
  builtAt: new Date().toISOString(),
};
await writeFile(path.join(RES, "versions.json"), JSON.stringify(manifest, null, 2) + "\n");
log("manifest:", JSON.stringify(manifest));
const size = execFileSync("du", ["-sh", RES]).toString().trim();
log("runtime bundle size:", size, "->", RES);
log("done");
