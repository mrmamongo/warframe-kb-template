import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCache, readCatalog } from './lib/alecaframe-cache.mjs';
import { reconcileGoalBalances, collectionSummaries } from './lib/collection-summary.mjs';
import { dayInTimeZone, resolveTimeZone } from './lib/time.mjs';

// Imports a local AlecaFrame inventory cache into the knowledge base.
// Nothing is sent over the network and every written file is backed up first.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const templateRoot = path.resolve(scriptDirectory, '..');
const argv = process.argv.slice(2);
const option = name => {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1] ?? null;
};
const apply = argv.includes('--apply');
const root = path.resolve(option('--database') ?? templateRoot);

function defaultCachePath() {
  // AlecaFrame is a Windows application; keep a readable fallback for other systems.
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'AlecaFrame', 'lastData.dat');
}

const cachePath = path.resolve(option('--cache') ?? defaultCachePath());
const catalogDirectory = path.resolve(option('--catalog') ?? path.join(path.dirname(cachePath), 'cachedData', 'json'));
const snapshotOption = option('--snapshot');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${relative}: ${error.message}`);
  }
}

function ensureArray(container, key) {
  if (!Array.isArray(container[key])) container[key] = [];
  return container[key];
}

async function main() {
  // The generated reference catalog is a prerequisite; it is not committed to git.
  if (!fs.existsSync(path.join(root, 'data', 'catalog.json'))) {
    throw new Error('Missing data/catalog.json. Run `npm run catalog` first to download the reference catalog (network access required).');
  }
  const frameCatalog = readJson('data/catalog.json');
  const inventory = readJson('data/inventory.json');
  const profile = readJson('data/profile.json');
  const goals = readJson('data/goals.json');
  const weaponCatalog = readJson('data/weapon-catalog.json');
  const equipmentCatalog = readJson('data/equipment-catalog.json');

  let snapshot;
  if (snapshotOption) {
    const snapshotPath = path.resolve(snapshotOption);
    try {
      snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read snapshot ${snapshotPath}: ${error.message}`);
    }
  } else {
    snapshot = readCache(cachePath);
  }
  const v = snapshot?.inventory;
  const source = snapshot?.source;
  if (!v || typeof v !== 'object' || !v.owned || !v.stacks) {
    throw new Error('Snapshot inventory is incomplete or has an unsupported shape');
  }
  if (!source || typeof source !== 'object' || !source.inventory_sync_at || !source.sha256) {
    throw new Error('Snapshot source must include inventory_sync_at and sha256');
  }
  const catalog = readCatalog(catalogDirectory);

  // Make sure every section the importer touches exists, even on a hand-edited database.
  for (const key of ['warframes', 'items', 'crafting_jobs', 'weapons', 'equipment', 'companions',
    'companion_weapons', 'mods', 'arcanes', 'unclassified_upgrades', 'rivens', 'notes']) {
    ensureArray(inventory, key);
  }
  if (!inventory.field_coverage || typeof inventory.field_coverage !== 'object') inventory.field_coverage = {};
  if (!inventory.currencies || typeof inventory.currencies !== 'object') inventory.currencies = {};
  if (!profile.preferences || typeof profile.preferences !== 'object') profile.preferences = {};
  ensureArray(goals, 'specific_targets');
  ensureArray(goals, 'recommendations');
  ensureArray(frameCatalog, 'warframes');
  ensureArray(frameCatalog, 'items');
  ensureArray(weaponCatalog, 'weapons');
  ensureArray(equipmentCatalog, 'items');

  const journalPath = path.join(root, 'data', 'journal.jsonl');
  const journal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : '';
  const events = journal.trim().split(/\r?\n/).filter(Boolean).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error('data/journal.jsonl contains a malformed JSON line; fix the journal before importing');
    }
  });

  // The event id is derived from the snapshot bytes so a repeat import is a no-op.
  const syncAt = source.inventory_sync_at;
  const utcDate = dayInTimeZone(syncAt, 'UTC');
  const date = dayInTimeZone(syncAt, resolveTimeZone(profile));
  if (!utcDate || !date) throw new Error(`Cannot derive a calendar date from inventory_sync_at: ${syncAt}`);
  const eventId = `alecaframe-${utcDate}-${source.sha256.slice(0, 16)}`;
  if (events.some(event => event.event_id === eventId)) {
    console.log(json({ status: 'already_imported', event_id: eventId, inventory_sync_at: syncAt }));
    return;
  }
  // Reject stale or replayed snapshots before interpreting absence as zero.
  const syncTime = Date.parse(syncAt);
  const fileTime = Date.parse(source.file_modified_at);
  if (!Number.isFinite(syncTime) || !Number.isFinite(fileTime) || Math.abs(fileTime - syncTime) > 300000) {
    throw new Error('Cannot establish cache freshness: the inventory sync marker and the cache file time disagree');
  }
  if (apply && (Date.now() - syncTime > 86400000 || syncTime - Date.now() > 300000)) {
    throw new Error('Cache is over 24 hours old or dated in the future; refresh AlecaFrame before applying');
  }
  const lastSyncTime = inventory.last_alecaframe_sync_at ? Date.parse(inventory.last_alecaframe_sync_at) : NaN;
  if (Number.isFinite(lastSyncTime) && syncTime <= lastSyncTime) {
    throw new Error('Cache is not newer than the last imported snapshot');
  }

  const componentScope = profile.preferences.component_tracking_scope ?? null;
  const skipMasteredFrameParts = componentScope === 'unmastered_warframes_and_explicit_targets';
  const report = {
    schema_version: 1,
    event_id: eventId,
    status: apply ? 'applied' : 'preview',
    source,
    timezone: resolveTimeZone(profile),
    decoder_reference: 'https://github.com/Sainan/alecaframe-inventory-parser/blob/senpai/script.pluto',
    snapshot_file: `evidence/alecaframe/${eventId}.json`,
    catalog_files: catalog.files,
    component_tracking_scope: componentScope,
    changed_ownership: [],
    new_collection_records: [],
    unresolved_ids: [],
    skipped_mastered_frame_parts: [],
    mastery_policy: 'Existing user-confirmed mastery preserved. Cache affinity saved separately; no mastery inferred from current copy XP.',
    excluded: ['Account identifiers and credentials', 'Loadouts, equipment instance IDs and custom names',
      'Settings, mail, contacts and account history', 'Cosmetics, quest state and Railjack state',
      'Helminth absorption (not established by this cache schema)', 'Riven rolls and stat fingerprints'],
  };
  const stamp = () => ({ reported_on: date, evidence_event_id: eventId, snapshot_at: syncAt });
  const importedCatalog = new Map();
  function ensureCatalog(id) {
    const item = catalog.entry(id);
    importedCatalog.set(item.id, item);
    if (!item.source_resolved && !report.unresolved_ids.includes(id)) report.unresolved_ids.push(id);
    return item;
  }
  const collectionCatalogs = {
    warframes: frameCatalog.warframes,
    weapons: weaponCatalog.weapons,
    equipment: equipmentCatalog.items,
    companions: equipmentCatalog.items,
    companion_weapons: equipmentCatalog.items,
  };
  const fieldGroups = { warframes: ['Suits'], weapons: ['LongGuns', 'Pistols', 'Melee'],
    equipment: ['SpaceSuits', 'SpaceGuns', 'SpaceMelee', 'MechSuits', 'OperatorAmps'],
    companions: ['Sentinels', 'KubrowPets', 'MoaPets'], companion_weapons: ['SentinelWeapons'] };
  const categoryMap = { LongGuns: 'Primary', Pistols: 'Secondary', Melee: 'Melee', SpaceSuits: 'Archwing',
    SpaceGuns: 'Arch-Gun', SpaceMelee: 'Arch-Melee', MechSuits: 'Necramech', OperatorAmps: 'Amp',
    Sentinels: 'Sentinels', KubrowPets: 'Pets', MoaPets: 'Pets', SentinelWeapons: 'SentinelWeapons' };
  const ownershipCounts = {};
  for (const [section, fields] of Object.entries(fieldGroups)) {
    const counts = new Map(), itemFields = new Map(), instances = new Map();
    for (const field of fields) for (const instance of v.owned[field] ?? []) {
      const id = catalog.ownedId(instance);
      // Modular kitguns and Zaws are separate equipment, not an additional ordinary gun/melee copy.
      if (section === 'weapons' && id !== catalog.resolve(instance.item_type)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1); itemFields.set(id, field);
      const list = instances.get(id) ?? []; list.push(instance); instances.set(id, list);
    }
    if (section === 'equipment') for (const field of ['LongGuns', 'Pistols', 'Melee']) for (const instance of v.owned[field] ?? []) {
      const id = catalog.ownedId(instance);
      if (id === catalog.resolve(instance.item_type)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1); itemFields.set(id, field);
      const list = instances.get(id) ?? []; list.push(instance); instances.set(id, list);
    }
    const rows = inventory[section];
    for (const [id] of counts) if (!rows.some(x => x.catalog_id === id)) {
      const item = ensureCatalog(id), category = categoryMap[itemFields.get(id)] ?? item.category;
      rows.push({ catalog_id: id, category, mastered: null, owned_quantity: null,
        ...(section === 'warframes' ? { helminth_subsumed: null } : {}) });
      report.new_collection_records.push({ section, id, name: item.name });
      const list = collectionCatalogs[section];
      if (!list.some(x => (x.id ?? x.catalog_id) === id)) {
        list.push({ id, name: item.name, category, type: item.type, wiki_url: item.wiki_url,
          source: 'AlecaFrame cached static catalog', evidence_event_id: eventId,
          ...(section === 'equipment' ? { tracking_group: item.name.en === 'Dokrahm' ? 'zaw_strikes' :
            /ModularSecondary/.test(id) ? 'kitgun_chambers' : category } : {}) });
      }
    }
    for (const row of rows) {
      // A missing category is not an empty category.
      if (!counts.has(row.catalog_id) && !fields.every(field => Object.hasOwn(v.owned, field))) continue;
      if (section === 'equipment' && !counts.has(row.catalog_id) &&
        !['LongGuns', 'Pistols', 'Melee'].every(field => Object.hasOwn(v.owned, field))) continue;
      const quantity = counts.get(row.catalog_id) ?? 0;
      if (row.owned_quantity !== quantity) report.changed_ownership.push({ section, id: row.catalog_id,
        name: catalog.entry(row.catalog_id).name, previous_quantity: row.owned_quantity,
        previous_minimum: row.minimum_owned_quantity ?? null, quantity });
      row.owned_quantity = quantity; row.minimum_owned_quantity = quantity;
      if (section !== 'warframes') row.owned = quantity > 0;
      row.ownership_evidence_event_id = eventId; row.ownership_snapshot_at = syncAt;
      if (instances.has(row.catalog_id)) {
        row.cached_instances = instances.get(row.catalog_id).map(x => ({ current_copy_xp: x.xp, modular_parts: x.modular_parts }));
        if (instances.get(row.catalog_id).some(x => x.modular_parts)) {
          row.configuration = { modular_parts_by_copy: instances.get(row.catalog_id).map(x => x.modular_parts),
            custom_name: null, evidence_event_id: eventId };
        }
      } else delete row.cached_instances;
    }
    ownershipCounts[section] = { unique_types: counts.size, copies: [...counts.values()].reduce((a, b) => a + b, 0) };
  }

  const explicitTargets = new Set(goals.specific_targets.map(x => x.catalog_id));
  const masteredFrames = new Set(inventory.warframes.filter(x => x.mastered === true).map(x => x.catalog_id));
  const oldItemKeys = new Set(inventory.items.map(x => `${x.form}|${x.catalog_id}`));
  const stacks = new Map();
  function addStack(raw, form, sourceField) {
    const id = catalog.resolve(raw.item_type), key = `${form}|${id}`, meta = ensureCatalog(id);
    // Optional policy: skip routine tracking of frame parts of already mastered warframes, except explicit goals.
    if (skipMasteredFrameParts && !oldItemKeys.has(key) && meta.parent_ids.length &&
      meta.parent_ids.every(parent => masteredFrames.has(parent) && !explicitTargets.has(parent))) {
      report.skipped_mastered_frame_parts.push({ id, form, quantity: raw.quantity });
      return;
    }
    const entry = stacks.get(key) ?? { catalog_id: id, form, quantity: 0, source_field: sourceField, source_item_types: [] };
    entry.quantity += raw.quantity;
    if (!entry.source_item_types.includes(raw.item_type)) entry.source_item_types.push(raw.item_type);
    stacks.set(key, entry);
  }
  for (const raw of v.stacks.Recipes ?? []) addStack(raw, 'blueprint', 'Recipes');
  for (const raw of v.stacks.MiscItems ?? []) {
    const meta = catalog.entry(raw.item_type);
    const form = meta.category === 'Relics' ? 'relic' : meta.type === 'Resource' || meta.category === 'Resources' ? 'resource'
      : meta.category === 'Components' ? 'built_component' : 'misc_item';
    addStack(raw, form, 'MiscItems');
  }
  for (const raw of v.stacks.Consumables ?? []) addStack(raw, 'gear', 'Consumables');
  for (const old of inventory.items) {
    const key = `${old.form}|${old.catalog_id}`;
    const sourceField = old.form === 'blueprint' ? 'Recipes' : old.form === 'gear' ? 'Consumables' : 'MiscItems';
    if (!stacks.has(key) && Object.hasOwn(v.stacks, sourceField)) stacks.set(key,
      { catalog_id: old.catalog_id, form: old.form, quantity: 0, source_field: sourceField, source_item_types: [] });
  }
  for (const [key, entry] of stacks) {
    let row = inventory.items.find(x => `${x.form}|${x.catalog_id}` === key);
    if (!row) { row = {}; inventory.items.push(row); }
    Object.assign(row, entry, stamp(), { minimum_quantity: entry.quantity, balance_reconciliation_needed: false });
    delete row.form_interpretation;
    if (row.note) { row.previous_note = row.note; delete row.note; }
    if (row.balance_reconciliation_event_id) delete row.balance_reconciliation_event_id;
  }

  // RawUpgrades are stacks; Upgrades are individual upgraded copies. Do not count equipped copies again.
  const modCounts = new Map();
  function addMod(id, quantity, rank, bucket) {
    const item = ensureCatalog(id), row = modCounts.get(id) ?? { catalog_id: id, category: item.category,
      quantity: 0, rank_counts: [], ...stamp() };
    row.quantity += quantity;
    let variant = row.rank_counts.find(x => x.rank === rank && x.storage === bucket);
    if (!variant) { variant = { rank, storage: bucket, quantity: 0 }; row.rank_counts.push(variant); }
    variant.quantity += quantity; modCounts.set(id, row);
  }
  for (const x of v.stacks.RawUpgrades ?? []) addMod(x.item_type, x.quantity, 0, 'unranked_stack');
  for (const x of v.upgraded_mods ?? []) addMod(x.item_type, 1, x.rank, 'individual_upgrade');
  if (v.present_fields.includes('RawUpgrades') && v.present_fields.includes('Upgrades')) {
    inventory.mods = [...modCounts.values()].filter(x => x.category === 'Mods');
    inventory.arcanes = [...modCounts.values()].filter(x => x.category === 'Arcanes');
    inventory.unclassified_upgrades = [...modCounts.values()].filter(x => !['Mods', 'Arcanes'].includes(x.category));
  }
  if (v.present_fields.includes('XPInfo')) inventory.mastery_xp_snapshot = { source: 'XPInfo',
    meaning: 'Historical affinity; retained without automatically changing user-confirmed mastery',
    ...stamp(), entries: (v.mastery_xp ?? []).map(x => ({ catalog_id: catalog.resolve(x.item_type), xp: x.xp })) };
  if (Number.isSafeInteger(v.credits) && v.credits >= 0) inventory.currencies.credits = { quantity: v.credits, ...stamp() };
  if (Number.isSafeInteger(v.endo) && v.endo >= 0) inventory.currencies.endo = { quantity: v.endo, ...stamp() };

  const pendingResults = new Set();
  for (const recipe of v.pending_recipes ?? []) {
    const recipeMeta = catalog.entry(recipe.item_type);
    // Main recipes have exactly one product parent. Components retain their own collection identity.
    const mainRecipe = catalog.items.get(catalog.resolve(recipe.item_type))?.name === 'Blueprint';
    const resultId = mainRecipe && recipeMeta.parent_ids.length === 1 ? recipeMeta.parent_ids[0] : catalog.resolve(recipe.item_type);
    const meta = ensureCatalog(resultId);
    const form = meta.category === 'Warframes' ? 'warframe' : ['Primary', 'Secondary', 'Melee'].includes(meta.category) ? 'weapon'
      : meta.category === 'Components' ? 'built_component' : 'misc_item';
    pendingResults.add(resultId);
    // Component recipes resolve to generic names such as "Systems"; keep a readable parent-qualified label.
    const parentName = recipeMeta.parent_ids.length === 1 ? catalog.entry(recipeMeta.parent_ids[0]).name : null;
    const qualify = (value, parent, join) => !value ? null : parent && !value.includes(parent) ? `${parent}${join}${value}` : value;
    const displayName = {};
    const displayEn = qualify(meta.name.en, parentName?.en, ' '), displayRu = qualify(meta.name.ru, parentName?.ru, ': ');
    if (displayEn) displayName.en = displayEn;
    if (displayRu) displayName.ru = displayRu;
    let job = inventory.crafting_jobs.find(x => x.catalog_id === resultId && !/claimed/.test(x.status));
    if (!job) { job = { catalog_id: resultId, form, quantity: 1, started_at: null }; inventory.crafting_jobs.push(job); }
    Object.assign(job, { recipe_catalog_id: recipe.item_type, display_name: displayName, ready_at: recipe.ready_at,
      status: recipe.ready_at && recipe.ready_at <= syncAt ? 'ready_to_claim' : 'in_progress',
      source: 'alecaframe_pending_recipes', ...stamp() });
  }
  for (const job of inventory.crafting_jobs) if (!pendingResults.has(job.catalog_id) && !/claimed/.test(job.status)) {
    const owned = [...inventory.warframes, ...inventory.weapons, ...inventory.equipment]
      .find(x => x.catalog_id === job.catalog_id && x.owned_quantity > 0);
    if (owned && v.present_fields.includes('PendingRecipes')) {
      job.status = 'claimed_inferred_from_owned_inventory'; job.claimed_at = null; job.completion_evidence_event_id = eventId;
    } else if (v.present_fields.includes('PendingRecipes')) {
      job.status = 'not_in_pending_queue_outcome_unknown'; job.queue_evidence_event_id = eventId;
    }
  }
  for (const goal of goals.specific_targets) {
    const job = inventory.crafting_jobs.find(x => x.catalog_id === goal.catalog_id);
    if (pendingResults.has(goal.catalog_id)) {
      goal.status = job.status === 'ready_to_claim' ? 'ready_to_claim' : 'crafting'; goal.ready_at = job.ready_at;
      goal.farming_required = false; goal.next_step = 'claim_when_ready_then_master'; goal.latest_inventory_event_id = eventId;
    } else if (job?.status === 'claimed_inferred_from_owned_inventory') {
      goal.status = 'owned_awaiting_mastery'; goal.farming_required = false; goal.next_step = 'master_owned_frame';
      goal.ready_at = null; goal.latest_inventory_event_id = eventId;
    }
    if (goal.blueprint_holdings) {
      goal.blueprint_holdings.current_balances_need_reconciliation = false;
      for (const part of goal.blueprint_holdings.components ?? []) {
        const row = inventory.items.find(x => x.catalog_id === part.catalog_id && x.form === 'blueprint');
        if (row) Object.assign(part, { quantity: row.quantity, minimum_quantity: row.quantity, owned: row.quantity > 0,
          note: 'Current balance from the AlecaFrame inventory snapshot', evidence_event_id: eventId });
      }
    }
    if (goal.resource_farm?.resources) goal.resource_farm.stock_quantities = Object.fromEntries(goal.resource_farm.resources.map(name => {
      const item = [...catalog.items.values()].find(x => x.name === name);
      const stock = inventory.items.find(x => x.catalog_id === item?.uniqueName && x.form === 'resource');
      return [name, stock?.quantity ?? (v.present_fields.includes('MiscItems') && item ? 0 : null)];
    }));
  }
  // Reconcile goal status with the fresh ownership snapshot; never contradict a frame that is still in the Foundry.
  const activeFrames = new Set(inventory.crafting_jobs
    .filter(j => ['in_progress', 'ready_to_claim'].includes(j.status)).map(j => j.catalog_id));
  for (const goal of goals.specific_targets) {
    const row = inventory.warframes.find(x => x.catalog_id === goal.catalog_id);
    if (!row) continue;
    if (row.owned_quantity > 0) {
      goal.status = row.mastered === true ? 'owned_and_mastered' : 'owned_awaiting_mastery';
      goal.farming_required = false; goal.ready_at = null;
      goal.next_step = row.mastered === true ? null : 'master_owned_frame';
      goal.latest_inventory_event_id = eventId;
    } else if (!activeFrames.has(goal.catalog_id) && ['owned_awaiting_mastery', 'crafting', 'ready_to_claim'].includes(goal.status)) {
      goal.status = 'absent_in_current_snapshot'; goal.farming_required = null;
      goal.next_step = 'confirm_outcome_then_reacquire_if_needed'; goal.latest_inventory_event_id = eventId;
    }
  }
  for (const recommendation of goals.recommendations) {
    const goal = goals.specific_targets.find(x => x.catalog_id === recommendation.catalog_id);
    if (goal && ['crafting', 'ready_to_claim', 'owned_awaiting_mastery'].includes(goal.status)) {
      recommendation.status = goal.status; recommendation.latest_inventory_event_id = eventId;
      if (Array.isArray(recommendation.unknown_requirements) && recommendation.unknown_requirements.some(x => /Ready time|Post-crafting resource/.test(x))) {
        recommendation.unknown_requirements = recommendation.unknown_requirements.filter(x => !/Ready time|Post-crafting resource/.test(x));
      }
    }
  }
  if (Number.isSafeInteger(v.mastery_rank)) profile.mastery_rank = v.mastery_rank;
  profile.updated_on = date;
  profile.mastery_rank_evidence_event_id = eventId;
  profile.tracking_method = 'assistant_maintained_user_reports_and_local_alecaframe_snapshots';
  goals.updated_on = date;
  inventory.updated_on = date;
  inventory.last_alecaframe_sync_at = syncAt;
  inventory.last_alecaframe_event_id = eventId;
  inventory.coverage = 'user_confirmed_mastery_and_alecaframe_inventory_snapshot';
  inventory.field_coverage.ownership = { status: 'complete_in_imported_cache_categories', ...ownershipCounts, evidence_event_id: eventId };
  inventory.field_coverage.weapons = { status: 'cache_snapshot_ownership_user_confirmed_mastery',
    mastered: inventory.weapons.filter(x => x.mastered === true).length,
    currently_owned: inventory.weapons.filter(x => x.owned_quantity > 0).length, evidence_event_id: eventId };
  inventory.field_coverage.components = { status: skipMasteredFrameParts
    ? 'cache_snapshot_with_mastered_frame_part_preference' : 'cache_snapshot_full_frame_parts', evidence_event_id: eventId };
  inventory.field_coverage.extra_equipment = { status: 'cache_snapshot_ownership_user_confirmed_mastery',
    mastered: [...inventory.equipment, ...inventory.companions, ...inventory.companion_weapons].filter(x => x.mastered === true).length,
    owned: [...inventory.equipment, ...inventory.companions, ...inventory.companion_weapons].filter(x => x.owned_quantity > 0).length,
    evidence_event_id: eventId };
  report.counts = { ownership: ownershipCounts, stack_records: stacks.size,
    positive_stacks_by_form: Object.fromEntries([...new Set(inventory.items.map(x => x.form))].map(form => [form,
      inventory.items.filter(x => x.form === form && x.quantity > 0).length])),
    mods: inventory.mods.length, mod_copies: inventory.mods.reduce((n, x) => n + x.quantity, 0),
    arcanes: inventory.arcanes.length, unclassified_upgrades: inventory.unclassified_upgrades.length,
    pending_recipes: (v.pending_recipes ?? []).length,
    preserved_mastered_frames: inventory.warframes.filter(x => x.mastered === true).length };
  report.crafting_queue = inventory.crafting_jobs.filter(x => pendingResults.has(x.catalog_id)).map(x => ({
    catalog_id: x.catalog_id, name: catalog.entry(x.catalog_id).name, ready_at: x.ready_at, status: x.status }));
  report.policy_notes = ['Snapshot quantities replace balances; never add them to previous counts.',
    'Absence becomes zero only in fully present imported cache fields.',
    'Pending craft timers do not imply ownership or mastery.', 'Existing user goals and deferred priorities retained.'];
  if (skipMasteredFrameParts) report.policy_notes.push(
    'New component stacks of mastered warframes are skipped except explicit targets, per profile.preferences.component_tracking_scope.');

  const reportFile = `data/imports/${eventId}.json`;
  const writes = new Map([[report.snapshot_file, json(snapshot)], [reportFile, json(report)]]);
  if (apply) {
    reconcileGoalBalances(goals, inventory, frameCatalog, eventId, profile);
    for (const item of importedCatalog.values()) if (!frameCatalog.items.some(x => x.id === item.id)) {
      frameCatalog.items.push({ ...item, source: 'AlecaFrame cached static catalog', evidence_event_id: eventId });
    }
    const event = { event_id: eventId, date, source: 'local_alecaframe_cache_authorized_by_user',
      inventory_sync_at: syncAt, source_sha256: source.sha256, report_file: reportFile,
      changes: report.counts, note: 'Absolute inventory snapshot; historical mastery and Helminth facts preserved.' };
    for (const [file, value] of [['data/inventory.json', inventory], ['data/profile.json', profile], ['data/goals.json', goals],
      ['data/catalog.json', frameCatalog], ['data/weapon-catalog.json', weaponCatalog], ['data/equipment-catalog.json', equipmentCatalog]]) {
      writes.set(file, json(value));
    }
    writes.set('data/alecaframe-catalog.json', json({ schema_version: 1,
      source: 'AlecaFrame cachedData/json (third-party static snapshot)',
      imported_on: date, event_id: eventId, source_files: catalog.files, items: [...importedCatalog.values()] }));
    writes.set('data/journal.jsonl', (journal.trim() ? journal.replace(/\s*$/, '\n') : '') + JSON.stringify(event) + '\n');
    for (const [file, contents] of collectionSummaries(inventory, frameCatalog, weaponCatalog, equipmentCatalog,
      file => fs.readFileSync(path.join(root, file), 'utf8'), profile)) writes.set(file, contents);
  }
  // Prepare all content before changing any collection files; keep exact originals for recovery.
  const backupDir = path.join(root, 'data', 'backups', eventId);
  if (apply) fs.mkdirSync(backupDir, { recursive: true });
  const originals = new Map();
  for (const [file] of writes) {
    const absolute = path.join(root, file);
    originals.set(file, fs.existsSync(absolute) ? fs.readFileSync(absolute) : null);
    if (apply && originals.get(file) !== null) {
      const backup = path.join(backupDir, file);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, originals.get(file), { flag: 'wx' });
    }
  }
  try {
    for (const [file, contents] of writes) {
      const absolute = path.join(root, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute + '.tmp', contents);
      fs.renameSync(absolute + '.tmp', absolute);
    }
  } catch (error) {
    for (const [file, bytes] of originals) {
      const absolute = path.join(root, file);
      if (bytes !== null) fs.writeFileSync(absolute, bytes);
      else if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
    }
    throw error;
  }
  console.log(json({ status: report.status, event_id: eventId, inventory_sync_at: syncAt, timezone: report.timezone,
    counts: report.counts, unresolved_ids: report.unresolved_ids, crafting_queue: report.crafting_queue,
    report_file: reportFile, backup_directory: apply ? path.relative(root, backupDir) : null }));
}

main().catch(error => {
  console.error(`AlecaFrame import failed: ${error.message}`);
  process.exitCode = 1;
});
