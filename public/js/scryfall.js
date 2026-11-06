// Scryfall API client: resolves parsed entries to full card data.
// Uses POST /cards/collection (75 identifiers per request) and stays well under
// Scryfall's rate limit (~10 requests/second).
const API = 'https://api.scryfall.com';
const BATCH = 75;
const MIN_GAP_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s ?? '').trim().toLowerCase();

let lastRequest = 0;
async function request(url, options) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(url, options);
    if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Scryfall error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error('Scryfall rate limit exceeded, try again in a minute.');
}

function fetchCollection(identifiers) {
  return request(`${API}/cards/collection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifiers }),
  });
}

// Scryfall doesn't accept full "Fire // Ice" names in lookups, so use the front face.
const frontName = (name) => String(name ?? '').split(' // ')[0].trim();

// Fold accents/punctuation so "Lim-Dul's Vault" matches "Lim-Dûl's Vault".
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function nameMatches(entryName, card) {
  if (!entryName) return true;
  const want = fold(frontName(entryName));
  const names = [card.name, frontName(card.name), ...(card.card_faces || []).map((f) => f.name)];
  return names.some((n) => fold(n) === want);
}

// Pick an identifier for an entry. level 0 = most precise available,
// 1 = name + set, 2 = name only.
function identify(e, level) {
  const name = frontName(e.name);
  if (level === 0) {
    if (e.id) return { ident: { id: e.id }, key: `id:${lc(e.id)}` };
    if (e.set && e.cn) return { ident: { set: lc(e.set), collector_number: String(e.cn).trim() }, key: `sc:${lc(e.set)}|${lc(e.cn)}` };
  }
  if (level <= 1 && e.set && name) return { ident: { name, set: lc(e.set) }, key: `ns:${lc(name)}|${lc(e.set)}` };
  if (name) return { ident: { name }, key: `n:${lc(name)}` };
  return null;
}

function keysForCard(c) {
  const names = new Set([lc(c.name)]);
  (c.card_faces || []).forEach((f) => names.add(lc(f.name)));
  const keys = [`id:${lc(c.id)}`, `sc:${lc(c.set)}|${lc(c.collector_number)}`];
  names.forEach((n) => keys.push(`ns:${n}|${lc(c.set)}`, `n:${n}`));
  return keys;
}

const normIdent = (o) => Object.keys(o).sort().map((k) => `${k}=${lc(o[k])}`).join('&');

async function runPass(entries, level, onProgress, label) {
  const groups = new Map();
  const failed = [];
  for (const e of entries) {
    const id = identify(e, level);
    if (!id) { failed.push(e); continue; }
    if (!groups.has(id.key)) groups.set(id.key, { ...id, entries: [], card: null });
    groups.get(id.key).entries.push(e);
  }
  const all = [...groups.values()];
  const resolved = [];
  for (let i = 0; i < all.length; i += BATCH) {
    onProgress?.(label, i, all.length);
    const batch = all.slice(i, i + BATCH);
    const res = await fetchCollection(batch.map((g) => g.ident));
    const notFound = new Set((res.not_found || []).map(normIdent));
    const pending = batch.filter((g) => !notFound.has(normIdent(g.ident)));
    const byKey = new Map(pending.map((g) => [g.key, g]));
    const leftovers = [];
    for (const card of res.data || []) {
      const g = keysForCard(card).map((k) => byKey.get(k)).find((x) => x && !x.card);
      if (g) g.card = card; else leftovers.push(card);
    }
    // Anything that didn't key-match (e.g. accent differences) is assigned in response order.
    const unfilled = pending.filter((g) => !g.card);
    leftovers.forEach((card, idx) => { if (unfilled[idx]) unfilled[idx].card = card; });

    for (const g of batch) {
      for (const e of g.entries) {
        // A wrong set/collector number can return a different card; treat that as a miss.
        if (g.card && nameMatches(e.name, g.card)) resolved.push({ entry: e, card: g.card });
        else failed.push(e);
      }
    }
  }
  onProgress?.(label, all.length, all.length);
  return { resolved, failed };
}

// Resolve entries → [{ entry, card }]. Entries whose exact printing can't be found
// are retried by name only (you'll get the default printing).
export async function resolveEntries(entries, onProgress) {
  const labels = ['Looking up cards', 'Retrying by name + set', 'Retrying by name'];
  const resolved = [];
  let pending = entries;
  const failed = [];
  for (let level = 0; level < 3 && pending.length; level++) {
    const pass = await runPass(pending, level, onProgress, labels[level]);
    resolved.push(...pass.resolved);
    // Only retry entries whose identifier would actually change at the next level.
    pending = [];
    for (const e of pass.failed) {
      const next = level < 2 && identify(e, level + 1);
      if (next && next.key !== identify(e, level)?.key) pending.push(e);
      else failed.push(e);
    }
  }
  return { resolved, failed: [...failed, ...pending] };
}

// Re-fetch cards by Scryfall id (used to refresh prices).
export async function refreshCards(ids, onProgress) {
  const { resolved } = await runPass(ids.map((id) => ({ id })), 0, onProgress, 'Refreshing prices');
  return new Map(resolved.map(({ card }) => [card.id, trimCard(card)]));
}

// Keep only the fields the UI uses, to keep storage small.
export function trimCard(c) {
  const pickImg = (u) => (u ? { small: u.small, normal: u.normal, large: u.large, art_crop: u.art_crop } : undefined);
  return {
    id: c.id,
    name: c.name,
    layout: c.layout,
    mana_cost: c.mana_cost,
    cmc: c.cmc ?? 0,
    type_line: c.type_line,
    oracle_text: c.oracle_text,
    flavor_text: c.flavor_text,
    power: c.power,
    toughness: c.toughness,
    loyalty: c.loyalty,
    defense: c.defense,
    colors: c.colors,
    color_identity: c.color_identity,
    keywords: c.keywords,
    set: c.set,
    set_name: c.set_name,
    collector_number: c.collector_number,
    rarity: c.rarity,
    artist: c.artist,
    released_at: c.released_at,
    lang: c.lang,
    finishes: c.finishes,
    prices: c.prices,
    legalities: c.legalities,
    edhrec_rank: c.edhrec_rank,
    scryfall_uri: c.scryfall_uri,
    image_uris: pickImg(c.image_uris),
    card_faces: c.card_faces?.map((f) => ({
      name: f.name,
      mana_cost: f.mana_cost,
      type_line: f.type_line,
      oracle_text: f.oracle_text,
      flavor_text: f.flavor_text,
      power: f.power,
      toughness: f.toughness,
      loyalty: f.loyalty,
      defense: f.defense,
      colors: f.colors,
      artist: f.artist,
      image_uris: pickImg(f.image_uris),
    })),
  };
}
