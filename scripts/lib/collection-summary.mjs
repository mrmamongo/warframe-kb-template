import { formatDateTime, resolveTimeZone } from './time.mjs';

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Reconciles goal balances with the latest inventory snapshot. All values are
// derived from the snapshot and the reference catalogs; nothing user-specific is
// hardcoded here, so the same logic works for any player and an empty template.
export function reconcileGoalBalances(goals, inventory, frameCatalog, eventId, profile = null) {
  const timeZone = resolveTimeZone(profile);
  const stamp = { snapshot_at: inventory.last_alecaframe_sync_at ?? null, evidence_event_id: eventId };
  const items = Array.isArray(inventory.items) ? inventory.items : [];
  const frames = Array.isArray(frameCatalog?.warframes) ? frameCatalog.warframes : [];
  const quantity = (id, form) => items.find(x => x.catalog_id === id && x.form === form)?.quantity ?? 0;
  const frameName = id => {
    const frame = frames.find(x => x.id === id);
    return frame?.name?.ru || frame?.name?.en || id;
  };
  for (const goal of goals.specific_targets ?? []) {
    if (!goal || typeof goal.catalog_id !== 'string') continue;
    const frame = frames.find(x => x.id === goal.catalog_id);
    if (!frame) continue;
    const recipes = (frame.final_assembly?.ingredients ?? []).filter(x => /\/WarframeRecipes\//.test(x.item_id));
    const main = recipes.find(x => /Blueprint$/.test(x.item_id));
    const components = recipes.filter(x => /Component$/.test(x.item_id));
    goal.inventory_holdings = {
      main_blueprint: main ? { catalog_id: main.item_id, quantity: quantity(main.item_id, 'blueprint') } : null,
      components: components.map(x => ({ catalog_id: x.item_id, blueprint_quantity: quantity(x.item_id, 'blueprint'),
        built_quantity: quantity(x.item_id, 'built_component') })),
      ...stamp,
    };
    if (goal.resource_farm) {
      goal.resource_farm.stock_evidence_event_id = eventId;
      goal.resource_farm.stock_snapshot_at = stamp.snapshot_at;
      goal.resource_farm.note = 'Stocks imported from the local AlecaFrame snapshot. Acquisition routes and full component recipe quantities still require separate confirmation.';
    }
    if (goal.blueprint_holdings) {
      goal.blueprint_holdings.main = goal.inventory_holdings.main_blueprint;
      goal.blueprint_holdings.current_balances_need_reconciliation = false;
      goal.blueprint_holdings.latest_inventory_event_id = eventId;
    }
  }
  for (const recommendation of goals.recommendations ?? []) {
    if (!recommendation) continue;
    const goal = (goals.specific_targets ?? []).find(x => x?.catalog_id === recommendation.catalog_id);
    if (!goal?.inventory_holdings) continue;
    recommendation.inventory_holdings = goal.inventory_holdings;
    if (recommendation.status === 'deferred_by_user' && typeof recommendation.reason === 'string') {
      const base = recommendation.reason.split(' Current stocks')[0].replace(/\s+$/, '');
      recommendation.reason = `${base} Current stocks are recorded in inventory_holdings; the user-deferred priority is retained.`;
    }
  }
  // The note is regenerated from data so it cannot outlive the snapshot it describes.
  const jobs = Array.isArray(inventory.crafting_jobs) ? inventory.crafting_jobs : [];
  const activeJobs = jobs.filter(x => ['in_progress', 'ready_to_claim'].includes(x.status));
  const queueFrames = activeJobs.filter(x => x.form === 'warframe').map(x => frameName(x.catalog_id));
  const framesRows = Array.isArray(inventory.warframes) ? inventory.warframes : [];
  const ownedUnmastered = framesRows.filter(x => x.owned_quantity > 0 && x.mastered !== true).map(x => frameName(x.catalog_id));
  const snapshotAt = inventory.last_alecaframe_sync_at;
  goals.recommendation_status = 'inventory_imported_routes_and_recipe_deficits_require_separate_verification';
  goals.recommendation_scope_note = [
    snapshotAt
      ? `Наличие обновлено по снимку от ${formatDateTime(snapshotAt, timeZone)} (${timeZone}).`
      : 'Наличие обновлено по последнему локальному снимку.',
    activeJobs.length
      ? `Кузница: ${activeJobs.length} ${plural(activeJobs.length, 'позиция', 'позиции', 'позиций')}${queueFrames.length ? `, варфреймы: ${queueFrames.join(', ')}` : ''}.`
      : 'Кузница пуста.',
    ownedUnmastered.length ? `В арсенале без подтверждённого освоения: ${ownedUnmastered.join(', ')}.` : '',
    'Маршруты добычи, рецепты и шансы выпадения требуют отдельной проверки.',
  ].filter(Boolean).join(' ');
}

const UPDATES_HEADING = '## Обновления';
const HISTORY_HEADING = '## История';
const HISTORY_NOTE = 'Старые сгенерированные снимки не сохраняются: актуальное состояние — выше, ручные записи — в разделе «Обновления».';

// Keeps the manual "## Обновления" section verbatim and drops stale generated
// material that used to live under "## История".
function manualUpdates(oldText) {
  const start = oldText.indexOf(UPDATES_HEADING);
  if (start < 0) return UPDATES_HEADING;
  const nextHeading = oldText.indexOf('\n## ', start + UPDATES_HEADING.length);
  let section = oldText.slice(start, nextHeading < 0 ? oldText.length : nextHeading);
  const history = section.indexOf(HISTORY_HEADING);
  if (history >= 0) section = section.slice(0, history);
  section = section.replace(/\n+---\s*$/, '').replace(/\s+$/, '');
  return section || UPDATES_HEADING;
}

function summaryFile(body, oldText) {
  return `${body.replace(/\s+$/, '')}\n\n${manualUpdates(oldText)}\n\n${HISTORY_HEADING}\n\n${HISTORY_NOTE}\n`;
}

export function collectionSummaries(inventory, frameCatalog, weaponCatalog, equipmentCatalog, readText, profile) {
  const frameEntries = Array.isArray(frameCatalog?.warframes) ? frameCatalog.warframes : [];
  const frameItems = Array.isArray(frameCatalog?.items) ? frameCatalog.items : [];
  const weaponEntries = Array.isArray(weaponCatalog?.weapons) ? weaponCatalog.weapons : [];
  const equipmentEntries = Array.isArray(equipmentCatalog?.items) ? equipmentCatalog.items : [];
  const lookup = new Map([...frameEntries, ...frameItems, ...weaponEntries, ...equipmentEntries]
    .filter(entry => entry && typeof entry.id === 'string')
    .map(entry => [entry.id, entry.name]));
  const name = id => {
    const entry = lookup.get(id);
    return entry?.ru || entry?.en || (typeof entry === 'string' ? entry : null) || id;
  };
  const list = key => (Array.isArray(inventory[key]) ? inventory[key] : []);
  const rowsOf = key => list(key).filter(row => row && typeof row.catalog_id === 'string');
  const owned = rows => rows.filter(x => x.owned_quantity > 0);
  const labels = rows => {
    const names = owned(rows).map(x => name(x.catalog_id)).sort((a, b) => a.localeCompare(b, 'ru'));
    return names.length ? names.join(', ') : 'Нет данных';
  };
  const timeZone = resolveTimeZone(profile);
  const timestamp = inventory.last_alecaframe_sync_at
    ? `${formatDateTime(inventory.last_alecaframe_sync_at, timeZone)} (${timeZone})`
    : null;
  const source = timestamp
    ? `Снимок AlecaFrame: **${timestamp}**. Освоение подтверждается сообщениями игрока; опыт из кэша хранится отдельно и не меняет освоение автоматически.`
    : 'Снимок AlecaFrame ещё не импортирован. Освоение и наличие подтверждаются сообщениями игрока; опыт из кэша не меняет освоение автоматически.';
  const jobs = list('crafting_jobs').filter(x => ['in_progress', 'ready_to_claim'].includes(x.status));
  const jobLabel = job => job.display_name?.ru || job.display_name?.en || name(job.catalog_id);
  const time = value => (value ? formatDateTime(value, timeZone) : 'неизвестно');
  const queue = jobs.map(job => {
    const estimated = !job.ready_at && job.estimated_ready_at;
    const when = job.ready_at ? time(job.ready_at) : estimated ? `ожидаемо ~${time(job.estimated_ready_at)}` : 'время неизвестно';
    const state = job.status === 'ready_to_claim' ? 'можно получать' : estimated ? 'строится, время оценочное' : 'строится';
    return `- ${jobLabel(job)} — ${when}; ${state}.`;
  }).join('\n');
  const foundry = queue || 'Кузница пуста.';
  const readExisting = file => {
    try {
      return readText(file) ?? '';
    } catch {
      return '';
    }
  };
  const writes = new Map();

  const frames = rowsOf('warframes');
  const ownedFrames = owned(frames);
  const mastered = frames.filter(x => x.mastered === true);
  const ownedUnmastered = ownedFrames.filter(x => x.mastered !== true);
  const subsumed = frames.filter(x => x.helminth_subsumed === true);
  const masteryRank = profile && Number.isSafeInteger(profile.mastery_rank) ? `Ранг мастерства: **${profile.mastery_rank}**.\n\n` : '';
  const masteredNote = ownedUnmastered.length
    ? `В арсенале без подтверждённого освоения: ${ownedUnmastered.map(x => name(x.catalog_id)).sort((a, b) => a.localeCompare(b, 'ru')).join(', ')}.`
    : ownedFrames.length
      ? 'Все версии в арсенале имеют подтверждённое освоение.'
      : 'Освоение варфреймов пока не подтверждено.';
  const helminthNote = subsumed.length
    ? `Поглощено Гельминтом по подтверждённым записям: ${subsumed.map(x => name(x.catalog_id)).sort((a, b) => a.localeCompare(b, 'ru')).join(', ')}.`
    : 'Поглощение Гельминтом из кэша не выводится и должно подтверждаться отдельно.';
  writes.set('knowledge/mastery.md', summaryFile(`# Варфреймы: текущее состояние

${source}

${masteryRank}**Освоено версий: ${mastered.length}. Сейчас в арсенале: ${ownedFrames.length}.**

${ownedFrames.length ? `В арсенале сейчас: ${labels(frames)}.` : 'В арсенале пока пусто.'}

${masteredNote} ${helminthNote}

## Кузница

${foundry}
`, readExisting('knowledge/mastery.md')));

  const weapons = rowsOf('weapons');
  const categories = [...new Set(['Primary', 'Secondary', 'Melee', ...weapons.map(x => x.category).filter(Boolean)])];
  const weaponRows = categories
    .map(category => `| ${category} | ${weapons.filter(x => x.category === category && x.mastered === true).length} | ${owned(weapons.filter(x => x.category === category)).length} |`)
    .join('\n');
  const weaponLists = categories
    .map(category => `### ${category}\n\n${labels(weapons.filter(x => x.category === category))}.`)
    .join('\n\n');
  writes.set('knowledge/weapons.md', summaryFile(`# Оружие: текущее состояние

${source}

**Освоено: ${weapons.filter(x => x.mastered === true).length}. Обычных видов оружия в арсенале: ${owned(weapons).length}.** Модульные сборки учитываются отдельно в equipment.

| Категория | Подтверждённо освоено | В наличии |
| --- | ---: | ---: |
${weaponRows}

${weaponLists}

Моды, ранги и мистификаторы находятся в отдельных массивах inventory.mods и inventory.arcanes.
`, readExisting('knowledge/weapons.md')));

  const equipment = rowsOf('equipment');
  const companions = rowsOf('companions');
  const companionWeapons = rowsOf('companion_weapons');
  const extraEquipment = [...equipment, ...companions, ...companionWeapons];
  writes.set('knowledge/equipment.md', summaryFile(`# Другое снаряжение: текущее состояние

${source}

- Другое снаряжение и модульные сборки: ${owned(equipment).length} ${plural(owned(equipment).length, 'вид', 'вида', 'видов')} в наличии.
- Компаньоны: ${owned(companions).length}.
- Их оружие: ${owned(companionWeapons).length}.

${owned(extraEquipment).length ? `${labels(extraEquipment)}.` : 'В арсенале пока пусто.'}

Модульные части сохранены по игровым идентификаторам. Имена питомцев и пользовательские названия оружия не импортируются. Нераспознанные названия перечислены в отчёте импорта.

## Кузница

${foundry}
`, readExisting('knowledge/equipment.md')));

  return writes;
}
