import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Keep pre-0.1.5 plugins compatible with the bundled settings provider. */
export async function patchSettingsCompatibility(dshDir) {
  const entry = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js');
  const source = await readFile(entry, 'utf8');
  const exported = /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+settingsNamespace\b/.test(source)
    || [...source.matchAll(/\bexport\s*\{([^}]+)\}/g)].some((match) =>
      match[1].split(',').some((item) => /^(?:\w+\s+as\s+)?settingsNamespace$/.test(item.trim())));
  if (exported) return false;
  // Reuse the provider's own validator so validation and settings registration
  // stay aligned. Fail the build when upstream changes this known layout.
  if (!/^function parseSettingsNamespace\(value\)\s*\{/m.test(source)) {
    throw new Error('dsh-settings compatibility: expected parseSettingsNamespace validator is missing');
  }
  await writeFile(entry, source + '\n// DSH Desktop: compatibility for existing profile plugins.\nexport { parseSettingsNamespace as settingsNamespace };\n');
  return true;
}
