import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decryptCache, readCache, sanitizeInventory } from './lib/alecaframe-cache.mjs';
import { collectionSummaries, reconcileGoalBalances } from './lib/collection-summary.mjs';

// Self-contained fixtures: these tests never read data/catalog.json, the network
// or any personal collection, so they pass on a clean template checkout.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importScript = path.join(root, 'scripts', 'import-alecaframe.mjs');
const frame = '/Lotus/Powersuits/TestFrame/TestFrame';
const otherFrame = '/Lotus/Powersuits/TestOther/TestOther';
const blueprint = '/Lotus/Types/Recipes/WarframeRecipes/TestFrameHelmetBlueprint';
const component = blueprint.replace('Blueprint', 'Component');
const mainRecipe = '/Lotus/Types/Recipes/WarframeRecipes/TestFrameBlueprint';
const mod = '/test/mod';
const weapon = '/Lotus/Weapons/Test/TestRifle';
const secretMarker = 'leak-marker-value';

function encrypt(data) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from('LEO-ALEC\tEO-ALEC'),
    Buffer.from([49, 50, 70, 71, 66, 51, 54, 45, 76, 69, 51, 45, 113, 61, 57, 0]));
  return Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
}

function cacheFixture() {
  const seconds = Math.floor(Date.now() / 1000);
  return {
    LastInventorySync: { $oid: seconds.toString(16) + '0'.repeat(16) },
    Suits: [{ ItemType: frame, XP: 123456 }],
    MiscItems: [{ ItemType: component, ItemCount: 1 }],
    Recipes: [{ ItemType: blueprint, ItemCount: 2 }],
    PendingRecipes: [{ ItemType: mainRecipe, CompletionDate: { $date: { $numberLong: String(Date.now() - 60000) } } }],
    XPInfo: [{ ItemType: frame, XP: 123456 }],
    PlayerLevel: 12,
    RawUpgrades: [{ ItemType: mod, ItemCount: 3 }],
    Upgrades: [{ ItemType: mod, UpgradeFingerprint: '{"lvl":5}' }],
    PremiumCredits: 123,
    Mailbox: { secret: secretMarker },
    accountId: secretMarker,
    WFMarketToken: secretMarker,
  };
}

function inventoryFixture() {
  return {
    schema_version: 1,
    updated_on: null,
    coverage: 'test_fixture',
    unlisted_means: 'unknown',
    warframes: [
      { catalog_id: frame, category: 'Warframes', mastered: true, owned_quantity: 0, helminth_subsumed: false },
      { catalog_id: otherFrame, category: 'Warframes', mastered: null, owned_quantity: null, helminth_subsumed: null },
    ],
    items: [],
    crafting_jobs: [],
    notes: [],
    field_coverage: {},
    weapons: [{ catalog_id: weapon, category: 'Primary', mastered: true, owned_quantity: 5 }],
    equipment: [],
    companions: [],
    companion_weapons: [],
    mods: [],
    arcanes: [],
    unclassified_upgrades: [],
    rivens: [],
    currencies: { endo: { quantity: 42 } },
    mastery_xp_snapshot: null,
  };
}

function emptyTemplateInventory() {
  return {
    schema_version: 1,
    updated_on: null,
    coverage: 'empty_template',
    unlisted_means: 'unknown',
    warframes: [],
    items: [],
    crafting_jobs: [],
    notes: [],
    field_coverage: {},
    weapons: [],
    equipment: [],
    companions: [],
    companion_weapons: [],
    mods: [],
    arcanes: [],
    unclassified_upgrades: [],
    rivens: [],
    currencies: {},
    mastery_xp_snapshot: null,
  };
}

function createDatabase({ policy = null, inventory = inventoryFixture(), withCatalog = true, goalTarget = frame } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warframe-import-test-'));
  fs.mkdirSync(path.join(directory, 'data'));
  fs.mkdirSync(path.join(directory, 'knowledge'));
  fs.writeFileSync(path.join(directory, 'data', 'inventory.json'), JSON.stringify(inventory));
  fs.writeFileSync(path.join(directory, 'data', 'profile.json'), JSON.stringify({
    schema_version: 1,
    updated_on: null,
    timezone: 'Europe/Berlin',
    mastery_rank: null,
    collection_scope: ['base', 'prime', 'umbra'],
    preferences: { component_tracking_scope: policy },
  }));
  fs.writeFileSync(path.join(directory, 'data', 'goals.json'), JSON.stringify({
    schema_version: 1,
    updated_on: null,
    specific_targets: goalTarget ? [{ catalog_id: goalTarget, status: 'crafting', farming_required: true }] : [],
    recommendations: [],
    rules: [],
  }));
  fs.writeFileSync(path.join(directory, 'data', 'weapon-catalog.json'), JSON.stringify({
    schema_version: 1, retrieved_on: null, coverage: 'test_fixture',
    weapons: [{ id: weapon, name: { en: 'Test Rifle', ru: 'Тестовая винтовка' }, category: 'Primary' }],
  }));
  fs.writeFileSync(path.join(directory, 'data', 'equipment-catalog.json'), JSON.stringify({
    schema_version: 1, retrieved_on: null, coverage: 'test_fixture', items: [],
  }));
  if (withCatalog) {
    fs.writeFileSync(path.join(directory, 'data', 'catalog.json'), JSON.stringify({
      schema_version: 1,
      retrieved_on: null,
      warframes: [{
        id: frame,
        name: { en: 'Test Frame', ru: 'Тестовый варфрейм' },
        variant: 'base',
        final_assembly: {
          ingredients: [{ item_id: blueprint, quantity: 1 }, { item_id: component, quantity: 1 }],
        },
      }],
      items: [],
    }));
  }
  fs.writeFileSync(path.join(directory, 'data', 'journal.jsonl'), '');
  const manual = '\n## Обновления\n\n- Ручная запись 1.\n\n## История\n\n- Старый сгенерированный текст.\n';
  for (const file of ['mastery', 'weapons', 'equipment']) {
    fs.writeFileSync(path.join(directory, 'knowledge', `${file}.md`),
      `# Заглушка\n\nСтарая заглушка.\n${manual}`);
  }
  const catalogDir = path.join(directory, 'catalog');
  fs.mkdirSync(catalogDir);
  fs.writeFileSync(path.join(catalogDir, 'test.json'), JSON.stringify([
    { uniqueName: frame, name: 'Test Frame', category: 'Warframes', type: 'Warframe' },
    { uniqueName: component, name: 'Neuroptics', category: 'Components', parentUniqueNames: [frame] },
    { uniqueName: mainRecipe, name: 'Blueprint', category: 'Components', parentUniqueNames: [frame] },
    { uniqueName: mod, name: 'Example Mod', category: 'Mods' },
  ]));
  fs.writeFileSync(path.join(catalogDir, 'lang.json'), '{}');
  return { directory, catalogDir, cachePath: path.join(directory, 'lastData.dat') };
}

function runImport(database, args) {
  return spawnSync(process.execPath, [importScript, '--database', database.directory, ...args], { encoding: 'utf8' });
}

function importArgs(database, apply = false) {
  const args = ['--cache', database.cachePath, '--catalog', database.catalogDir];
  if (apply) args.push('--apply');
  return args;
}

function applyImport(database) {
  fs.writeFileSync(database.cachePath, encrypt(cacheFixture()));
  const result = runImport(database, importArgs(database, true));
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function readDatabaseFile(database, relative) {
  return JSON.parse(fs.readFileSync(path.join(database.directory, relative), 'utf8'));
}

test('both cache envelope formats decode and personal account fields are excluded', () => {
  const raw = cacheFixture();
  for (const variant of [raw, { InventoryJson: JSON.stringify(raw) }]) {
    const sanitized = sanitizeInventory(decryptCache(encrypt(variant)));
    assert.equal(sanitized.stacks.Recipes[0].quantity, 2);
    assert.equal(sanitized.upgraded_mods[0].rank, 5);
    assert.equal(JSON.stringify(sanitized).includes(secretMarker), false);
    assert.equal(JSON.stringify(sanitized).includes('PremiumCredits'), false);
    assert.equal(JSON.stringify(sanitized).includes('Mailbox'), false);
  }
  assert.throws(() => decryptCache(Buffer.alloc(17)));
  assert.throws(() => decryptCache(encrypt({ Suits: [] })));
});

test('apply sets balances, separates blueprint from built part, keeps mastery and unknown categories, repeat is a no-op', () => {
  const database = createDatabase();
  try {
    const before = readDatabaseFile(database, 'data/inventory.json');
    const result = applyImport(database);
    assert.equal(JSON.parse(result.stdout).status, 'applied');

    const inventory = readDatabaseFile(database, 'data/inventory.json');
    assert.equal(inventory.items.find(x => x.catalog_id === component && x.form === 'blueprint').quantity, 2);
    assert.equal(inventory.items.find(x => x.catalog_id === component && x.form === 'built_component').quantity, 1);
    const frameRow = inventory.warframes.find(x => x.catalog_id === frame);
    assert.equal(frameRow.owned_quantity, 1, 'ownership comes from the snapshot');
    assert.equal(frameRow.mastered, true, 'confirmed mastery is never inferred from the cache');
    const other = inventory.warframes.find(x => x.catalog_id === otherFrame);
    assert.equal(other.mastered, null, 'unknown mastery stays unknown');
    assert.equal(other.owned_quantity, 0, 'absence becomes zero only in a fully present category');
    assert.deepEqual(inventory.weapons, before.weapons, 'missing weapon categories must not zero ownership');
    assert.equal(inventory.mods[0].quantity, 4, 'stacks plus upgraded copies, no additional equipped count');
    assert.equal(inventory.currencies.endo.quantity, 42, 'missing currencies remain unchanged');
    assert.equal(inventory.currencies.credits, undefined);
    assert.equal(inventory.mastery_xp_snapshot.entries[0].catalog_id, frame);
    const job = inventory.crafting_jobs.find(x => x.catalog_id === frame);
    assert.equal(job.status, 'ready_to_claim');
    const goals = readDatabaseFile(database, 'data/goals.json');
    assert.equal(goals.specific_targets[0].status, 'owned_and_mastered');

    const journal = fs.readFileSync(path.join(database.directory, 'data', 'journal.jsonl'), 'utf8').trim().split('\n');
    assert.equal(journal.length, 1);
    const event = JSON.parse(journal[0]);
    assert.equal(event.source, 'local_alecaframe_cache_authorized_by_user');
    assert.equal(event.inventory_sync_at, inventory.last_alecaframe_sync_at);
    assert.ok(fs.existsSync(path.join(database.directory, 'data', 'backups', event.event_id, 'data', 'inventory.json')),
      'a backup of every written file is kept');
    const report = JSON.parse(fs.readFileSync(path.join(database.directory, 'data', 'imports', `${event.event_id}.json`), 'utf8'));
    assert.equal(report.timezone, 'Europe/Berlin');
    assert.equal(report.component_tracking_scope, null);
    assert.equal(report.skipped_mastered_frame_parts.length, 0);

    const mastery = fs.readFileSync(path.join(database.directory, 'knowledge', 'mastery.md'), 'utf8');
    assert.match(mastery, /## Обновления/);
    assert.match(mastery, /Ручная запись 1/);
    assert.equal(mastery.includes('Старый сгенерированный текст'), false, 'stale generated history is dropped');
    assert.match(mastery, /## История/);
    assert.match(mastery, /Освоено версий/);
    assert.match(mastery, /## Кузница/);
    for (const file of ['weapons.md', 'equipment.md']) {
      const contents = fs.readFileSync(path.join(database.directory, 'knowledge', file), 'utf8');
      assert.match(contents, /## Обновления/);
      assert.match(contents, /## История/);
    }

    const inventoryBytes = fs.readFileSync(path.join(database.directory, 'data', 'inventory.json'));
    const second = runImport(database, importArgs(database, true));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).status, 'already_imported');
    assert.deepEqual(fs.readFileSync(path.join(database.directory, 'data', 'inventory.json')), inventoryBytes);
    assert.equal(fs.readFileSync(path.join(database.directory, 'data', 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);

    fs.writeFileSync(database.cachePath, Buffer.alloc(17));
    const broken = runImport(database, importArgs(database, true));
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /import failed/i);
    assert.deepEqual(fs.readFileSync(path.join(database.directory, 'data', 'inventory.json')), inventoryBytes,
      'a broken cache must not alter the inventory');
  } finally {
    assert.equal(path.resolve(path.dirname(database.directory)), path.resolve(os.tmpdir()));
    fs.rmSync(database.directory, { recursive: true, force: true });
  }
});

test('component_tracking_scope policy skips new parts of mastered warframes without personal hardcodes', () => {
  const database = createDatabase({ policy: 'unmastered_warframes_and_explicit_targets', goalTarget: null });
  try {
    applyImport(database);
    const inventory = readDatabaseFile(database, 'data/inventory.json');
    assert.equal(inventory.items.some(x => x.catalog_id === component), false,
      'frame part stacks are skipped when the profile asks for that policy');
    const journal = JSON.parse(fs.readFileSync(path.join(database.directory, 'data', 'journal.jsonl'), 'utf8').trim());
    const report = JSON.parse(fs.readFileSync(path.join(database.directory, 'data', 'imports', `${journal.event_id}.json`), 'utf8'));
    assert.equal(report.component_tracking_scope, 'unmastered_warframes_and_explicit_targets');
    assert.equal(report.skipped_mastered_frame_parts.length, 2, 'both the blueprint and the built part are skipped');
  } finally {
    assert.equal(path.resolve(path.dirname(database.directory)), path.resolve(os.tmpdir()));
    fs.rmSync(database.directory, { recursive: true, force: true });
  }
});

test('apply works on an empty template inventory and generates the readable summaries', () => {
  const database = createDatabase({ inventory: emptyTemplateInventory(), goalTarget: null });
  try {
    const result = applyImport(database);
    assert.equal(JSON.parse(result.stdout).status, 'applied');
    const inventory = readDatabaseFile(database, 'data/inventory.json');
    const frameRow = inventory.warframes.find(x => x.catalog_id === frame);
    assert.equal(frameRow.owned_quantity, 1);
    const journalText = fs.readFileSync(path.join(database.directory, 'data', 'journal.jsonl'), 'utf8');
    assert.equal(journalText.startsWith('\n'), false, 'the first journal event is not preceded by a blank line');
    assert.equal(journalText.trim().split('\n').length, 1);
    assert.equal(frameRow.mastered, null, 'an empty base keeps mastery unknown');
    assert.equal(inventory.items.find(x => x.catalog_id === component && x.form === 'blueprint').quantity, 2);
    const catalog = readDatabaseFile(database, 'data/catalog.json');
    assert.ok(catalog.items.length > 0, 'unresolved catalog entries are appended for future runs');
    const mastery = fs.readFileSync(path.join(database.directory, 'knowledge', 'mastery.md'), 'utf8');
    assert.match(mastery, /\*\*Освоено версий: 0\. Сейчас в арсенале: 1\.\*\*/);
    assert.match(mastery, /## Обновления/);
    assert.equal(mastery.includes('Старая заглушка'), false);
    for (const file of ['weapons.md', 'equipment.md']) {
      assert.ok(fs.statSync(path.join(database.directory, 'knowledge', file)).size > 0);
    }
  } finally {
    assert.equal(path.resolve(path.dirname(database.directory)), path.resolve(os.tmpdir()));
    fs.rmSync(database.directory, { recursive: true, force: true });
  }
});

test('reconcileGoalBalances fills inventory holdings and a neutral scope note', () => {
  const salvage = '/Lotus/Types/Items/MiscItems/Salvage';
  const goals = {
    specific_targets: [{
      catalog_id: frame,
      status: 'deferred_by_user',
      resource_farm: { resources: ['Salvage'] },
      blueprint_holdings: { components: [] },
    }],
    recommendations: [{ catalog_id: frame, status: 'deferred_by_user', reason: 'Not a priority yet.' }],
  };
  const inventory = {
    last_alecaframe_sync_at: '2024-01-15T09:00:00.000Z',
    items: [
      { catalog_id: blueprint, form: 'blueprint', quantity: 2 },
      { catalog_id: component, form: 'blueprint', quantity: 1 },
      { catalog_id: component, form: 'built_component', quantity: 3 },
      { catalog_id: salvage, form: 'resource', quantity: 7 },
    ],
    warframes: [{ catalog_id: frame, mastered: false, owned_quantity: 1 }],
    crafting_jobs: [],
  };
  const frameCatalog = {
    warframes: [{
      id: frame,
      name: { en: 'Test Frame', ru: 'Тестовый варфрейм' },
      final_assembly: { ingredients: [{ item_id: blueprint, quantity: 1 }, { item_id: component, quantity: 1 }] },
    }],
    items: [],
  };
  reconcileGoalBalances(goals, inventory, frameCatalog, 'evt-1', { timezone: 'UTC' });
  const goal = goals.specific_targets[0];
  assert.deepEqual(goal.inventory_holdings.main_blueprint, { catalog_id: blueprint, quantity: 2 });
  assert.deepEqual(goal.inventory_holdings.components, [{ catalog_id: component, blueprint_quantity: 1, built_quantity: 3 }]);
  assert.equal(goal.inventory_holdings.evidence_event_id, 'evt-1');
  assert.equal(goal.resource_farm.stock_evidence_event_id, 'evt-1');
  assert.equal(goal.resource_farm.stock_snapshot_at, '2024-01-15T09:00:00.000Z');
  assert.match(goal.resource_farm.note, /AlecaFrame/);
  assert.deepEqual(goal.blueprint_holdings.main, goal.inventory_holdings.main_blueprint);
  assert.equal(goal.blueprint_holdings.current_balances_need_reconciliation, false);
  assert.deepEqual(goals.recommendations[0].inventory_holdings, goal.inventory_holdings);
  assert.match(goals.recommendations[0].reason, /Current stocks are recorded/);
  assert.match(goals.recommendation_scope_note, /Кузница пуста/);
  assert.match(goals.recommendation_scope_note, /Тестовый варфрейм/);
  assert.match(goals.recommendation_scope_note, /требуют отдельной проверки/);
  assert.equal(/DemonFrame|Caliban|Atlas/.test(goals.recommendation_scope_note), false);
});

test('collectionSummaries preserves manual updates, drops stale history and never edits README', () => {
  const inventory = {
    last_alecaframe_sync_at: '2024-01-15T09:00:00.000Z',
    warframes: [{ catalog_id: frame, mastered: true, owned_quantity: 1, helminth_subsumed: false }],
    weapons: [], equipment: [], companions: [], companion_weapons: [], crafting_jobs: [],
    items: [], mods: [], arcanes: [],
  };
  const frameCatalog = { warframes: [{ id: frame, name: { en: 'Test Frame', ru: 'Тестовый варфрейм' } }], items: [] };
  const catalogs = { weapons: { weapons: [] }, equipment: { items: [] } };
  const old = {
    'knowledge/mastery.md': '# Заглушка\n\nСтарая заглушка.\n\n## Обновления\n\n- Ручная запись 1.\n\n## История\n\n- Старый сгенерированный текст.\n',
    'knowledge/weapons.md': '',
    'knowledge/equipment.md': '',
    'README.md': 'static readme',
  };
  const writes = collectionSummaries(inventory, frameCatalog, catalogs.weapons, catalogs.equipment,
    file => old[file] ?? '', { timezone: 'UTC' });
  assert.equal(writes.has('README.md'), false, 'the template README is static and must not be rewritten');
  const mastery = writes.get('knowledge/mastery.md');
  assert.match(mastery, /Ручная запись 1/);
  assert.equal(mastery.includes('Старый сгенерированный текст'), false);
  assert.match(mastery, /## История/);
  assert.match(mastery, /Тестовый варфрейм/);
});

test('a preview from a prepared snapshot works and does not touch collection files', () => {
  const database = createDatabase();
  try {
    fs.writeFileSync(database.cachePath, encrypt(cacheFixture()));
    const snapshotPath = path.join(database.directory, 'snapshot.json');
    fs.writeFileSync(snapshotPath, JSON.stringify(readCache(database.cachePath)));
    const before = fs.readFileSync(path.join(database.directory, 'data', 'inventory.json'));
    const result = runImport(database, [...importArgs(database), '--snapshot', snapshotPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'preview');
    assert.deepEqual(fs.readFileSync(path.join(database.directory, 'data', 'inventory.json')), before);
  } finally {
    assert.equal(path.resolve(path.dirname(database.directory)), path.resolve(os.tmpdir()));
    fs.rmSync(database.directory, { recursive: true, force: true });
  }
});

test('missing reference catalog and missing cache produce clear errors without changing data', () => {
  const withoutCatalog = createDatabase({ withCatalog: false });
  try {
    const before = fs.readFileSync(path.join(withoutCatalog.directory, 'data', 'inventory.json'));
    const result = runImport(withoutCatalog, ['--cache', withoutCatalog.cachePath, '--catalog', withoutCatalog.catalogDir, '--apply']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm run catalog/);
    assert.deepEqual(fs.readFileSync(path.join(withoutCatalog.directory, 'data', 'inventory.json')), before);
  } finally {
    assert.equal(path.resolve(path.dirname(withoutCatalog.directory)), path.resolve(os.tmpdir()));
    fs.rmSync(withoutCatalog.directory, { recursive: true, force: true });
  }

  const withoutCache = createDatabase();
  try {
    const before = fs.readFileSync(path.join(withoutCache.directory, 'data', 'inventory.json'));
    const result = runImport(withoutCache, importArgs(withoutCache, true));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cache not found/i);
    assert.deepEqual(fs.readFileSync(path.join(withoutCache.directory, 'data', 'inventory.json')), before);
  } finally {
    assert.equal(path.resolve(path.dirname(withoutCache.directory)), path.resolve(os.tmpdir()));
    fs.rmSync(withoutCache.directory, { recursive: true, force: true });
  }
});


