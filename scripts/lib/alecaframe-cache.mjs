import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Public file-format constants, not account credentials. Format reference:
// https://github.com/Sainan/alecaframe-inventory-parser/blob/senpai/script.pluto
export function decryptCache(bytes) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from('LEO-ALEC\tEO-ALEC'),
    Buffer.from([49, 50, 70, 71, 66, 51, 54, 45, 76, 69, 51, 45, 113, 61, 57, 0]));
  let value = JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8').replace(/^\uFEFF/, ''));
  if (value.InventoryJson || value.InventoryJSON) {
    const inner = value.InventoryJson ?? value.InventoryJSON;
    value = typeof inner === 'string' ? JSON.parse(inner) : inner;
  }
  if (!value || !Array.isArray(value.Suits) || !Array.isArray(value.MiscItems) || !Array.isArray(value.Recipes)) {
    throw new Error('Incomplete or unsupported inventory schema; no changes made');
  }
  return value;
}

export function gameDate(value) {
  const raw = value?.$date?.$numberLong ?? value?.$date ?? value;
  if (raw == null) return null;
  const date = new Date(typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const ownedFields = ['Suits', 'LongGuns', 'Pistols', 'Melee', 'SpaceSuits', 'SpaceGuns', 'SpaceMelee',
  'Sentinels', 'SentinelWeapons', 'KubrowPets', 'MoaPets', 'MechSuits', 'OperatorAmps'];
const countFields = ['MiscItems', 'Recipes', 'Consumables', 'RawUpgrades'];

// Explicit allowlist: account IDs, credentials, names, loadouts and settings never leave the decoder.
export function sanitizeInventory(value) {
  const result = { owned: {}, stacks: {}, mastery_xp: [], pending_recipes: [], upgraded_mods: [],
    credits: value.RegularCredits ?? null, endo: value.FusionPoints ?? null, mastery_rank: value.PlayerLevel ?? null };
  for (const field of ownedFields) if (Array.isArray(value[field])) {
    result.owned[field] = value[field].map(x => ({ item_type: x.ItemType, xp: x.XP ?? null,
      modular_parts: Array.isArray(x.ModularParts) ? x.ModularParts : null }));
  }
  for (const field of countFields) if (Array.isArray(value[field])) {
    result.stacks[field] = value[field].map(x => {
      if (!x.ItemType || !Number.isSafeInteger(x.ItemCount) || x.ItemCount < 0) throw new Error('Invalid stack count');
      return { item_type: x.ItemType, quantity: x.ItemCount };
    });
  }
  if (Array.isArray(value.XPInfo)) result.mastery_xp = value.XPInfo.map(x => ({ item_type: x.ItemType, xp: x.XP ?? null }));
  if (Array.isArray(value.PendingRecipes)) result.pending_recipes = value.PendingRecipes.map(x => ({ item_type: x.ItemType,
    ready_at: gameDate(x.CompletionDate) }));
  if (Array.isArray(value.Upgrades)) result.upgraded_mods = value.Upgrades.map(x => {
    let rank = null;
    try { const f = JSON.parse(x.UpgradeFingerprint); if (Number.isSafeInteger(f.lvl) && f.lvl >= 0) rank = f.lvl; } catch { /* Unknown format stays unknown. */ }
    return { item_type: x.ItemType, rank };
  });
  result.present_fields = [...ownedFields, ...countFields, 'XPInfo', 'PendingRecipes', 'Upgrades']
    .filter(field => Array.isArray(value[field]));
  return result;
}

export function readCache(cachePath) {
  if (!fs.existsSync(cachePath)) {
    throw new Error(`AlecaFrame cache not found: ${cachePath}. Start AlecaFrame and open the inventory, or pass --cache <file>.`);
  }
  const bytes = fs.readFileSync(cachePath);
  const stat = fs.statSync(cachePath);
  const decoded = decryptCache(bytes);
  const oid = decoded.LastInventorySync?.$oid;
  const sync = typeof oid === 'string' && /^[0-9a-f]{24}$/i.test(oid)
    ? new Date(parseInt(oid.slice(0, 8), 16) * 1000).toISOString() : null;
  return { schema_version: 1, source: { path: path.resolve(cachePath), bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), file_modified_at: stat.mtime.toISOString(),
    inventory_sync_at: sync, sync_time_basis: 'timestamp portion of LastInventorySync ObjectId; cross-checked with file mtime',
    captured_at: new Date().toISOString() }, inventory: sanitizeInventory(decoded) };
}

export function readCatalog(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`AlecaFrame static catalog directory not found: ${directory}. Pass --catalog <dir>.`);
  }
  const items = new Map();
  const files = [];
  for (const filename of fs.readdirSync(directory).filter(x => x.endsWith('.json') && x !== 'lang.json').sort()) {
    const file = path.join(directory, filename), bytes = fs.readFileSync(file), entries = JSON.parse(bytes);
    if (!Array.isArray(entries)) continue;
    files.push({ file: filename, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      modified_at: fs.statSync(file).mtime.toISOString() });
    for (const item of entries) if (item.uniqueName) items.set(item.uniqueName, item);
  }
  const langPath = path.join(directory, 'lang.json');
  if (!fs.existsSync(langPath)) {
    throw new Error(`AlecaFrame static catalog is missing lang.json: ${langPath}`);
  }
  const lang = JSON.parse(fs.readFileSync(langPath, 'utf8'));
  // Runtime recipe IDs and WFCD component IDs differ, e.g. <Frame>HelmetBlueprint -> <Frame>HelmetComponent.
  // Only accept the alias when that exact component exists in the local static catalog.
  function resolve(id) {
    if (items.has(id)) return id;
    const candidate = id.replace(/Blueprint$/, 'Component');
    if (items.has(candidate)) return candidate;
    const withoutSuffix = id.replace(/Blueprint$/, '');
    return items.has(withoutSuffix) ? withoutSuffix : id;
  }
  function entry(id) {
    id = resolve(id);
    const item = items.get(id);
    const parents = item?.parentUniqueNames ?? [];
    const prefix = ['Blueprint', 'Chassis', 'Neuroptics', 'Systems'].includes(item?.name) && parents.length === 1
      ? items.get(parents[0])?.name : null;
    return { id, name: { en: prefix ? `${prefix} ${item.name}` : item?.name ?? null,
      ru: lang[id]?.ru?.name ?? null }, category: item?.category ?? null, type: item?.type ?? null,
      source_resolved: !!item, parent_ids: parents, wiki_url: item?.wikiaUrl ?? null };
  }
  function ownedId(item) {
    const parts = item.modular_parts ?? [];
    // Mastery/collection identity belongs to a strike, chamber, prism or hound model.
    return parts.find(id => /\/Tip\/|\/Barrel\/|\/ZanukaPetHead/.test(id) && items.has(id)) ?? resolve(item.item_type);
  }
  return { items, files, resolve, entry, ownedId };
}
