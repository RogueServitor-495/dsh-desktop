import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { patchSettingsCompatibility } from './settings-compat.mjs';

// Validator and export layout from dsh-settings bundled with dsh 0.1.5-rc.2.
const currentSource = `const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
function parseSettingsNamespace(value) {
  if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(\`settings namespace "\${value}" must match \${String(NAMESPACE_PATTERN)}\`);
  return value;
}
class SettingsProvider {}
class SettingsConflictError extends Error {}
function redactSecrets(value) { return value; }
export { SettingsConflictError, SettingsProvider, SettingsProvider as default, redactSecrets };
`;

async function fixture(t, source = currentSource) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-settings-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-settings');
  await mkdir(path.join(packageDir, 'lib'), { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-settings', type: 'module', exports: './lib/index.js',
  }));
  const entry = path.join(packageDir, 'lib', 'index.js');
  await writeFile(entry, source);
  return { root, entry };
}

test('legacy speaker and chat-display imports load and retain namespace validation', async (t) => {
  const { root, entry } = await fixture(t);
  await patchSettingsCompatibility(root);
  const settings = await import(pathToFileURL(entry).href);
  assert.equal(settings.default, settings.SettingsProvider);
  assert.equal(typeof settings.SettingsConflictError, 'function');
  assert.equal(settings.redactSecrets('kept'), 'kept');
  for (const namespace of ['speaker', 'chat-display', 'a', 'a0-']) {
    assert.equal(settings.settingsNamespace(namespace), namespace);
  }
  for (const namespace of ['', 'Speaker', '0speaker', '-speaker', 'chat_display', 'chat.display', 'has space']) {
    assert.throws(() => settings.settingsNamespace(namespace), TypeError, namespace);
  }
  for (const namespace of ['speaker', 'chat-display']) {
    const plugin = path.join(root, `${namespace}.mjs`);
    await writeFile(plugin, `import { settingsNamespace } from '@deepseek-ai/dsh-settings';\nexport default settingsNamespace('${namespace}');\n`);
    assert.equal((await import(pathToFileURL(plugin).href)).default, namespace);
  }
});

test('running compatibility patch repeatedly does not change the patched file', async (t) => {
  const { root, entry } = await fixture(t);
  await patchSettingsCompatibility(root);
  const first = await readFile(entry, 'utf8');
  await patchSettingsCompatibility(root);
  assert.equal(await readFile(entry, 'utf8'), first);
});

test('preserves an upstream settingsNamespace export byte for byte', async (t) => {
  for (const source of [
    'export function settingsNamespace(value) { return `upstream:${value}`; }\n',
    'function legacy(value) { return value; }\nexport { legacy as settingsNamespace };\n',
  ]) {
    const { root, entry } = await fixture(t, source);
    await patchSettingsCompatibility(root);
    assert.equal(await readFile(entry, 'utf8'), source);
    assert.equal(typeof (await import(pathToFileURL(entry).href)).settingsNamespace, 'function');
  }
});

test('unknown upstream layout fails the build without modifying its source', async (t) => {
  const source = 'export default class SettingsProvider {}\n';
  const { root, entry } = await fixture(t, source);
  await assert.rejects(() => patchSettingsCompatibility(root), /settings|namespace|compat/i);
  assert.equal(await readFile(entry, 'utf8'), source);
});

test('missing settings package fails instead of silently producing a broken bundle', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-settings-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => patchSettingsCompatibility(root));
});
