import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Syntax smoke test for every script in the template, including the optional
// MCP integration. This runs offline and needs no generated reference data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectScripts(directory) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectScripts(absolute));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(absolute);
  }
  return found;
}

test('expected script entry points are present', () => {
  const required = [
    'scripts/import-catalog.mjs',
    'scripts/import-alecaframe.mjs',
    'scripts/lib/alecaframe-cache.mjs',
    'scripts/lib/collection-summary.mjs',
    'scripts/lib/time.mjs',
    'scripts/test-alecaframe.mjs',
    'scripts/test-data-files.mjs',
    'scripts/test-scripts.mjs',
    'optional/mcp/run-warframe-mcp.mjs',
    'optional/mcp/check-warframe-mcp.mjs',
    'optional/mcp/warframe-mcp-local.patch',
    'optional/mcp/README.md',
  ];
  for (const relative of required) {
    assert.ok(fs.existsSync(path.join(root, relative)), `${relative} is missing`);
  }
});

test('every .mjs file in scripts/ and optional/mcp/ passes node --check', () => {
  const files = [...collectScripts(path.join(root, 'scripts')), ...collectScripts(path.join(root, 'optional', 'mcp'))];
  assert.ok(files.length > 0, 'no .mjs files found');
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path.relative(root, file)}: ${result.stderr}`);
  }
});
