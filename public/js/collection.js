// Collection logic with no DOM access: filtering, sorting, merging, totals and timing rules.
// Kept separate from app.js so it can be unit-tested in Node.
import { priceOf, colorsOf } from './render.js';

export const RARITY_ORDER = { special: 5, bonus: 5, mythic: 4, rare: 3, uncommon: 2, common: 1 };
export const DAY_MS = 24 * 60 * 60 * 1000;

export const emptyFilters = () => ({
  q: '', colors: new Set(), rarity: '', type: '', set: '', sort: 'name',
  format: '', mvMin: '', mvMax: '', priceMin: '', priceMax: '',
});

const hayCache = new WeakMap();
function haystack(card) {
  if (!hayCache.has(card)) {
    const parts = [card.name, card.type_line, card.oracle_text, card.set_name, card.set, card.artist, ...(card.keywords || [])];
    (card.card_faces || []).forEach((f) => parts.push(f.name, f.type_line, f.oracle_text));
    hayCache.set(card, parts.filter(Boolean).join(' ').toLowerCase());
  }
  return hayCache.get(card);
}

export const typeLine = (c) => c.type_line || (c.card_faces || []).map((f) => f.type_line).join(' // ');
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

export const SORTS = {
  name: (a, b) => a.card.name.localeCompare(b.card.name),
  price: (a, b) => priceOf(b) - priceOf(a) || SORTS.name(a, b),
  total: (a, b) => priceOf(b) * b.qty - priceOf(a) * a.qty || SORTS.name(a, b),
  cmc: (a, b) => a.card.cmc - b.card.cmc || SORTS.name(a, b),
  rarity: (a, b) => (RARITY_ORDER[b.card.rarity] || 0) - (RARITY_ORDER[a.card.rarity] || 0) || SORTS.name(a, b),
  set: (a, b) =>
    (b.card.released_at || '').localeCompare(a.card.released_at || '') ||
    (a.card.set_name || '').localeCompare(b.card.set_name || '') ||
    (a.card.collector_number || '').localeCompare(b.card.collector_number || '', undefined, { numeric: true }),
  qty: (a, b) => b.qty - a.qty || SORTS.name(a, b),
  added: (a, b) => (b.added || 0) - (a.added || 0) || SORTS.name(a, b),
};

// Does a collection item pass every active filter?
export function matchesFilters(it, f) {
  const c = it.card;
  const terms = (f.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const hay = haystack(c);
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  if (f.rarity && c.rarity !== f.rarity) return false;
  if (f.set && c.set !== f.set) return false;
  if (f.type && !typeLine(c).toLowerCase().includes(f.type)) return false;
  if (f.colors?.size) {
    const cols = colorsOf(c);
    for (const col of f.colors) {
      if (col === 'C' ? cols.length : col === 'M' ? cols.length < 2 : !cols.includes(col)) return false;
    }
  }
  if (f.format) {
    const legal = c.legalities?.[f.format];
    if (legal !== 'legal' && legal !== 'restricted') return false;
  }
  const mvMin = num(f.mvMin), mvMax = num(f.mvMax), pMin = num(f.priceMin), pMax = num(f.priceMax);
  if (mvMin != null && c.cmc < mvMin) return false;
  if (mvMax != null && c.cmc > mvMax) return false;
  if (pMin != null || pMax != null) {
    const p = priceOf(it);
    if (pMin != null && p < pMin) return false;
    if (pMax != null && p > pMax) return false;
  }
  return true;
}

export function filterAndSort(items, f) {
  return items.filter((it) => matchesFilters(it, f)).sort(SORTS[f.sort] || SORTS.name);
}

// mode 'add' sums quantities for the same printing+finish; any other mode overwrites.
export function mergeItems(existing, incoming, mode) {
  const map = new Map(existing.map((i) => [i.key, { ...i }]));
  for (const it of incoming) {
    const prev = map.get(it.key);
    if (prev && mode === 'add') prev.qty += it.qty;
    else map.set(it.key, { ...it });
  }
  return [...map.values()];
}

export const totals = (items) => ({
  unique: items.length,
  cards: items.reduce((s, i) => s + i.qty, 0),
  value: items.reduce((s, i) => s + priceOf(i) * i.qty, 0),
});

// Rebuild collection items from synced entries, given card data by Scryfall id.
// Entries whose card data is unavailable are left out.
export function itemsFromSynced(entries, cardsById, now = Date.now()) {
  return entries.filter((r) => cardsById.has(r.id)).map((r) => ({
    key: `${r.id}|${r.finish}`, card: cardsById.get(r.id), qty: r.qty, finish: r.finish,
    condition: r.condition || '', language: r.language || '', added: r.added || now,
  }));
}

// Scryfall publishes new prices once a day. Refresh only when it has published since our last
// refresh; if we couldn't find out when it last published, fall back to once every 24 hours.
export function priceRefreshDue(lastRefresh, scryfallUpdated, now = Date.now()) {
  if (!lastRefresh) return true;
  if (scryfallUpdated) return lastRefresh < scryfallUpdated;
  return now - lastRefresh >= DAY_MS;
}

export function ago(t, now = Date.now()) {
  const s = Math.round((now - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}
