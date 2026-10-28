import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural checks for the committed data files. Generated reference snapshots
// (data/catalog.json, data/alecaframe-catalog.json) are intentionally not required:
// a fresh clone must pass without touching the network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = file => path.join(root, 'data', file);

function readJson(file) {
  const absolute = dataPath(file);
  assert.ok(fs.existsSync(absolute), `data/${file} is missing`);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    assert.fail(`data/${file} is not valid JSON: ${error.message}`);
  }
}

function assertObject(value, label) {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
}

function assertStringOrNull(value, label) {
  assert.ok(value === null || typeof value === 'string', `${label} must be a string or null`);
}

function assertDateOrNull(value, label) {
  assertStringOrNull(value, label);
  if (typeof value === 'string') assert.match(value, /^\d{4}-\d{2}-\d{2}/, `${label} must be an ISO date`);
}

test('data/profile.json is parseable and has the required fields', () => {
  const profile = readJson('profile.json');
  assertObject(profile, 'profile');
  assert.equal(typeof profile.schema_version, 'number', 'profile.schema_version');
  assertDateOrNull(profile.updated_on, 'profile.updated_on');
  assertStringOrNull(profile.timezone, 'profile.timezone');
  if (typeof profile.timezone === 'string') {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: profile.timezone }).format(0),
      'profile.timezone must be a valid IANA time zone');
  }
  assertArray(profile.collection_scope, 'profile.collection_scope');
  assertObject(profile.preferences, 'profile.preferences');
  assert.ok(profile.mastery_rank === null || Number.isSafeInteger(profile.mastery_rank),
    'profile.mastery_rank must be an integer or null');
});

test('data/inventory.json is parseable and keeps every collection section', () => {
  const inventory = readJson('inventory.json');
  assertObject(inventory, 'inventory');
  assert.equal(typeof inventory.schema_version, 'number', 'inventory.schema_version');
  for (const section of ['warframes', 'items', 'crafting_jobs', 'notes', 'weapons', 'equipment', 'companions',
    'companion_weapons', 'mods', 'arcanes', 'unclassified_upgrades', 'rivens']) {
    assertArray(inventory[section], `inventory.${section}`);
  }
  assertObject(inventory.currencies, 'inventory.currencies');
  assertObject(inventory.field_coverage, 'inventory.field_coverage');
  assert.equal(typeof inventory.unlisted_means, 'string', 'inventory.unlisted_means');
});

test('data/goals.json is parseable and lists targets and recommendations', () => {
  const goals = readJson('goals.json');
  assertObject(goals, 'goals');
  assert.equal(typeof goals.schema_version, 'number', 'goals.schema_version');
  assertArray(goals.specific_targets, 'goals.specific_targets');
  assertArray(goals.recommendations, 'goals.recommendations');
  for (const target of goals.specific_targets) assertObject(target, 'goals.specific_targets entry');
});

test('generated-shape catalogs are parseable even when empty', () => {
  const weapons = readJson('weapon-catalog.json');
  assertObject(weapons, 'weapon-catalog');
  assert.equal(typeof weapons.schema_version, 'number', 'weapon-catalog.schema_version');
  assertArray(weapons.weapons, 'weapon-catalog.weapons');

  const equipment = readJson('equipment-catalog.json');
  assertObject(equipment, 'equipment-catalog');
  assert.equal(typeof equipment.schema_version, 'number', 'equipment-catalog.schema_version');
  assertArray(equipment.items, 'equipment-catalog.items');
});

test('every non-empty data/journal.jsonl line is a valid JSON event', () => {
  const journalPath = dataPath('journal.jsonl');
  assert.ok(fs.existsSync(journalPath), 'data/journal.jsonl is missing');
  const lines = fs.readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '');
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      assert.fail(`journal line ${index + 1} is not valid JSON: ${error.message}`);
    }
    assertObject(event, `journal line ${index + 1}`);
    assert.equal(typeof event.event_id, 'string', `journal line ${index + 1} needs a string event_id`);
  }
});
