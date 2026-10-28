import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dayInTimeZone, resolveTimeZone } from './lib/time.mjs';

// Refreshes reference data only. Personal progress is stored separately.
const root = fileURLToPath(new URL('../', import.meta.url));

function readProfile() {
  try {
    return JSON.parse(readFileSync(path.join(root, 'data', 'profile.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Dates are written in the player's zone from data/profile.json when it is set.
const timeZone = resolveTimeZone(readProfile());
const day = dayInTimeZone(new Date(), timeZone);
const headers = { 'User-Agent': 'warframe-kb-template/0.1 (WFCD reference catalog snapshot)' };
async function fetchText(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

const revision = JSON.parse(await fetchText('https://api.github.com/repos/WFCD/warframe-items/commits/master')).sha;
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid catalog revision');
const files = ['Warframes.json', 'Components.json', 'Resources.json', 'Misc.json', 'i18n/ru.json'];
const downloaded = await Promise.all(files.map(async (file) => {
  const url = `https://raw.githubusercontent.com/WFCD/warframe-items/${revision}/data/json/${file}`;
  const body = await fetchText(url);
  return { file, url, sha256: createHash('sha256').update(body).digest('hex'), data: JSON.parse(body) };
}));
const [warframes, components, resources, misc, locale] = downloaded.map((file) => file.data);
for (const list of [warframes, components, resources, misc]) {
  if (!Array.isArray(list) || list.some((item) => typeof item.uniqueName !== 'string' || typeof item.name !== 'string')) {
    throw new Error('Unexpected source structure');
  }
}
if (!locale || typeof locale !== 'object' || Array.isArray(locale)) throw new Error('Unexpected locale structure');
const byId = new Map([...warframes, ...components, ...resources, ...misc].map((item) => [item.uniqueName, item]));
const nameOf = (item) => ({ en: item.name, ru: locale[item.uniqueName]?.name ?? null });
const dropsOf = (item) => (item.drops ?? []).map((drop) => ({
  location: drop.location ?? null,
  reward: drop.type ?? null,
  chance_percent: drop.chance ?? null,
  rarity: drop.rarity ?? null,
  verification: 'community_snapshot_recheck_before_recommendation',
}));
const refsOf = (item) => (item.components ?? []).map((component) => ({
  item_id: component.uniqueName,
  quantity: component.itemCount,
}));
const entries = warframes.filter((item) => item.type === 'Warframe' && item.masterable === true).map((item) => ({
  id: item.uniqueName,
  name: nameOf(item),
  variant: item.isPrime ? 'prime' : item.name === 'Excalibur Umbra' ? 'umbra' : 'base',
  // Special forms stay visible without inflating collection counts automatically.
  collection_group_id: item.uniqueName.includes('/SiriusOrion/') ? '/Lotus/Powersuits/SiriusOrion' : item.uniqueName,
  collection_group_needs_review: item.uniqueName.includes('/SiriusOrion/'),
  wiki_url: item.wikiaUrl ?? null,
  release_date: item.releaseDate ?? null,
  source_mastery_requirement: item.masteryReq ?? null,
  source_vaulted_snapshot: item.vaulted ?? null,
  final_assembly: {
    credits: item.buildPrice ?? null,
    duration_seconds: item.buildTime ?? null,
    ingredients: refsOf(item),
    coverage: 'final_assembly_only_component_recipes_need_wiki_check',
  },
}));
if (entries.length < 50 || new Set(entries.map((item) => item.id)).size !== entries.length) {
  throw new Error('Catalog looks incomplete or contains duplicate identifiers');
}

const needed = new Set();
function collect(itemId) {
  if (needed.has(itemId)) return;
  needed.add(itemId);
  const item = byId.get(itemId);
  for (const ref of item?.components ?? []) collect(ref.uniqueName);
}
for (const frame of entries) for (const ref of frame.final_assembly.ingredients) collect(ref.item_id);
const missingIds = [...needed].filter((id) => !byId.has(id));
const items = [...needed].map((id) => {
  const item = byId.get(id);
  return {
    id,
    name: item ? nameOf(item) : { en: null, ru: locale[id]?.name ?? null },
    category: item?.category ?? null,
    source_resolved: Boolean(item),
    ingredients: item ? refsOf(item) : [],
    drops: item ? dropsOf(item) : [],
    inventory_note: 'Blueprint quantities and built component quantities are different inventory records.',
  };
}).sort((a, b) => a.id.localeCompare(b.id));
const license = await fetchText(`https://raw.githubusercontent.com/WFCD/warframe-items/${revision}/LICENSE`);
const catalog = {
  schema_version: 1,
  retrieved_on: day,
  source: {
    project: 'WFCD/warframe-items',
    repository: 'https://github.com/WFCD/warframe-items',
    revision,
    authority: 'community_catalog_derived_from_game_data',
    files: downloaded.map(({ file, url, sha256 }) => ({ file, url, sha256 })),
  },
  limitations: [
    'This is a catalog snapshot, not the player inventory.',
    'Drop sources, vault status, and rotations must be checked before recommending a farm.',
    'Final assembly ingredients do not include all resource costs of building the components.',
    'A source component identifier can describe a blueprint reward; keep blueprint and built part quantities separate.',
    'Special forms and unobtainable exclusives need an acquisition check before counting collection goals.',
  ],
  unresolved_item_ids: missingIds,
  warframes: entries,
  items,
};
await mkdir(path.join(root, 'data'), { recursive: true });
await mkdir(path.join(root, 'knowledge'), { recursive: true });
await writeFile(path.join(root, 'knowledge', 'WFCD-LICENSE.txt'), license, 'utf8');
const target = path.join(root, 'data', 'catalog.json');
const temporary = `${target}.tmp`;
await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
// Read back before replacing the previous reference snapshot.
JSON.parse(await readFile(temporary, 'utf8'));
await rename(temporary, target);
console.log(JSON.stringify({
  catalog: target,
  retrieved_on: day,
  timezone: timeZone,
  revision,
  warframe_entries: entries.length,
  collection_groups: new Set(entries.map((item) => item.collection_group_id)).size,
  referenced_items: items.length,
  unresolved_items: missingIds.length,
  russian_names: entries.filter((item) => item.name.ru).length,
}, null, 2));
