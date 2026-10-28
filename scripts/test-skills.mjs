import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Validates the agent skills shipped with the template: one directory bundle per
// skill, YAML frontmatter the DSH/Agent Skills providers accept, and instructions
// that reference only scripts that actually exist in this repository.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, '.agents', 'skills');
const expectedSkills = [
  'warframe-catalog',
  'warframe-farm',
  'warframe-import',
  'warframe-setup',
  'warframe-status',
  'warframe-track',
];
const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A published template must not carry absolute local paths: drive letters and
// home directories are environment-specific. Generic names and game IDs are fine.
const absoluteLocalPath = /(?:^|[^A-Za-z])[A-Za-z]:[\\/]|\/home\/|\/Users\//;

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

// Minimal frontmatter reader for the flat string keys used by these skills.
// Real providers parse full YAML; keeping every shipped value on one line means
// this test fails loudly on any value the provider might read differently.
function parseSkill(text, relative) {
  assert.ok(text.startsWith('---\n'), `${relative}: frontmatter must start on the first line`);
  const end = text.indexOf('\n---', 4);
  assert.ok(end > 0, `${relative}: frontmatter must be closed with ---`);
  const data = {};
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):[ \t]+(.+)$/);
    assert.ok(match, `${relative}: unsupported frontmatter line: ${line}`);
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    data[key] = value;
  }
  return { data, body: text.slice(end + 4).replace(/^\n+/, '') };
}

function skillBundles() {
  assert.ok(fs.existsSync(skillsDir), '.agents/skills directory is missing');
  const bundles = new Map();
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (fs.existsSync(file)) bundles.set(entry.name, file);
  }
  return bundles;
}

test('skills directory contains exactly the expected one-level bundles', () => {
  assert.ok(fs.existsSync(skillsDir), '.agents/skills directory is missing');
  const direct = fs.readdirSync(skillsDir);
  for (const name of direct) {
    assert.ok(fs.statSync(path.join(skillsDir, name)).isDirectory(), `${name}: skills must be directories`);
  }
  const bundles = skillBundles();
  assert.deepEqual([...bundles.keys()].sort(), expectedSkills, 'unexpected set of skill directories');
  assert.equal(bundles.size, expectedSkills.length);
});

test('every skill has valid frontmatter and a usable description', () => {
  const bundles = skillBundles();
  for (const [directoryName, file] of bundles) {
    const relative = path.relative(root, file);
    const { data, body } = parseSkill(readText(file), relative);
    assert.equal(data.name, directoryName, `${relative}: name must match its directory`);
    assert.match(data.name, kebabCase, `${relative}: name must be kebab-case`);
    assert.equal(typeof data.description, 'string', `${relative}: description is required`);
    assert.ok(data.description.length >= 20, `${relative}: description is too short`);
    assert.ok(data.description.length <= 500, `${relative}: description exceeds the 500-character catalog cap`);
    assert.equal(data['user-invocable'], 'true', `${relative}: users invoke these skills with /name`);
    assert.ok(body.length > 400, `${relative}: instruction body looks empty`);
    assert.match(body, /^# \S/, `${relative}: body must start with an H1 heading`);
  }
});

test('skills reference only existing files and avoid absolute local paths', () => {
  const bundles = skillBundles();
  for (const [directoryName, file] of bundles) {
    const relative = path.relative(root, file);
    const text = readText(file);
    assert.equal(absoluteLocalPath.test(text), false, `${relative}: contains an absolute local path`);
    for (const match of text.matchAll(/node (scripts\/[A-Za-z0-9_./-]+\.mjs)/g)) {
      assert.ok(fs.existsSync(path.join(root, match[1])), `${relative}: references missing ${match[1]}`);
    }
    assert.ok(
      /(?:knowledge|data|scripts|optional)\//.test(text),
      `${relative}: should point the agent at repository files`,
    );
  }
});

test('no nested SKILL.md files are shipped', () => {
  // Bundle roots contain their own SKILL.md by design; only directories below
  // a bundle are checked, because providers deliberately ignore nested skills.
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      assert.equal(fs.existsSync(path.join(absolute, 'SKILL.md')), false,
        `${path.relative(root, absolute)}: nested skill bundles are not discovered by providers`);
      walk(absolute);
    }
  }
  for (const [name] of skillBundles()) walk(path.join(skillsDir, name));
});

test('skill names in the catalog do not collide with each other', () => {
  const names = [...skillBundles().keys()];
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^warframe-/, `${name}: keep the shared warframe- prefix`);
});
