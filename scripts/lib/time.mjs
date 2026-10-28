// Shared time-zone helpers. The user's zone comes from data/profile.json (IANA name);
// when it is absent we use the host system zone and fall back to UTC as a last resort.

const FALLBACK_TIME_ZONE = 'UTC';

export function isValidTimeZone(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(profile) {
  if (isValidTimeZone(profile?.timezone)) return profile.timezone;
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (isValidTimeZone(system)) return system;
  return FALLBACK_TIME_ZONE;
}

// Calendar day (YYYY-MM-DD) in the given zone, derived only from the timestamp.
export function dayInTimeZone(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatDateTime(value, timeZone, locale = 'ru-RU') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'неизвестно';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
