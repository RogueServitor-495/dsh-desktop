// dsh-plugin-manager — host half.
//
// A plugin manager for dsh web profiles:
//   GET  /api/plugin-manager/state    list profile + patch rows + live loader entries
//   POST /api/plugin-manager/toggle   enable/disable an existing plugin row
//   POST /api/plugin-manager/import   install a new plugin from git URL / npm / tarball / local path
//   POST /api/plugin-manager/remove   uninstall a plugin (patch row + dependency)
//
// Durable source of truth: the profile's cordis.patch.yml (HMR-watched and
// hot-applied by dsh-app-boot) plus the profile package.json (pnpm-managed
// dependencies). Live loader mutations are best-effort conveniences on top.
// @ts-check

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { findGit, findPnpm, runCommand, tail } from "./toolchain.js";
import { appendInsert, listManagedRows, parsePatch, removeInsert, setDisabled, setOverrideDisabled } from "./patch.js";

/** Cordis plugin name — must equal the package name and bundle module id. */
const name = "dsh-plugin-manager";
/** Required services: the web route registry. Loader is read lazily. */
const inject = ["webServer"];

/** FIBER_STATE → phase label (mirrors dsh-host-plugin-inventory). */
const FIBER_PHASE = ["pending", "loading", "active", "failed", null, "unloading"];

/** @param {string} s */
function asString(s) {
  return typeof s === "string" && s.length > 0 ? s : null;
}

/** Resolve the profile directory from config + environment. */
function profileInfo(config) {
  const home = asString(config.dshHome) || asString(process.env.DSH_HOME) || join(homedir(), ".dsh");
  const profileName = asString(config.profile) || "web";
  const dir = asString(config.profileDir) || join(home, "profiles", profileName);
  return { name: profileName, home, dir };
}

/** Persistent plugin registry file inside the profile dir (records source/url/version history). */
function registryPath(profileDir) {
  return join(profileDir, ".dsh-plugin-manager.json");
}

/** @param {string} profileDir @returns {Record<string, any>} */
function readRegistry(profileDir) {
  const p = registryPath(profileDir);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** @param {string} profileDir @param {Record<string, any>} registry */
function writeRegistry(profileDir, registry) {
  writeFileSync(registryPath(profileDir), JSON.stringify(registry, null, 2) + "\n");
}

/** Normalize a git source to an https browse URL when possible. */
function sourceUrl(kind, spec, fullName) {
  if (kind === "git") {
    const m = String(spec).match(/(?:github|gitlab|bitbucket)[:.]([^/]+)\/([^#?]+)/);
    const scp = String(spec).match(/git@([^:]+):([^#?]+)/);
    const https = String(spec).match(/https?:\/\/([^/]+)\/([^#?]+)/);
    const base = m ? m[1] + "/" + m[2] : scp ? scp[2] : https ? https[2] : null;
    if (base) return "https://github.com/" + base.replace(/\.git$/, "");
  }
  if (fullName) return "https://github.com/" + fullName;
  return null;
}

/** Guess the install kind from a dependency spec. */
function guessKind(spec) {
  const s = String(spec ?? "");
  if (/^(git\+|git@|github:|gitlab:|bitbucket:)/.test(s) || s.endsWith(".git") || s.includes("#")) return "git";
  if (/^(file|link):/.test(s) || s.startsWith("/") || s.startsWith(".")) return "local";
  if (/^https?:\/\//.test(s) && /\.(tgz|tar\.gz|tar)$/i.test(s)) return "tarball";
  if (/^https?:\/\//.test(s)) return "npm";
  return "npm";
}

/** pnpm treats a directory with pnpm-workspace.yaml as a workspace root; adds need -w. */
function isWorkspaceRoot(profileDir) {
  return existsSync(join(profileDir, "pnpm-workspace.yaml"));
}

/** Official dsh packages live under the @deepseek-ai scope. */
function isOfficialModule(moduleName) {
  return typeof moduleName === "string" && moduleName.startsWith("@deepseek-ai/");
}

/** Resolve a module directory inside the profile node_modules (scoped-aware).
 * Walks up parent directories like Node's own resolver, so profiles that hoist
 * their node_modules one level up (shared across profiles) still resolve. */
function resolveModuleDir(profileDir, moduleName) {
  const rel = moduleName.startsWith("@") ? moduleName.split("/") : [moduleName];
  let base = profileDir;
  while (true) {
    const dir = join(base, "node_modules", ...rel);
    if (existsSync(dir)) return dir;
    const parent = dirname(base);
    if (parent === base) return null;
    base = parent;
  }
}

/** @param {string} dir @returns {Record<string, any> | null} */
function readJson(dir, file = "package.json") {
  const p = join(dir, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Read the profile patch file; [] when absent. */
function readPatch(profileDir) {
  const p = join(profileDir, "cordis.patch.yml");
  if (!existsSync(p)) return { content: "", rows: [] };
  const content = readFileSync(p, "utf8");
  try {
    return { content, rows: parsePatch(content) };
  } catch (error) {
    return { content, rows: [], parseError: error instanceof Error ? error.message : String(error) };
  }
}

/** @param {string} profileDir */
function readProfileManifest(profileDir) {
  const pkg = readJson(profileDir) ?? {};
  return {
    dependencies: pkg.dependencies ?? {},
    bundles: Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  };
}

/** Snapshot of live loader entries (non-group). */
function loaderEntries(ctx) {
  const loader = ctx.get("loader");
  if (loader === void 0 || typeof loader.entries !== "function") return [];
  try {
    const out = [];
    for (const entry of loader.entries()) {
      if (entry.options?.group) continue;
      out.push({
        id: entry.id,
        name: entry.options?.name ?? "",
        enabled: !entry.disabled,
        phase: entry.fiber === void 0 ? null : FIBER_PHASE[entry.fiber.state] ?? null
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Live loader entries for mutation lookup (non-group). */
function listLoaderEntriesFor(ctx) {
  const loader = ctx.get("loader");
  if (loader === void 0 || typeof loader.entries !== "function") return [];
  try {
    const out = [];
    for (const entry of loader.entries()) {
      if (entry.options?.group) continue;
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/** Toolchain availability snapshot. */
async function toolchainState(config) {
  const pnpm = findPnpm(asString(config.pnpmBin));
  const git = findGit(asString(config.gitBin));
  const pnpmVersion = pnpm
    ? await runCommand(pnpm, ["--version"], { timeoutMs: 10_000 }).then((r) => r.ok ? r.stdout.trim().split("\n")[0] : null).catch(() => null)
    : null;
  return {
    pnpm: pnpm ? { path: pnpm, version: pnpmVersion } : null,
    git: git ? { path: git } : null,
    node: process.version
  };
}

/** GitHub Search API for the official dsh-plugin topic (the plugin marketplace). */
const MARKETPLACE_URL = "https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=updated&order=desc&per_page=50";
/** Marketplace cache TTL: stay inside GitHub's anonymous rate limit. */
const MARKETPLACE_TTL_MS = 5 * 60_000;

/** @type {{ value: object, at: number } | null} */
let marketplaceCache = null;

/**
 * Fetch the dsh-plugin marketplace from the GitHub Search API.
 * @returns {Promise<{ fetchedAt: number, total: number, source: string, repos: Array<object>, rateLimit?: { limit: number, remaining: number } }>}
 */
async function fetchMarketplace() {
  if (marketplaceCache && Date.now() - marketplaceCache.at < MARKETPLACE_TTL_MS) return marketplaceCache.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res;
  try {
    res = await fetch(MARKETPLACE_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "dsh-plugin-manager" },
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error("marketplace: cannot reach GitHub API — " + (error instanceof Error ? error.message : String(error)));
  }
  clearTimeout(timer);
  if (!res.ok) {
    const err = new Error("GitHub API returned HTTP " + res.status);
    err.code = "GITHUB_API_" + res.status;
    err.status = res.status;
    const rateRemaining = res.headers.get("x-ratelimit-remaining");
    const rateLimit = res.headers.get("x-ratelimit-limit");
    if (res.status === 403 || res.status === 429) {
      err.message = "GitHub API rate limit" + (rateRemaining !== null ? " (" + rateRemaining + "/" + rateLimit + " remaining)" : "") + " — wait a moment and retry, or the topic page is temporarily unavailable";
    }
    throw err;
  }
  const data = await res.json();
  const items = (data.items ?? []).map((it) => ({
    name: it.name ?? "",
    fullName: it.full_name ?? "",
    owner: it.owner?.login ?? "",
    description: it.description ?? "",
    stars: it.stargazers_count ?? 0,
    language: it.language ?? null,
    updatedAt: it.updated_at ?? null,
    htmlUrl: it.html_url ?? "",
    archived: it.archived === true,
    standard: /^dsh-plugin-/i.test(it.name ?? ""),
    official: it.owner?.login === "deepseek-ai"
  }));
  const value = {
    fetchedAt: Date.now(),
    total: data.total_count ?? items.length,
    source: "github-search-api",
    rateLimit: {
      limit: Number(res.headers.get("x-ratelimit-limit")) || 0,
      remaining: Number(res.headers.get("x-ratelimit-remaining")) ?? 0
    },
    repos: items
  };
  marketplaceCache = { value, at: Date.now() };
  return value;
}

/** Resolve a plugin id to its management kind: a user-patch row or a bundle entry. */
function resolveTarget(rows, entries, id) {
  const patchRow = rows.find((r) => r.id === id);
  if (patchRow) return { kind: "patch", row: patchRow, entry: null };
  const entry = entries.find((e) => e.id === id || e.id.slice(e.id.lastIndexOf(":") + 1) === id);
  if (entry) return { kind: "bundle", row: null, entry };
  return null;
}

/** Build the full manager state. */
async function buildState(ctx, config) {
  const info = profileInfo(config);
  const patch = readPatch(info.dir);
  const manifest = readProfileManifest(info.dir);
  const entries = loaderEntries(ctx);
  const entriesById = new Map();
  for (const e of entries) {
    entriesById.set(e.id, e);
    entriesById.set(e.id.slice(e.id.lastIndexOf(":") + 1), e); // include:<row-id> → <row-id>
  }
  const rows = listManagedRows(patch.rows);
  const registry = readRegistry(info.dir);

  const managed = rows.map((row) => {
    const entry = entriesById.get(row.id);
    const installedDir = row.name ? resolveModuleDir(info.dir, row.name) : null;
    const pkg = installedDir ? readJson(installedDir) : null;
    return {
      id: row.id,
      name: row.name ?? row.id,
      enabled: entry ? entry.enabled : !row.disabled,
      phase: entry ? entry.phase : null,
      live: entry !== void 0,
      installed: installedDir !== null,
      installedSpec: manifest.dependencies[row.name ?? ""] ?? null,
      hasClient: pkg?.dsh?.client?.platform === "web",
      bundlePatch: pkg?.dsh?.bundle?.patch !== void 0,
      version: pkg?.version ?? null,
      description: pkg?.description ?? null,
      source: "patch",
      official: isOfficialModule(row.name ?? row.id),
      category: isOfficialModule(row.name ?? row.id) ? "official" : "external",
      installSource: registry[row.id]?.source ?? manifest.dependencies[row.name ?? ""] ?? null,
      kind: registry[row.id]?.kind ?? guessKind(manifest.dependencies[row.name ?? ""]),
      url: registry[row.id]?.url ?? sourceUrl(guessKind(manifest.dependencies[row.name ?? ""]), manifest.dependencies[row.name ?? ""], null),
      installedAt: registry[row.id]?.installedAt ?? null
    };
  });

  const managedIds = new Set(rows.map((r) => r.id));
  const isManaged = (e) =>
    managedIds.has(e.id) || managedIds.has(e.id.slice(e.id.lastIndexOf(":") + 1));
  const unmanaged = entries
    .filter((e) => !isManaged(e))
    .map((e) => ({
      ...e,
      source: "bundle",
      official: isOfficialModule(e.name),
      category: "official",
      managable: !isOfficialModule(e.name) && !String(e.name).startsWith("cordis:"),
      installed: true,
      live: true
    }));

  return {
    ok: true,
    profile: { name: info.name, dir: info.dir, exists: existsSync(info.dir) },
    toolchain: await toolchainState(config),
    installed: Object.entries(manifest.dependencies).map(([n, spec]) => ({ name: n, spec })),
    bundles: manifest.bundles,
    rows: {
      insert: rows,
      otherCount: patch.rows.length - patch.rows.filter((r) => Array.isArray(r?.insert)).length
    },
    summary: {
      managed: managed.length,
      external: managed.filter((m) => m.category === "external").length,
      official: managed.filter((m) => m.category === "official").length + unmanaged.length,
      unmanaged: unmanaged.length
    },
    managed,
    unmanagedCount: unmanaged.length,
    unmanaged: unmanaged.slice(0, 200),
    parseError: patch.parseError ?? null,
    auth: { required: asString(config.token) !== null }
  };
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

/** Read and parse a JSON request body. */
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let chunks = "";
    req.on("data", (chunk) => { chunks += chunk.toString(); });
    req.on("end", () => {
      if (!chunks.trim()) { resolvePromise({}); return; }
      try {
        resolvePromise(JSON.parse(chunks));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Write a patch file (small file; direct write keeps the HMR watcher simple). */
function writePatch(profileDir, content) {
  const p = join(profileDir, "cordis.patch.yml");
  if (!existsSync(profileDir)) throw new Error(`profile directory not found: ${profileDir}`);
  writeFileSync(p, content);
}

/** Append `dsh.profile.bundles` entry if missing. */
function ensureBundle(profileDir, packageName) {
  const manifestPath = join(profileDir, "package.json");
  const pkg = readJson(profileDir) ?? {};
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  if (bundles.includes(packageName)) return false;
  bundles.push(packageName);
  pkg.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles } };
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

/** Drop a name from `dsh.profile.bundles`. */
function dropBundle(profileDir, packageName) {
  const manifestPath = join(profileDir, "package.json");
  const pkg = readJson(profileDir) ?? {};
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const next = bundles.filter((b) => b !== packageName);
  if (next.length === bundles.length) return false;
  pkg.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: next } };
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

/** Validate and classify an import source string. */
function classifySource(source) {
  const s = String(source ?? "").trim();
  if (!s) return { error: "source is empty" };
  if (s.includes("\n") || s.includes("\r")) return { error: "source must be a single line" };
  if (/^[A-Za-z0-9._@/-]+$/.test(s) && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(s)) {
    return { kind: "npm", spec: s };
  }
  if (/^(file|link):/.test(s) || isAbsolute(s) || s === "." || s.startsWith("./") || s.startsWith("../")) {
    if (s.startsWith("file:")) {
      const rest = s.slice(5);
      if (rest.startsWith("//")) return { error: "file:// URLs are not supported; use a plain path or file:./path" };
      return { kind: "local", spec: "file:" + rest };
    }
    return { kind: "local", spec: s };
  }
  if (s.startsWith("git+") || s.endsWith(".git") || /^git@/.test(s) || /^(github|gitlab|bitbucket):/.test(s)) {
    // scp-like "git@host:path" is misread by pnpm as an alias "git" + local path;
    // normalize to the explicit git+ssh:// form (identical auth semantics).
    const scp = s.match(/^(git@[^:]+):(.*)$/);
    if (scp) return { kind: "git", spec: "git+ssh://" + scp[1] + "/" + scp[2] };
    return { kind: "git", spec: s };
  }
  if (/^https?:\/\//.test(s)) {
    if (/\.(tgz|tar\.gz|tar)$/i.test(s)) return { kind: "tarball", spec: s };
    const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/);
    if (m) {
      const repo = m[2].replace(/\.git$/, "");
      return { kind: "git", spec: `github:${m[1]}/${repo}` };
    }
    return { kind: "npm", spec: s };
  }
  if (/^[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9._-]*)?$/.test(s)) return { kind: "npm", spec: s };
  return { error: `unrecognized source: ${s}` };
}

/** Remove then re-add a dependency to force a fresh resolve (update / switch). */
async function reinstallDependency(profileDir, pnpm, packageName, spec, timeoutMs = 600_000) {
  const ws = isWorkspaceRoot(profileDir);
  const rm = await runCommand(pnpm, ["remove", ...(ws ? ["-w"] : []), packageName], { cwd: profileDir, timeoutMs: 180_000 });
  if (!rm.ok) {
    return { ok: false, step: "remove", output: tail(rm.stdout + "\n" + rm.stderr) };
  }
  const add = await runCommand(pnpm, ["add", ...(ws ? ["-w"] : []), spec], { cwd: profileDir, timeoutMs });
  if (!add.ok) {
    // best-effort restore of the previous dependency
    await runCommand(pnpm, ["add", ...(ws ? ["-w"] : []), spec], { cwd: profileDir, timeoutMs });
    return { ok: false, step: "add", output: tail(add.stdout + "\n" + add.stderr) };
  }
  return { ok: true, output: tail(add.stdout + "\n" + add.stderr) };
}

/** Append/replace a git ref (#branch|tag|commit) on a spec. */
function withRef(spec, version) {
  const s = String(spec);
  const hash = s.indexOf("#");
  const base = hash === -1 ? s : s.slice(0, hash);
  return base + "#" + version;
}

/** Sanitize a user-provided plugin row id. */
function sanitizeId(value) {
  const s = String(value ?? "").trim();
  return /^[a-z0-9][a-z0-9._-]*$/.test(s) ? s : null;
}

/** Best-effort live loader mutation. */
function loaderMutate(ctx, fn) {
  try {
    const loader = ctx.get("loader");
    if (loader === void 0) return false;
    fn(loader);
    return true;
  } catch {
    return false;
  }
}

/** Handle pnpm's blocked build-script warning by pre-approving the package. */
async function approveBuildScripts(profileDir, pnpm, packageName, log) {
  if (!/Ignored build scripts|approve-builds|build scripts of .* were ignored/i.test(log)) return null;
  const wsPath = join(profileDir, "pnpm-workspace.yaml");
  if (!existsSync(wsPath)) return null;
  let ws = readFileSync(wsPath, "utf8");
  const allowed = new Set([...(ws.match(/^\s*-\s*\S+.*$/gm) ?? [])].map((l) => l.trim().replace(/^-\s*/, "")));
  if (allowed.has(packageName)) return null;
  if (!/allowBuilds\s*:/.test(ws)) {
    ws = ws.replace(/\s*$/, "") + "\nallowBuilds:\n  - " + packageName + "\n";
  } else {
    ws = ws.replace(/^(allowBuilds:\s*)$/m, "$1\n  - " + packageName);
  }
  writeFileSync(wsPath, ws);
  const rebuild = await runCommand(pnpm, ["rebuild", ...(isWorkspaceRoot(profileDir) ? ["-w"] : []), packageName], { cwd: profileDir, timeoutMs: 180_000 });
  return rebuild.ok ? "approved build scripts for " + packageName : null;
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {Record<string, any>} config row config (profile / dshHome / pnpmBin / gitBin / token)
 */
function apply(ctx, config) {
  config = config ?? {};

  /** Auth guard for the whole route family. */
  const authorize = (req) => {
    const token = asString(config.token);
    if (token === null) return true;
    return req.headers["x-plugin-manager-token"] === token;
  };

  const routes = {
    "/api/plugin-manager/state": async (req, res) => {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "GET only" } });
      if (!authorize(req)) return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "invalid or missing x-plugin-manager-token" } });
      try {
        sendJson(res, 200, await buildState(ctx, config));
      } catch (error) {
        ctx.logger.warn("plugin-manager: state failed"); ctx.logger.warn(error);
        sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
      }
    },

    "/api/plugin-manager/marketplace": async (req, res) => {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "GET only" } });
      if (!authorize(req)) return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "invalid or missing x-plugin-manager-token" } });
      try {
        const info = profileInfo(config);
        const manifest = readProfileManifest(info.dir);
        const patch = readPatch(info.dir);
        const installedNames = new Set([
          ...listManagedRows(patch.rows).flatMap((row) => [row.id, row.name].filter(Boolean)),
          ...Object.keys(manifest.dependencies)
        ]);
        const market = await fetchMarketplace();
        market.repos = market.repos.map((repo) => ({
          ...repo,
          installed: installedNames.has(repo.name) || installedNames.has(repo.fullName.split("/").pop() ?? "")
        }));
        sendJson(res, 200, { ok: true, ...market });
      } catch (error) {
        ctx.logger.warn("plugin-manager: marketplace failed");
        ctx.logger.warn(error);
        const err = error instanceof Error ? error : new Error(String(error));
        sendJson(res, 200, { ok: false, error: { code: err.code ?? "MARKETPLACE_FAILED", message: err.message } });
      }
    },

    "/api/plugin-manager/toggle": async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } });
      if (!authorize(req)) return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "invalid or missing x-plugin-manager-token" } });
      try {
        const body = await readBody(req);
        const id = asString(body.id);
        if (!id) return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "id is required" } });
        if (typeof body.enabled !== "boolean") return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "enabled must be a boolean" } });
        const info = profileInfo(config);
        const patch = readPatch(info.dir);
        const managed = listManagedRows(patch.rows);
        const entries = listLoaderEntriesFor(ctx);
        const target = resolveTarget(managed, entries, id);
        if (!target) return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `no plugin row or bundle entry "${id}"` } });
        if (target.kind === "bundle" && target.entry && isOfficialModule(target.entry.options?.name ?? target.entry.name)) {
          return sendJson(res, 400, { ok: false, error: { code: "OFFICIAL_IMMUTABLE", message: "official built-in plugins cannot be disabled" } });
        }
        if (id === name && !body.enabled) {
          return sendJson(res, 400, { ok: false, error: { code: "SELF_DISABLE", message: "refusing to disable the plugin manager itself — edit cordis.patch.yml manually to do that" } });
        }
        // Uniform mechanism: an id-targeted disabled override in the user patch
        // layer wins for both user rows and bundle-registered rows.
        const next = setOverrideDisabled(patch.content, id, !body.enabled);
        if (next === null) return sendJson(res, 500, { ok: false, error: { code: "EDIT_FAILED", message: `could not update override for "${id}"` } });
        writePatch(info.dir, next);
        const entry = entries.find((e) => e.id === id || e.id.endsWith(":" + id));
        if (entry) loaderMutate(ctx, (loader) => { if (loader.update) loader.update(entry.id, { disabled: !body.enabled }); });
        sendJson(res, 200, { ok: true, id, enabled: body.enabled, kind: target.kind, state: await buildState(ctx, config) });
      } catch (error) {
        ctx.logger.warn("plugin-manager: toggle failed"); ctx.logger.warn(error);
        sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
      }
    },

    "/api/plugin-manager/import": async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } });
      if (!authorize(req)) return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "invalid or missing x-plugin-manager-token" } });
      try {
        const body = await readBody(req);
        const classified = classifySource(body.source);
        if (classified.error) return sendJson(res, 400, { ok: false, error: { code: "BAD_SOURCE", message: classified.error } });
        const requestedId = sanitizeId(body.id);
        const info = profileInfo(config);
        if (!existsSync(info.dir)) return sendJson(res, 400, { ok: false, error: { code: "NO_PROFILE", message: `profile directory not found: ${info.dir}` } });

        const pnpm = findPnpm(asString(config.pnpmBin));
        if (!pnpm) return sendJson(res, 500, { ok: false, error: { code: "NO_PNPM", message: "pnpm not found (set config pnpmBin or install pnpm)" } });
        if (classified.kind === "git") {
          const git = findGit(asString(config.gitBin));
          if (!git) return sendJson(res, 500, { ok: false, error: { code: "NO_GIT", message: "git not found — required for git URL imports" } });
        }

        const before = readProfileManifest(info.dir);
        const workspaceRoot = isWorkspaceRoot(info.dir);
        const timeoutMs = classified.kind === "git" ? 900_000 : classified.kind === "tarball" ? 300_000 : 120_000;
        const run = await runCommand(pnpm, ["add", ...(workspaceRoot ? ["-w"] : []), classified.spec], { cwd: info.dir, timeoutMs });

        const after = readProfileManifest(info.dir);
        let added = Object.keys(after.dependencies).find((n) => before.dependencies[n] === void 0);
        if (!added) {
          // Idempotency: an earlier interrupted install may have already recorded
          // the dependency (possibly under its real scoped name). Match by spec.
          const specHint = classified.spec.replace(/^git\+ssh:\/\//, "").replace(/^github:/, "").replace(/\.git$/, "");
          const matched = Object.entries(after.dependencies).find(([, spec]) => String(spec).includes(specHint));
          if (matched) added = matched[0];
        }

        // Guard: pnpm can record a dependency under a wrong key (scp-like git
        // URLs land as the alias "git"). Resolve the true package name from the
        // installed module and repair the manifest when they disagree.
        if (added && !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(added)) {
          const probe = readJson(join(info.dir, "node_modules", added));
          if (probe && typeof probe.name === "string" && probe.name !== added) {
            const manifestPath = join(info.dir, "package.json");
            const manifest = readJson(info.dir) ?? {};
            const deps = manifest.dependencies ?? {};
            deps[probe.name] = deps[added];
            delete deps[added];
            manifest.dependencies = deps;
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
            added = probe.name;
          }
        }

        if (!run.ok) {
          const detail = tail((run.stderr || "") + "\n" + (run.stdout || ""));
          return sendJson(res, 200, {
            ok: false,
            error: {
              code: "PNPM_FAILED",
              message: `pnpm add failed (exit ${run.code})${added ? ` — package "${added}" may be partially installed` : ""}`,
              details: detail,
              output: detail
            }
          });
        }
        if (!added) {
          return sendJson(res, 200, {
            ok: false,
            error: { code: "NO_NEW_PACKAGE", message: `pnpm add succeeded but no new dependency appeared in the profile package.json (spec ${classified.spec})` },
            output: tail(run.stdout + "\n" + run.stderr)
          });
        }

        const approval = await approveBuildScripts(info.dir, pnpm, added, run.stderr + "\n" + run.stdout);

        const moduleDir = resolveModuleDir(info.dir, added);
        const pkg = moduleDir ? readJson(moduleDir) : null;
        const hasBundlePatch = pkg?.dsh?.bundle?.patch !== void 0;
        const bundleAdded = hasBundlePatch && ensureBundle(info.dir, added);

        const id = requestedId ?? added;
        // Record source metadata in the persistent registry (url/version history).
        {
          const registry = readRegistry(info.dir);
          registry[added] = {
            id,
            packageName: added,
            source: String(body.source ?? classified.spec),
            url: sourceUrl(classified.kind, classified.spec, added.includes("/") ? added : null),
            kind: classified.kind,
            installedAt: Date.now(),
            lastVersion: pkg?.version ?? null
          };
          writeRegistry(info.dir, registry);
        }

        // Bundle-patch packages self-register through their own layer (they were
        // added to dsh.profile.bundles); appending a user-patch row too would
        // duplicate the loader entry id. Only non-bundle plugins get a row.
        let rowAdded = false;
        if (!hasBundlePatch) {
          const patch = readPatch(info.dir);
          const existing = listManagedRows(patch.rows).find((r) => r.id === id);
          if (existing) {
            return sendJson(res, 200, {
              ok: false,
              error: { code: "ALREADY_REGISTERED", message: `a plugin row with id "${id}" is already registered` },
              output: tail(run.stdout + "\n" + run.stderr)
            });
          }
          writePatch(info.dir, appendInsert(patch.content, { id, name: added }));
          rowAdded = true;
        }

        sendJson(res, 200, {
          ok: true,
          packageName: added,
          id,
          spec: classified.spec,
          kind: classified.kind,
          hasClient: pkg?.dsh?.client?.platform === "web" ?? false,
          bundleAdded,
          rowAdded,
          buildApproval: approval,
          note: hasBundlePatch
            ? "package self-registers via dsh.bundle.patch — added to profile bundles; bundle layers merge at boot, so a dsh web restart activates it"
            : "plugin row appended — the running app hot-applies it; a browser hard refresh (Cmd+Shift+R) picks up any client UI",
          output: tail(run.stdout + "\n" + run.stderr),
          state: await buildState(ctx, config)
        });
      } catch (error) {
        ctx.logger.warn("plugin-manager: import failed"); ctx.logger.warn(error);
        sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
      }
    },

    "/api/plugin-manager/update": async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } });
      if (!authorize(req)) return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "invalid or missing x-plugin-manager-token" } });
      try {
        const body = await readBody(req);
        const id = asString(body.id);
        if (!id) return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "id is required" } });
        const info = profileInfo(config);
        const patch = readPatch(info.dir);
        const managed = listManagedRows(patch.rows);
        const entries = listLoaderEntriesFor(ctx);
        const target = resolveTarget(managed, entries, id);
        if (!target) return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `no plugin row or bundle entry "${id}"` } });
        if (target.kind === "bundle" && target.entry && isOfficialModule(target.entry.options?.name ?? target.entry.name)) {
          return sendJson(res, 400, { ok: false, error: { code: "OFFICIAL_IMMUTABLE", message: "official built-in plugins cannot be updated" } });
        }
        const manifest = readProfileManifest(info.dir);
        const packageName = target.kind === "bundle" ? target.entry?.name : target.row?.name;
        if (!packageName) return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "cannot resolve package name" } });
        const currentSpec = manifest.dependencies[packageName];
        if (!currentSpec) return sendJson(res, 400, { ok: false, error: { code: "NOT_INSTALLED", message: `${packageName} has no installed dependency spec` } });
        const pnpm = findPnpm(asString(config.pnpmBin));
        if (!pnpm) return sendJson(res, 500, { ok: false, error: { code: "NO_PNPM", message: "pnpm not found" } });
        const run = await reinstallDependency(info.dir, pnpm, packageName, currentSpec);
        if (!run.ok) return sendJson(res, 200, { ok: false, error: { code: "UPDATE_FAILED", message: `update failed at ${run.step}`, details: run.output } });
        const moduleDir = resolveModuleDir(info.dir, packageName);
        const pkg = moduleDir ? readJson(moduleDir) : null;
        const registry = readRegistry(info.dir);
        if (registry[id]) {
          registry[id].lastVersion = pkg?.version ?? registry[id].lastVersion ?? null;
          registry[id].updatedAt = Date.now();
          writeRegistry(info.dir, registry);
        }
        sendJson(res, 200, {
          ok: true,
          id,
          packageName,
          version: pkg?.version ?? null,
          output: run.output,
          note: target.kind === "bundle"
            ? "dependency updated — restart dsh web to activate the new bundle layer"
            : "dependency updated — the running app hot-applies it",
          state: await buildState(ctx, config)
        });
      } catch (error) {
        ctx.logger.warn("plugin-manager: update failed"); ctx.logger.warn(error);
        sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
      }
    },

    "/api/plugin-manager/switch": async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } });
      if (!authorize(req)) return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "invalid or missing x-plugin-manager-token" } });
      try {
        const body = await readBody(req);
        const id = asString(body.id);
        const version = asString(body.version);
        if (!id || !version) return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "id and version are required" } });
        if (/[\s;|&]/.test(version)) return sendJson(res, 400, { ok: false, error: { code: "BAD_VERSION", message: "version contains invalid characters" } });
        const info = profileInfo(config);
        const patch = readPatch(info.dir);
        const managed = listManagedRows(patch.rows);
        const entries = listLoaderEntriesFor(ctx);
        const target = resolveTarget(managed, entries, id);
        if (!target) return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `no plugin row or bundle entry "${id}"` } });
        if (target.kind === "bundle" && target.entry && isOfficialModule(target.entry.options?.name ?? target.entry.name)) {
          return sendJson(res, 400, { ok: false, error: { code: "OFFICIAL_IMMUTABLE", message: "official built-in plugins cannot be switched" } });
        }
        const manifest = readProfileManifest(info.dir);
        const packageName = target.kind === "bundle" ? target.entry?.name : target.row?.name;
        const currentSpec = manifest.dependencies[packageName];
        if (!currentSpec) return sendJson(res, 400, { ok: false, error: { code: "NOT_INSTALLED", message: `${packageName} has no installed dependency spec` } });
        let newSpec;
        if (/^(file|link):/.test(currentSpec) || isAbsolute(currentSpec)) {
          return sendJson(res, 400, { ok: false, error: { code: "FILE_NOT_SWITCHABLE", message: "local file: dependencies have no version to switch" } });
        }
        if (/^(github|gitlab|bitbucket):|^git\+|^git@/.test(currentSpec)) {
          newSpec = withRef(currentSpec, version);
        } else if (/^https?:\/\//.test(currentSpec)) {
          newSpec = /^https?:\/\/(?:www\.)?github\.com\//.test(currentSpec)
            ? withRef(currentSpec.replace(/^https?:\/\/(?:www\.)?github\.com\//, "github:").replace(/\.git$/, ""), version)
            : withRef(currentSpec, version);
        } else {
          newSpec = packageName + "@" + version;
        }
        const pnpm = findPnpm(asString(config.pnpmBin));
        if (!pnpm) return sendJson(res, 500, { ok: false, error: { code: "NO_PNPM", message: "pnpm not found" } });
        const run = await reinstallDependency(info.dir, pnpm, packageName, newSpec);
        if (!run.ok) return sendJson(res, 200, { ok: false, error: { code: "SWITCH_FAILED", message: `switch failed at ${run.step}`, details: run.output } });
        const moduleDir = resolveModuleDir(info.dir, packageName);
        const pkg = moduleDir ? readJson(moduleDir) : null;
        const registry = readRegistry(info.dir);
        if (registry[id]) {
          registry[id].lastVersion = pkg?.version ?? version;
          registry[id].switchedTo = version;
          registry[id].updatedAt = Date.now();
          writeRegistry(info.dir, registry);
        }
        sendJson(res, 200, {
          ok: true,
          id,
          packageName,
          version: pkg?.version ?? version,
          spec: newSpec,
          output: run.output,
          note: target.kind === "bundle"
            ? "dependency switched — restart dsh web to activate the new bundle layer"
            : "dependency switched — the running app hot-applies it",
          state: await buildState(ctx, config)
        });
      } catch (error) {
        ctx.logger.warn("plugin-manager: switch failed"); ctx.logger.warn(error);
        sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
      }
    },

    "/api/plugin-manager/remove": async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } });
      if (!authorize(req)) return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "invalid or missing x-plugin-manager-token" } });
      try {
        const body = await readBody(req);
        const id = asString(body.id);
        if (!id) return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "id is required" } });
        const info = profileInfo(config);
        const patch = readPatch(info.dir);
        const managed = listManagedRows(patch.rows);
        const entries = listLoaderEntriesFor(ctx);
        const target = resolveTarget(managed, entries, id);
        if (!target) return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `no plugin row or bundle entry "${id}"` } });
        if (target.kind === "bundle" && target.entry && isOfficialModule(target.entry.options?.name ?? target.entry.name)) {
          return sendJson(res, 400, { ok: false, error: { code: "OFFICIAL_IMMUTABLE", message: "official built-in plugins cannot be removed" } });
        }

        let next = null;
        if (target.kind === "patch") {
          next = removeInsert(patch.content, id);
          if (next === null) return sendJson(res, 500, { ok: false, error: { code: "EDIT_FAILED", message: `could not locate insert item "${id}"` } });
        } else {
          // bundle entry: drop any disabled override + remove from bundles
          next = setOverrideDisabled(patch.content, id, false);
        }
        writePatch(info.dir, next);
        const entry = entries.find((e) => e.id === id || e.id.endsWith(":" + id));
        if (entry) loaderMutate(ctx, (loader) => { if (loader.remove) loader.remove(entry.id); });
        {
          const registry = readRegistry(info.dir);
          if (registry[id]) { delete registry[id]; writeRegistry(info.dir, registry); }
        }

        let pnpmResult = null;
        const packageName = asString(body.packageName) ?? (target.kind === "bundle" ? target.entry?.name : target.row?.name);
        if (packageName) {
          const dropped = dropBundle(info.dir, packageName);
          const pnpm = findPnpm(asString(config.pnpmBin));
          if (pnpm) {
            pnpmResult = await runCommand(pnpm, ["remove", ...(isWorkspaceRoot(info.dir) ? ["-w"] : []), packageName], { cwd: info.dir, timeoutMs: 180_000 });
          }
          if (target.kind === "bundle" && dropped) {
            // bundle layers merge at boot — fully gone after restart
            next = next + "# removed from dsh.profile.bundles; restart dsh web to fully unload\n";
          }
        }
        const removed = pnpmResult === null ? null : pnpmResult.ok;
        sendJson(res, 200, {
          ok: true,
          id,
          packageName,
          kind: target.kind,
          dependencyRemoved: removed,
          pnpmOutput: pnpmResult ? tail(pnpmResult.stdout + "\n" + pnpmResult.stderr) : null,
          note: target.kind === "bundle"
            ? "bundle entry disabled now; removed from dsh.profile.bundles — restart dsh web to fully unload it"
            : "row removed — the running app hot-unloads it",
          state: await buildState(ctx, config)
        });
      } catch (error) {
        ctx.logger.warn("plugin-manager: remove failed"); ctx.logger.warn(error);
        sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
      }
    }
  };

  ctx.effect(() => {
    const disposers = [];
    for (const [routePath, handler] of Object.entries(routes)) {
      try {
        disposers.push(ctx.webServer.register({ kind: "exact", path: routePath, handler }));
      } catch (error) {
        ctx.logger.warn(`plugin-manager: route ${routePath} registration failed`);
        ctx.logger.warn(error);
      }
    }
    ctx.logger.info(`plugin-manager: ${Object.keys(routes).length} routes registered under /api/plugin-manager`);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "plugin-manager: routes");
}

export { apply, inject, name };
