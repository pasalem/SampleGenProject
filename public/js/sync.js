// Optional sync between devices through a secret GitHub Gist.
// Only what identifies your cards is synced (Scryfall id, finish, quantity, condition,
// language, date added); card details and prices are re-fetched from Scryfall.
const API = 'https://api.github.com';
const FILE = 'mtg-collection-sync.json';
const K = {
  token: 'mtg.sync.token',
  gist: 'mtg.sync.gist',
  login: 'mtg.sync.login',
  synced: 'mtg.sync.synced', // `updated` stamp of the cloud copy this device last matched
  dirty: 'mtg.sync.dirty',   // '1' when this device has changes the cloud doesn't have yet
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const isConnected = () => Boolean(store.get(K.token) && store.get(K.gist));
export const account = () => store.get(K.login) || '';
export const gistUrl = () => (store.get(K.gist) ? `https://gist.github.com/${store.get(K.gist)}` : '');

async function gh(path, options = {}, token = store.get(K.token)) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new Error('GitHub rejected the token. It may have expired or been revoked.');
  if (res.status === 403 || res.status === 404) throw new Error('The token can\'t access gists. It needs the "gist" scope (classic token) or Gists: read and write (fine-grained token).');
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return res.json();
}

// Verify the token, then find this app's gist or create a new secret one.
export async function connect(token, hasLocalItems) {
  const user = await gh('/user', {}, token);
  let gistId = '';
  for (let page = 1; page <= 10 && !gistId; page++) {
    const gists = await gh(`/gists?per_page=100&page=${page}`, {}, token);
    gistId = gists.find((g) => g.files && g.files[FILE])?.id || '';
    if (gists.length < 100) break;
  }
  if (!gistId) {
    const created = await gh('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: 'MTG Collection sync data',
        public: false,
        files: { [FILE]: { content: JSON.stringify({ version: 1, updated: 0, items: [] }) } },
      }),
    }, token);
    gistId = created.id;
  }
  store.set(K.token, token);
  store.set(K.gist, gistId);
  store.set(K.login, user.login || '');
  store.set(K.synced, '0');
  store.set(K.dirty, hasLocalItems ? '1' : '0');
}

export function disconnect() {
  Object.values(K).forEach((k) => store.del(k));
}

export function markChanged() {
  if (isConnected()) store.set(K.dirty, '1');
}

// The synced form of a collection item.
export const slim = (items) => items.map((i) => ({
  id: i.card.id, finish: i.finish, qty: i.qty,
  condition: i.condition || '', language: i.language || '', added: i.added || 0,
}));

// What to do given the cloud copy's stamp and this device's state:
// 'pull' (cloud is newer), 'push' (only this device changed), 'conflict' (both changed) or 'none'.
export function decide(remoteUpdated, synced, dirty) {
  const remoteChanged = remoteUpdated > synced;
  if (remoteChanged && dirty) return 'conflict';
  if (remoteChanged) return 'pull';
  if (dirty) return 'push';
  return 'none';
}

async function readRemote() {
  const gist = await gh(`/gists/${store.get(K.gist)}`);
  const file = gist.files?.[FILE];
  if (!file) return { version: 1, updated: 0, items: [] };
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  const data = JSON.parse(text || '{}');
  return { version: 1, updated: Number(data.updated) || 0, items: Array.isArray(data.items) ? data.items : [] };
}

export async function push(items) {
  const updated = Date.now();
  await gh(`/gists/${store.get(K.gist)}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify({ version: 1, updated, items: slim(items) }) } } }),
  });
  store.set(K.synced, String(updated));
  store.set(K.dirty, '0');
}

// Call after the cloud copy has been applied locally.
export function accept(remote) {
  store.set(K.synced, String(remote.updated));
  store.set(K.dirty, '0');
}

// Compare with the cloud copy. Returns { action, remote }; the caller applies a pull or
// resolves a conflict (by calling applyRemote + accept, or push).
export async function check() {
  const remote = await readRemote();
  const action = decide(remote.updated, Number(store.get(K.synced)) || 0, store.get(K.dirty) === '1');
  return { action, remote };
}
