// dsh-plugin-manager — cordis.patch.yml reader and surgical text editor.
//
// The patch file is the durable, HMR-watched source of truth for the plugin
// tree (dsh-app-boot's watchUserPatches reapplies it on every change). This
// module reads it with the exact YAML dialect the app uses (`!!js` scalars
// round-trip as expression nodes) and edits it with minimal text surgery so
// comments and unrelated rows are never touched. A full parse+dump rewrite is
// the fallback when the surgical path cannot locate a row.
// @ts-check

import * as yaml from "./vendor/js-yaml.mjs";

/** `!!js <expr>` scalars — same dialect as @deepseek-ai/dsh-app-boot. */
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (data) => typeof data === "string",
  construct: (data) => ({ __jsExpr: data }),
  predicate: (data) => data !== null && typeof data === "object" && "__jsExpr" in data,
  represent: (data) => data.__jsExpr
});

/** The entry-list YAML dialect of every dsh patch file. */
export const patchSchema = yaml.JSON_SCHEMA.extend(JsExpr);

/** Parse a patch file into its row list ([] for an empty file). */
export function parsePatch(content) {
  if (typeof content !== "string" || content.trim() === "") return [];
  const parsed = yaml.load(content, { schema: patchSchema });
  if (parsed === void 0 || parsed === null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error("cordis.patch.yml must be a top-level YAML array of loader patch entries");
  }
  return parsed;
}

/** Round-trip a row list back to YAML (used only as a rewrite fallback). */
export function dumpPatch(rows) {
  return yaml.dump(rows, { schema: patchSchema, lineWidth: -1, noRefs: true });
}

/**
 * Describe one `- insert:` item plus any id-targeted `disabled` override row.
 * @param {Array<Record<string, any>>} rows parsed patch rows
 * @returns {Array<{ id: string, name?: string, disabled: boolean, config?: any, group?: boolean, raw: any }>}
 */
export function listManagedRows(rows) {
  const inserts = [];
  const overrides = new Map();
  for (const row of rows) {
    if (row !== null && typeof row === "object") {
      if (Array.isArray(row.insert)) {
        for (const item of row.insert) {
          if (item && typeof item === "object" && typeof item.id === "string") {
            inserts.push({
              id: item.id,
              name: typeof item.name === "string" ? item.name : void 0,
              disabled: item.disabled === true,
              config: item.config,
              group: item.group === true,
              raw: item
            });
          }
        }
      } else if (typeof row.id === "string") {
        // id-targeted override rows: only `disabled`/config overrides interest us
        overrides.set(row.id, { disabled: row.disabled === true, raw: row });
      }
    }
  }
  return inserts.map((entry) => {
    const override = overrides.get(entry.id);
    return { ...entry, disabled: entry.disabled || (override ? override.disabled : false) };
  });
}

/** Quote a YAML scalar for use inside a patch row (single-quoted when needed). */
export function yamlScalar(value) {
  if (typeof value === "string" && /^[A-Za-z0-9._/@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * Find the line range of an insert item with the given id.
 * Returns { start, end, indent } line indices (0-based, end exclusive) or null.
 */
function findInsertItemBlock(lines, id) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*([\'\"]?)([^\'\"]+?)\2\s*$/);
    if (!m) continue;
    if (m[3].trim() !== id) continue;
    const indent = m[1].length;
    const dashCol = m[0].indexOf("-");
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() === "" || line.trimStart().startsWith("#")) {
        end += 1;
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      // a sibling item or any less-indented line ends the block
      if (lineIndent <= indent) break;
      end += 1;
    }
    return { start: i, end, indent, dashCol };
  }
  return null;
}

/** Find the line range of an id-targeted override row (`- id: <id>` at top level). */
function findOverrideRowBlock(lines, id) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^-\s+id:\s*([\'\"]?)([^\'\"]+?)\1\s*$/);
    if (!m) continue;
    if (m[2].trim() !== id) continue;
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() === "") { end += 1; continue; }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= 1) break;
      end += 1;
    }
    return { start: i, end };
  }
  return null;
}

/**
 * Append an `- insert:` row (with one item) to the patch text.
 */
export function appendInsert(content, item) {
  const lines = [
    "",
    "- insert:",
    `    - id: ${yamlScalar(item.id)}`,
  ];
  if (typeof item.name === "string" && item.name.length > 0) {
    lines.push(`      name: '${item.name}'`);
  }
  if (item.disabled === true) {
    lines.push("      disabled: true");
  }
  if (item.config !== void 0 && item.config !== null && typeof item.config === "object") {
    const dumped = yaml.dump(item.config, { schema: patchSchema, lineWidth: -1, noRefs: true })
      .split("\n").filter((l) => l.trim() !== "");
    lines.push("      config:");
    for (const l of dumped) lines.push("        " + l);
  }
  const text = content.endsWith("\n") ? content : content + "\n";
  return text + lines.join("\n") + "\n";
}

/**
 * Set the effective enabled state via an id-targeted `disabled` override row,
 * independent of any insert block. This is the uniform enable/disable mechanism
 * for BOTH user-patch rows and bundle-registered rows (the user patch layer is
 * applied after bundle layers, so a `disabled` override wins for either).
 * Returns the edited text (unchanged when already in the requested state).
 */
export function setOverrideDisabled(content, id, disabled) {
  const lines = content.split("\n");
  const override = findOverrideRowBlock(lines, id);
  const overrideHasDisabled = override
    ? /disabled\s*:/.test(lines.slice(override.start, override.end).join("\n"))
    : false;
  if (!disabled && overrideHasDisabled) {
    lines.splice(override.start, override.end - override.start);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  }
  if (disabled && !overrideHasDisabled) {
    let text = content.endsWith("\n") ? content : content + "\n";
    text += "- id: " + yamlScalar(id) + "\n  disabled: true\n";
    return text;
  }
  return content;
}

/** Drop top-level `- insert:` headers that ended up with no items. */
function pruneEmptyInserts(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isHeader = /^-\s*insert:\s*$/.test(line);
    if (!isHeader) { out.push(line); continue; }
    // look ahead past blanks/comments for the next meaningful line
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || lines[j].trimStart().startsWith("#"))) j += 1;
    const next = lines[j];
    // keep the header only when it still has at least one item after it
    const hasItems = next !== void 0 && /^-\s*[^\s]/.test(next.trimStart());
    if (hasItems) out.push(line);
  }
  return out;
}

/**
 * Remove an insert item with the given id (and any override row for it).
 * Returns the edited text, or null when the item could not be found.
 */
export function removeInsert(content, id) {
  const lines = content.split("\n");
  const block = findInsertItemBlock(lines, id);
  let changed = false;
  if (block) {
    lines.splice(block.start, block.end - block.start);
    changed = true;
  }
  // drop id-targeted override rows for this id that only carry disabled
  const override = findOverrideRowBlock(lines, id);
  if (override) {
    // only remove if the block has a disabled key (a config override row is data, leave it)
    const blockLines = lines.slice(override.start, override.end).join("\n");
    if (/disabled\s*:/.test(blockLines)) {
      lines.splice(override.start, override.end - override.start);
      changed = true;
    }
  }
  if (!changed) return null;
  return pruneEmptyInserts(lines).join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/**
 * Set the effective enabled state of an insert item by appending/removing an
 * id-targeted `disabled` override row. Returns the edited text or null when
 * the insert item cannot be located.
 */
export function setDisabled(content, id, disabled) {
  const lines = content.split("\n");
  const block = findInsertItemBlock(lines, id);
  if (!block) return null;
  const override = findOverrideRowBlock(lines, id);
  const overrideHasDisabled = override
    ? /disabled\s*:/.test(lines.slice(override.start, override.end).join("\n"))
    : false;

  if (!disabled && overrideHasDisabled) {
    lines.splice(override.start, override.end - override.start);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  if (disabled && !overrideHasDisabled) {
    let text = content.endsWith("\n") ? content : content + "\n";
    text += `- id: ${yamlScalar(id)}\n  disabled: true\n`;
    return text;
  }
  return content; // already in the requested state
}
