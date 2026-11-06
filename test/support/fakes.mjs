// In-memory fakes of the Scryfall and GitHub APIs, shared by the unit and browser tests.
// Each fake has handle(url, method, body, headers) -> { status, json | text } and a `state`
// object tests can inspect or change (e.g. publish new prices, make the next request fail).
import { readFileSync } from 'node:fs';

export const loadCards = () => JSON.parse(readFileSync(new URL('../fixtures/cards.json', import.meta.url), 'utf8'));

const lc = (s) => String(s ?? '').trim().toLowerCase();
const fold = (s) => lc(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

export function createFakeScryfall(cards = loadCards()) {
  const state = {
    cards: structuredClone(cards),
    publishedAt: Date.parse('2026-01-01T22:00:00Z'), // when "Scryfall" last published prices
    priceBump: 0,      // added to every USD price, to simulate a new day's prices
    failNext: 0,       // number of upcoming requests that get a 500
    rateLimitNext: 0,  // number of upcoming requests that get a 429
    requests: [],
  };

  const namesOf = (c) => [c.name, c.name.split(' // ')[0], ...(c.card_faces || []).map((f) => f.name)].map(fold);
  function find(ident) {
    if (ident.id) return state.cards.find((c) => c.id === lc(ident.id));
    if (ident.set && ident.collector_number) {
      return state.cards.find((c) => c.set === lc(ident.set) && c.collector_number === String(ident.collector_number));
    }
    const name = fold(ident.name);
    return state.cards.find((c) => namesOf(c).includes(name) && (!ident.set || c.set === lc(ident.set)));
  }
  function priced(c) {
    if (!state.priceBump) return c;
    const prices = { ...c.prices };
    for (const k of ['usd', 'usd_foil', 'usd_etched']) if (prices[k] != null) prices[k] = (Number(prices[k]) + state.priceBump).toFixed(2);
    return { ...c, prices };
  }

  function handle(url, method = 'GET', body) {
    const u = new URL(url);
    state.requests.push({ path: u.pathname, method, body });
    if (state.rateLimitNext > 0) { state.rateLimitNext--; return { status: 429, json: { object: 'error', status: 429 } }; }
    if (state.failNext > 0) { state.failNext--; return { status: 500, json: { object: 'error', details: 'Simulated failure' } }; }
    if (u.pathname === '/bulk-data/default-cards') {
      return { status: 200, json: { object: 'bulk_data', type: 'default_cards', updated_at: new Date(state.publishedAt).toISOString() } };
    }
    if (u.pathname === '/cards/collection' && method === 'POST') {
      const { identifiers } = JSON.parse(body);
      if (identifiers.length > 75) return { status: 422, json: { object: 'error', details: 'Too many identifiers' } };
      const data = [], notFound = [];
      for (const ident of identifiers) {
        const card = find(ident);
        if (card) data.push(priced(card)); else notFound.push(ident);
      }
      return { status: 200, json: { object: 'list', not_found: notFound, data } };
    }
    return { status: 404, json: { object: 'error', details: 'Not found' } };
  }
  const count = (path) => state.requests.filter((r) => r.path === path).length;
  return { state, handle, count };
}

export const SYNC_FILE = 'mtg-collection-sync.json';

export function createFakeGitHub({ token = 'test-token', login = 'tester' } = {}) {
  const state = { gists: new Map(), next: 1, token, login, truncate: false, requests: [] };
  const view = (g) => ({
    id: g.id,
    files: Object.fromEntries(Object.entries(g.files).map(([name, content]) => [name, {
      filename: name,
      content: state.truncate ? content.slice(0, 10) : content,
      truncated: state.truncate,
      raw_url: `https://gist.githubusercontent.com/${login}/${g.id}/raw/${name}`,
    }])),
  });

  function handle(url, method = 'GET', body, headers = {}) {
    const u = new URL(url);
    state.requests.push({ path: u.pathname + u.search, method });
    if (u.hostname === 'gist.githubusercontent.com') {
      const [, , id, , name] = u.pathname.split('/');
      const g = state.gists.get(id);
      return g ? { status: 200, text: g.files[name] } : { status: 404, text: 'Not found' };
    }
    if (method === 'OPTIONS') return { status: 204, text: '' };
    const auth = headers.Authorization || headers.authorization;
    if (auth !== `Bearer ${state.token}`) return { status: 401, json: { message: 'Bad credentials' } };
    if (u.pathname === '/user') return { status: 200, json: { login } };
    if (u.pathname === '/gists' && method === 'GET') {
      const page = Number(u.searchParams.get('page')) || 1;
      const per = Number(u.searchParams.get('per_page')) || 30;
      return { status: 200, json: [...state.gists.values()].slice((page - 1) * per, page * per).map(view) };
    }
    if (u.pathname === '/gists' && method === 'POST') {
      const b = JSON.parse(body);
      const g = { id: `gist${state.next++}`, public: b.public, description: b.description, files: {} };
      for (const [name, f] of Object.entries(b.files)) g.files[name] = f.content;
      state.gists.set(g.id, g);
      return { status: 201, json: view(g) };
    }
    const m = u.pathname.match(/^\/gists\/([^/]+)$/);
    if (m && state.gists.has(m[1])) {
      const g = state.gists.get(m[1]);
      if (method === 'PATCH') for (const [name, f] of Object.entries(JSON.parse(body).files)) g.files[name] = f.content;
      return { status: 200, json: view(g) };
    }
    return { status: 404, json: { message: 'Not Found' } };
  }

  // Test helpers: read or replace the synced collection, as another device would.
  const gist = () => [...state.gists.values()][0];
  const cloud = () => (gist() ? JSON.parse(gist().files[SYNC_FILE]) : null);
  const setCloud = (data) => { gist().files[SYNC_FILE] = JSON.stringify(data); };
  const addGist = (data, files = { [SYNC_FILE]: JSON.stringify(data) }) => {
    const g = { id: `gist${state.next++}`, public: false, files };
    state.gists.set(g.id, g);
    return g.id;
  };
  return { state, handle, cloud, setCloud, addGist };
}

// Route global fetch to the fakes (for unit tests running in Node).
export function installFetch({ scryfall, github } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const host = new URL(String(url)).hostname;
    const fake = host === 'api.scryfall.com' ? scryfall
      : host === 'api.github.com' || host === 'gist.githubusercontent.com' ? github : null;
    if (!fake) throw new Error(`Unexpected request in test: ${url}`);
    const r = fake.handle(String(url), options.method || 'GET', options.body, options.headers || {});
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': r.text != null ? 'text/plain' : 'application/json' } });
  };
  return () => { globalThis.fetch = original; };
}

// Minimal localStorage for modules that use it.
export function installLocalStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
  return data;
}

// A collection item as the app stores it.
export function makeItem(card, { qty = 1, finish = 'nonfoil', condition = '', language = '', added = 1 } = {}) {
  return { key: `${card.id}|${finish}`, card, qty, finish, condition, language, added };
}
