import * as db from './db.js';
import * as sync from './sync.js';
import { parseInput } from './importer.js';
import { resolveEntries, refreshCards, trimCard, pricesPublishedAt } from './scryfall.js';
import { rowHTML, detailHTML, money, priceOf, imageOf, srcsetOf, esc, FORMATS } from './render.js';
import { SORTS, emptyFilters, filterAndSort, mergeItems, totals, itemsFromSynced, priceRefreshDue, ago } from './collection.js';
import { loadHistory, recordValue, chartHTML, bindChart } from './history.js';

const $ = (s) => document.querySelector(s);
const PAGE = 60;
const FINISH_NAME = { nonfoil: 'non-foil', foil: 'foil', etched: 'etched foil' };

const state = {
  items: [],
  byKey: new Map(),
  view: [],
  rendered: 0,
  faceIndex: new Map(),
  zoom: 100,
  layout: 'list',
  filters: emptyFilters(),
};

const prefs = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ---------- Filtering & sorting ----------
function applyFilters() {
  state.view = filterAndSort(state.items, state.filters);
  resetList();
  updateStats();
}

// ---------- Rendering ----------
const list = $('#list');
const sentinel = $('#sentinel');
const observer = new IntersectionObserver((e) => { if (e[0].isIntersecting) renderMore(); }, { rootMargin: '1200px' });

// Approximate on-screen image width, so the browser downloads the smallest image that stays sharp.
function imageSizes() {
  if (state.layout === 'grid') return `${Math.round((100 + state.zoom * 0.9) * 1.4)}px`;
  const art = 60 + state.zoom * 1.6;
  return `${Math.round(window.innerWidth <= 700 ? Math.min(art, 120) : art)}px`;
}

const rowFor = (item) => rowHTML(item, imageSizes(), state.faceIndex.get(item.key) || 0);

function resetList() {
  list.innerHTML = '';
  state.rendered = 0;
  $('#empty').hidden = state.items.length > 0;
  $('#no-results').hidden = !(state.items.length > 0 && state.view.length === 0);
  renderMore();
}

function renderMore() {
  const slice = state.view.slice(state.rendered, state.rendered + PAGE);
  if (slice.length) list.insertAdjacentHTML('beforeend', slice.map(rowFor).join(''));
  state.rendered += slice.length;
  observer.unobserve(sentinel);
  if (state.rendered < state.view.length) observer.observe(sentinel); // re-observe to re-trigger if still visible
}

function updateStats() {
  const { cards: total, value } = totals(state.items);
  const shownQty = state.view.reduce((s, i) => s + i.qty, 0);
  $('#stats').innerHTML = `
    <span><b>${state.items.length.toLocaleString()}</b> unique</span>
    <span><b>${total.toLocaleString()}</b> cards</span>
    <button id="btn-history" class="stat-link" title="Show collection value over time"><b>${money(value)}</b> value 📈</button>`;
  $('#showing').textContent = state.items.length
    ? `Showing ${state.view.length.toLocaleString()} entries (${shownQty.toLocaleString()} cards)`
    : '';
}

const snapshotValue = () => {
  if (!state.items.length) return;
  const t = totals(state.items);
  recordValue(t.value, t.cards);
};

function populateSets() {
  const sets = new Map();
  state.items.forEach((i) => sets.set(i.card.set, i.card.set_name));
  const sel = $('#f-set');
  const current = sel.value;
  sel.innerHTML = '<option value="">All sets</option>' +
    [...sets].sort((a, b) => a[1].localeCompare(b[1]))
      .map(([code, name]) => `<option value="${esc(code)}">${esc(name)} (${esc(code.toUpperCase())})</option>`).join('');
  sel.value = sets.has(current) ? current : '';
  state.filters.set = sel.value;
}

// Replace the whole collection and rebuild the list (imports, sync, clear).
function setItems(items) {
  state.items = items;
  state.byKey = new Map(items.map((i) => [i.key, i]));
  populateSets();
  applyFilters();
}

// Swap in updated items without rebuilding the list, so the scroll position is kept.
// `renames` maps an old key to its new key (a finish change) so the row stays in place.
function patchItems(puts = [], deletes = [], renames = new Map()) {
  const map = new Map(state.byKey);
  deletes.forEach((k) => map.delete(k));
  puts.forEach((p) => map.set(p.key, p));
  state.items = [...map.values()];
  state.byKey = map;

  const deleted = new Set(deletes);
  const changed = new Set(puts.map((p) => p.key));
  const inView = new Set();
  state.view = state.view.flatMap((i) => {
    let key = i.key;
    if (deleted.has(key)) {
      key = renames.get(key);
      if (!key || !map.has(key)) return [];
    }
    if (inView.has(key)) return [];
    inView.add(key);
    return [map.get(key)];
  });

  for (const row of [...list.children]) {
    const oldKey = row.dataset.key;
    const key = deleted.has(oldKey) ? renames.get(oldKey) : oldKey;
    if (!key || !map.has(key)) row.remove();
    else if (changed.has(key)) row.outerHTML = rowFor(map.get(key));
  }
  state.rendered = list.children.length;
  $('#empty').hidden = state.items.length > 0;
  $('#no-results').hidden = !(state.items.length > 0 && state.view.length === 0);
  updateStats();
}

// Save edits to one or more items, update the list in place and mark them for sync.
async function commitChange(puts = [], deletes = [], renames) {
  await db.write(puts, deletes);
  patchItems(puts, deletes, renames);
  snapshotValue();
  collectionChanged();
}

// ---------- Import ----------
const importDlg = $('#import-dialog');
const progress = $('#import-progress');
const statusEl = $('#import-status');

function setBusy(busy) {
  $('#import-go').disabled = busy;
  $('#import-text').disabled = busy;
  $('#import-file').disabled = busy;
  progress.hidden = !busy;
}

async function doImport() {
  const text = $('#import-text').value;
  const mode = importDlg.querySelector('input[name=mode]:checked').value;
  $('#import-failed').hidden = true;
  const parsed = parseInput(text);

  if (parsed.kind === 'backup') {
    const merged = mergeItems(mode === 'replace' ? [] : state.items, parsed.items, mode);
    await save(merged, mode === 'replace');
    showPriceAge();
    finishImport(`Restored ${parsed.items.length} entries from backup.`);
    return;
  }
  if (!parsed.entries.length) {
    statusEl.textContent = "Couldn't find any cards in that input. Check the format examples below.";
    return;
  }

  setBusy(true);
  statusEl.textContent = `Found ${parsed.entries.length} lines. Contacting Scryfall…`;
  try {
    const { resolved, failed } = await resolveEntries(parsed.entries, (label, done, total) => {
      progress.max = total || 1;
      progress.value = done;
      statusEl.textContent = `${label}… ${Math.min(done, total)} / ${total}`;
    });
    const now = Date.now();
    const incoming = resolved.map(({ entry, card }) => ({
      key: `${card.id}|${entry.finish}`,
      card: trimCard(card),
      qty: entry.qty,
      finish: entry.finish,
      condition: entry.condition,
      language: entry.language,
      added: now,
    }));
    const merged = mergeItems(mode === 'replace' ? [] : state.items, incoming, 'add');
    await save(merged, mode === 'replace');
    // Freshly imported cards come with today's prices; older cards keep their own age.
    if (mode === 'replace' || !Number(prefs.get('mtg.pricesAt', 0))) prefs.set('mtg.pricesAt', String(Date.now()));
    showPriceAge();
    const count = incoming.reduce((s, i) => s + i.qty, 0);
    statusEl.textContent = `Imported ${count.toLocaleString()} cards (${incoming.length} lines).` +
      (failed.length ? ` ${failed.length} line(s) couldn't be matched:` : ' Everything matched!');
    if (failed.length) {
      // Keep the dialog open so the unmatched lines stay visible.
      const box = $('#import-failed');
      box.hidden = false;
      box.textContent = failed.map((e) => `${e.qty} ${e.name || e.id}${e.set ? ` (${e.set.toUpperCase()})` : ''}${e.cn ? ` ${e.cn}` : ''}`).join('\n');
    } else {
      finishImport(`Imported ${count.toLocaleString()} cards.`);
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Import failed: ${err.message}`;
  } finally {
    setBusy(false);
  }
}

// Close the import dialog after a successful import and confirm with a toast.
function finishImport(message) {
  $('#import-text').value = '';
  $('#import-file').value = '';
  importDlg.close();
  toast(message);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// Drop a file anywhere on the page to import it straight away.
function bindDragDrop() {
  const overlay = $('#drop-overlay');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  const show = (on) => {
    overlay.hidden = !on;
    importDlg.classList.toggle('drop-target', on);
  };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = $('#import-go').disabled ? 'none' : 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) { depth = 0; show(false); }
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    const file = e.dataTransfer.files[0];
    if (!file || $('#import-go').disabled) return; // ignore drops while an import is running
    if (!importDlg.open) openImport();
    $('#import-text').value = await file.text();
    statusEl.textContent = `Loaded ${file.name}.`;
    doImport();
  });
}

// ---------- Card size & art toggle ----------
// Zoom 100 = full-size art (the original layout); lower values shrink the art and
// widen the list so more of each card's text fits on screen.
function bindZoomAndArt() {
  const main = $('main');
  const slider = $('#f-zoom');
  const artBtn = $('#f-art');

  const setZoom = (z) => {
    z = Math.max(0, Math.min(100, Math.round(z / 5) * 5));
    state.zoom = z;
    slider.value = z;
    main.style.setProperty('--art-w', `${60 + z * 1.6}px`);          // 60px – 220px
    main.style.setProperty('--list-max', `${1100 + (100 - z) * 8}px`); // 1100px – 1900px
    main.style.setProperty('--grid-min', `${100 + z * 0.9}px`);       // 100px – 190px
    main.classList.toggle('compact', z < 40);
    updateImageSizes();
    prefs.set('mtg.zoom', z);
  };
  const setArt = (on) => {
    main.classList.toggle('no-art', !on);
    artBtn.classList.toggle('on', on);
    artBtn.setAttribute('aria-pressed', String(on));
    prefs.set('mtg.art', on ? '1' : '0');
  };

  slider.addEventListener('input', () => setZoom(Number(slider.value)));
  artBtn.addEventListener('click', () => setArt(main.classList.contains('no-art')));
  // Ctrl + wheel over the cards zooms the cards instead of the whole page.
  main.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.zoom + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });

  const saved = Number(prefs.get('mtg.zoom', 100));
  setZoom(Number.isFinite(saved) ? saved : 100);
  setArt(prefs.get('mtg.art', '1') !== '0');
}

function updateImageSizes() {
  const sizes = imageSizes();
  list.querySelectorAll('.art img').forEach((img) => { img.sizes = sizes; });
}

function openImport() {
  statusEl.textContent = '';
  $('#import-failed').hidden = true;
  importDlg.showModal();
}

async function save(items, replace) {
  await (replace ? db.replaceAll(items) : db.putMany(items));
  setItems(items);
  snapshotValue();
  collectionChanged();
}

// ---------- Detail dialog ----------
const detailDlg = $('#detail-dialog');
let detailKey = null;

function openDetail(key) {
  const item = state.byKey.get(key);
  if (!item) return;
  detailKey = key;
  $('#detail-body').innerHTML = detailHTML(item);
  if (!detailDlg.open) detailDlg.showModal();
}

// Edits in the card window run one at a time, so a quick second edit starts from the
// result of the first instead of overwriting it.
let editQueue = Promise.resolve();
function queueEdit(fn) {
  editQueue = editQueue.then(fn).catch((err) => { console.error(err); alert(`Couldn't save that change: ${err.message}`); });
  return editQueue;
}

async function changeQty(delta, removeAll) {
  const item = state.byKey.get(detailKey);
  if (!item) return;
  const qty = removeAll ? 0 : item.qty + delta;
  if (qty <= 0) {
    if (!removeAll && !confirm(`Remove ${item.card.name} from your collection?`)) return;
    await commitChange([], [item.key]);
    detailDlg.close();
    return;
  }
  await commitChange([{ ...item, qty }]);
  openDetail(item.key);
}

async function editField(field, value) {
  const item = state.byKey.get(detailKey);
  if (!item || item[field] === value) return;
  const updated = { ...item, [field]: value };
  if (field !== 'finish') {
    await commitChange([updated]);
    openDetail(updated.key);
    return;
  }
  // The key is printing + finish, so a finish change gives the item a new key.
  updated.key = `${item.card.id}|${value}`;
  const existing = state.byKey.get(updated.key);
  if (existing) {
    if (!confirm(`You already have ${existing.qty} ${FINISH_NAME[value] || value} cop${existing.qty === 1 ? 'y' : 'ies'} of this printing. Combine them into one entry?`)) {
      openDetail(item.key); // put the select back
      return;
    }
    const merged = { ...existing, qty: existing.qty + item.qty };
    await commitChange([merged], [item.key]); // the existing entry keeps its own place in the list
    openDetail(merged.key);
    return;
  }
  state.faceIndex.delete(item.key);
  await commitChange([updated], [item.key], new Map([[item.key, updated.key]]));
  openDetail(updated.key);
}

// ---------- Export ----------
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Quantity', 'Name', 'Set code', 'Set name', 'Collector number', 'Foil', 'Rarity', 'Condition', 'Language', 'Price USD', 'Scryfall ID']];
  state.items.forEach((i) => rows.push([i.qty, i.card.name, i.card.set, i.card.set_name, i.card.collector_number, i.finish,
    i.card.rarity, i.condition, i.language, priceOf(i).toFixed(2), i.card.id]));
  download(`mtg-collection-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => r.map(q).join(',')).join('\n'), 'text/csv');
}

function exportJSON() {
  download(`mtg-collection-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ items: state.items }), 'application/json');
}

// ---------- Prices ----------
// Scryfall publishes new prices once a day. The app checks when that last happened (one small
// request) on page load, hourly while open, and when you return to the tab, and refreshes only
// if Scryfall has published since the last refresh. The button refreshes on demand.
let refreshing = null;
function refreshPrices({ silent = false } = {}) {
  if (refreshing) return refreshing;
  if (!state.items.length) return Promise.resolve();
  const btn = $('#btn-refresh');
  btn.disabled = true;
  showPriceAge('Updating prices…');
  refreshing = (async () => {
    try {
      const ids = [...new Set(state.items.map((i) => i.card.id))];
      const fresh = await refreshCards(ids, (_, done, total) => { btn.textContent = `Updating ${done}/${total}…`; });
      // Apply to the current items (they may have been edited while the refresh ran).
      const puts = state.items.filter((i) => fresh.has(i.card.id)).map((i) => ({ ...i, card: fresh.get(i.card.id) }));
      await db.putMany(puts);
      patchItems(puts);
      prefs.set('mtg.pricesAt', String(Date.now()));
      snapshotValue();
      showPriceAge();
      if (!silent) toast('Prices updated.');
    } catch (err) {
      console.error(err);
      showPriceAge(null, true);
      if (!silent) alert(`Price update failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh prices';
      refreshing = null;
    }
  })();
  return refreshing;
}

let lastPriceCheck = 0;
async function refreshPricesIfDue() {
  if (!state.items.length || refreshing || !navigator.onLine) return;
  lastPriceCheck = Date.now();
  let published = 0;
  try {
    published = await pricesPublishedAt();
    prefs.set('mtg.pricesPublished', String(published));
  } catch (err) {
    console.warn('Could not check when Scryfall last updated prices:', err.message);
  }
  if (priceRefreshDue(Number(prefs.get('mtg.pricesAt', 0)), published)) await refreshPrices({ silent: true });
}

function showPriceAge(text, failed) {
  const el = $('#prices-age');
  if (!state.items.length) { el.textContent = ''; return; }
  const at = Number(prefs.get('mtg.pricesAt', 0));
  el.classList.toggle('warn', Boolean(failed));
  el.textContent = text || (at
    ? `Prices updated ${ago(at)}${failed ? ' (latest update failed)' : ''}`
    : `Prices not updated yet${failed ? ' (update failed)' : ''}`);
  const published = Number(prefs.get('mtg.pricesPublished', 0));
  el.title = (at ? `Last updated ${new Date(at).toLocaleString()}. ` : '') +
    (published ? `Scryfall last published prices ${new Date(published).toLocaleString()}; it does this once a day.` : '');
}

// ---------- Value history ----------
function openHistory() {
  const body = $('#history-body');
  body.innerHTML = chartHTML(loadHistory());
  bindChart(body);
  $('#history-dialog').showModal();
}

// ---------- Sync (GitHub Gist) ----------
let syncTimer;
let syncing = null;

function collectionChanged() {
  if (!sync.isConnected()) return;
  sync.markChanged();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(), 3000);
}

function setSyncStatus(text, error) {
  const el = $('#sync-status');
  el.textContent = text;
  el.classList.toggle('warn', Boolean(error));
  $('#btn-sync').textContent = sync.isConnected() ? (error ? 'Sync ⚠' : 'Sync ✓') : 'Sync';
}

// Rebuild the collection from the cloud copy, reusing card data we already have.
async function applyRemote(remote) {
  const cards = new Map(state.items.map((i) => [i.card.id, i.card]));
  const missing = [...new Set(remote.items.map((r) => r.id).filter((id) => !cards.has(id)))];
  if (missing.length) {
    setSyncStatus(`Downloading ${missing.length} cards from Scryfall…`);
    (await refreshCards(missing)).forEach((card, id) => cards.set(id, card));
  }
  const items = itemsFromSynced(remote.items, cards);
  await db.replaceAll(items);
  setItems(items);
  sync.accept(remote);
  snapshotValue();
}

function runSync() {
  if (!sync.isConnected()) return Promise.resolve();
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      setSyncStatus('Syncing…');
      const { action, remote } = await sync.check();
      let choice = action;
      if (action === 'conflict') {
        choice = confirm(
          `Your collection changed both on this device (${state.items.length} entries) and in the cloud (${remote.items.length} entries).\n\n` +
          'OK = use the cloud copy (replaces this device\'s collection)\nCancel = keep this device\'s copy (overwrites the cloud)',
        ) ? 'pull' : 'push';
      }
      if (choice === 'pull') { await applyRemote(remote); toast('Collection updated from your other device.'); }
      if (choice === 'push') await sync.push(state.items);
      setSyncStatus(`Synced ${ago(Date.now())} with GitHub (${sync.account()}).`);
    } catch (err) {
      console.error(err);
      setSyncStatus(`Sync failed: ${err.message}`, true);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

function renderSyncDialog() {
  const on = sync.isConnected();
  $('#sync-off').hidden = on;
  $('#sync-on').hidden = !on;
  if (on) {
    $('#sync-account').textContent = sync.account();
    $('#sync-gist').href = sync.gistUrl();
  }
}

async function connectSync() {
  const token = $('#sync-token').value.trim();
  if (!token) return;
  const btn = $('#sync-connect');
  btn.disabled = true;
  setSyncStatus('Connecting…');
  try {
    await sync.connect(token, state.items.length > 0);
    $('#sync-token').value = '';
    renderSyncDialog();
    await runSync();
  } catch (err) {
    setSyncStatus(`Couldn't connect: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Offline support ----------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable:', err));
}

// ---------- Wire up UI ----------
function bindFilters() {
  let searchTimer;
  $('#f-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.q = e.target.value; applyFilters(); }, 150);
  });
  for (const [id, key] of [['#f-rarity', 'rarity'], ['#f-type', 'type'], ['#f-set', 'set'], ['#f-sort', 'sort'], ['#f-format', 'format']]) {
    $(id).addEventListener('change', (e) => {
      state.filters[key] = e.target.value;
      if (key === 'sort') prefs.set('mtg.sort', e.target.value);
      applyFilters();
      updateMoreCount();
    });
  }
  let rangeTimer;
  for (const [id, key] of [['#f-mv-min', 'mvMin'], ['#f-mv-max', 'mvMax'], ['#f-price-min', 'priceMin'], ['#f-price-max', 'priceMax']]) {
    $(id).addEventListener('input', (e) => {
      clearTimeout(rangeTimer);
      rangeTimer = setTimeout(() => { state.filters[key] = e.target.value.trim(); applyFilters(); updateMoreCount(); }, 250);
    });
  }
  $('#f-format').insertAdjacentHTML('beforeend',
    FORMATS.map((f) => `<option value="${f}">Legal in ${f[0].toUpperCase()}${f.slice(1)}</option>`).join(''));
  $('#f-more').addEventListener('click', () => {
    const row = $('#more-filters');
    row.hidden = !row.hidden;
    $('#f-more').setAttribute('aria-expanded', String(!row.hidden));
  });

  $('#f-colors').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-color]');
    if (!btn) return;
    const c = btn.dataset.color;
    state.filters.colors.has(c) ? state.filters.colors.delete(c) : state.filters.colors.add(c);
    btn.classList.toggle('on');
    applyFilters();
  });
  $('#f-reset').addEventListener('click', () => {
    state.filters = { ...emptyFilters(), sort: state.filters.sort };
    ['#f-search', '#f-rarity', '#f-type', '#f-set', '#f-format', '#f-mv-min', '#f-mv-max', '#f-price-min', '#f-price-max']
      .forEach((s) => { $(s).value = ''; });
    document.querySelectorAll('#f-colors .on').forEach((b) => b.classList.remove('on'));
    applyFilters();
    updateMoreCount();
  });
}

function updateMoreCount() {
  const f = state.filters;
  const n = [f.format, f.mvMin || f.mvMax, f.priceMin || f.priceMax].filter(Boolean).length;
  $('#f-more').textContent = n ? `More filters (${n})` : 'More filters';
}

function bind() {
  bindFilters();

  const setLayout = (layout) => {
    state.layout = layout;
    list.className = `list layout-${layout}`;
    document.querySelectorAll('#layout button').forEach((b) => b.classList.toggle('on', b.dataset.layout === layout));
    prefs.set('mtg.layout', layout);
    updateImageSizes();
  };
  $('#layout').addEventListener('click', (e) => { const b = e.target.closest('button[data-layout]'); if (b) setLayout(b.dataset.layout); });
  setLayout(prefs.get('mtg.layout', 'list') === 'grid' ? 'grid' : 'list');
  bindZoomAndArt();

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.card-row');
    if (!row) return;
    if (e.target.closest('.flip')) {
      e.stopPropagation();
      const item = state.byKey.get(row.dataset.key);
      const face = state.faceIndex.get(item.key) === 1 ? 0 : 1;
      state.faceIndex.set(item.key, face);
      const img = row.querySelector('.art img');
      img.srcset = srcsetOf(item.card, face);
      img.src = imageOf(item.card, face);
      return;
    }
    openDetail(row.dataset.key);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.card-row');
    if (row && e.key === 'Enter' && e.target === row) openDetail(row.dataset.key);
  });

  $('#detail-body').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'inc') queueEdit(() => changeQty(1));
    else if (act === 'dec') queueEdit(() => changeQty(-1));
    else if (act === 'remove') { if (confirm('Remove this card from your collection?')) queueEdit(() => changeQty(0, true)); }
    else if (act === 'flip') {
      const img = $('#detail-body .detail-art img');
      const item = state.byKey.get(detailKey);
      const face = img.dataset.face === '1' ? 0 : 1;
      img.dataset.face = face;
      img.src = imageOf(item.card, face, 'large');
    }
  });
  $('#detail-body').addEventListener('change', (e) => {
    const field = e.target.dataset.field;
    if (field) { const value = e.target.value; queueEdit(() => editField(field, value)); }
  });
  detailDlg.addEventListener('click', (e) => { if (e.target === detailDlg) detailDlg.close(); });
  $('#detail-close').addEventListener('click', () => detailDlg.close());

  bindDragDrop();
  $('#btn-import').addEventListener('click', openImport);
  $('#btn-import-empty').addEventListener('click', openImport);
  $('#import-close').addEventListener('click', () => importDlg.close());
  $('#import-go').addEventListener('click', doImport);
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#import-text').value = await file.text();
    statusEl.textContent = `Loaded ${file.name}. Click Import to continue.`;
  });
  $('#btn-export-csv').addEventListener('click', exportCSV);
  $('#btn-export-json').addEventListener('click', exportJSON);
  $('#btn-refresh').addEventListener('click', () => refreshPrices());
  $('#btn-clear').addEventListener('click', async () => {
    if (!state.items.length || !confirm('Delete your entire collection from this browser? (Export a backup first if unsure.)')) return;
    await db.clear();
    setItems([]);
    showPriceAge();
    collectionChanged();
  });

  $('#stats').addEventListener('click', (e) => { if (e.target.closest('#btn-history')) openHistory(); });
  $('#history-close').addEventListener('click', () => $('#history-dialog').close());
  $('#history-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  $('#btn-sync').addEventListener('click', () => { renderSyncDialog(); $('#sync-dialog').showModal(); });
  $('#sync-close').addEventListener('click', () => $('#sync-dialog').close());
  $('#sync-connect').addEventListener('click', connectSync);
  $('#sync-now').addEventListener('click', () => runSync());
  $('#sync-disconnect').addEventListener('click', () => {
    if (!confirm('Stop syncing on this device? Your collection stays here, and the cloud copy stays in your gist.')) return;
    sync.disconnect();
    renderSyncDialog();
    setSyncStatus('Not connected.');
  });
  // Pick up changes made on another device when you come back to this tab.
  let lastFocusSync = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sync.isConnected() && Date.now() - lastFocusSync > 30000) {
      lastFocusSync = Date.now();
      runSync();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest?.('input, textarea, select')) { e.preventDefault(); $('#f-search').focus(); }
  });
  setInterval(() => { if (!refreshing) showPriceAge(); }, 60000);
  setInterval(refreshPricesIfDue, 60 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastPriceCheck > 10 * 60 * 1000) refreshPricesIfDue();
  });
}

async function init() {
  const sort = prefs.get('mtg.sort', 'name');
  state.filters.sort = SORTS[sort] ? sort : 'name';
  $('#f-sort').value = state.filters.sort;
  bind();
  registerServiceWorker();
  setSyncStatus(sync.isConnected() ? '' : 'Not connected.');
  try {
    setItems(await db.getAll());
  } catch (err) {
    console.error(err);
    alert(`Couldn't open local storage (IndexedDB): ${err.message}`);
    setItems([]);
  }
  showPriceAge();
  document.body.dataset.ready = 'true'; // the collection is on screen (used by the browser tests)
  if (navigator.onLine) {
    await runSync();
    await refreshPricesIfDue();
  } else {
    showPriceAge('Offline: showing the last saved prices');
  }
  document.body.dataset.settled = 'true'; // startup sync and price check have finished
}

init();
