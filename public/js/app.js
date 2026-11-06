import * as db from './db.js';
import { parseInput } from './importer.js';
import { resolveEntries, refreshCards, trimCard } from './scryfall.js';
import { rowHTML, detailHTML, priceOf, money, colorsOf, imageOf, esc } from './render.js';

const $ = (s) => document.querySelector(s);
const PAGE = 60;
const RARITY_ORDER = { special: 5, bonus: 5, mythic: 4, rare: 3, uncommon: 2, common: 1 };

const state = {
  items: [],
  byKey: new Map(),
  view: [],
  rendered: 0,
  faceIndex: new Map(),
  filters: { q: '', colors: new Set(), rarity: '', type: '', set: '', sort: 'name' },
};

const prefs = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ---------- Filtering & sorting ----------
const hayCache = new WeakMap();
function haystack(item) {
  if (!hayCache.has(item)) {
    const c = item.card;
    const parts = [c.name, c.type_line, c.oracle_text, c.set_name, c.set, c.artist, ...(c.keywords || [])];
    (c.card_faces || []).forEach((f) => parts.push(f.name, f.type_line, f.oracle_text));
    hayCache.set(item, parts.filter(Boolean).join(' ').toLowerCase());
  }
  return hayCache.get(item);
}

const typeLine = (c) => c.type_line || (c.card_faces || []).map((f) => f.type_line).join(' // ');

const SORTS = {
  name: (a, b) => a.card.name.localeCompare(b.card.name),
  price: (a, b) => priceOf(b) - priceOf(a),
  total: (a, b) => priceOf(b) * b.qty - priceOf(a) * a.qty,
  cmc: (a, b) => a.card.cmc - b.card.cmc || SORTS.name(a, b),
  rarity: (a, b) => (RARITY_ORDER[b.card.rarity] || 0) - (RARITY_ORDER[a.card.rarity] || 0) || SORTS.name(a, b),
  set: (a, b) =>
    (b.card.released_at || '').localeCompare(a.card.released_at || '') ||
    a.card.set_name.localeCompare(b.card.set_name) ||
    a.card.collector_number.localeCompare(b.card.collector_number, undefined, { numeric: true }),
  qty: (a, b) => b.qty - a.qty || SORTS.name(a, b),
  added: (a, b) => (b.added || 0) - (a.added || 0),
};

function applyFilters() {
  const f = state.filters;
  const terms = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const view = state.items.filter((it) => {
    const c = it.card;
    if (terms.length) {
      const hay = haystack(it);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    if (f.rarity && c.rarity !== f.rarity) return false;
    if (f.set && c.set !== f.set) return false;
    if (f.type && !typeLine(c).toLowerCase().includes(f.type)) return false;
    if (f.colors.size) {
      const cols = colorsOf(c);
      for (const col of f.colors) {
        if (col === 'C' ? cols.length : col === 'M' ? cols.length < 2 : !cols.includes(col)) return false;
      }
    }
    return true;
  });
  view.sort(SORTS[f.sort] || SORTS.name);
  state.view = view;
  resetList();
  updateStats();
}

// ---------- Rendering ----------
const list = $('#list');
const sentinel = $('#sentinel');
const observer = new IntersectionObserver((e) => { if (e[0].isIntersecting) renderMore(); }, { rootMargin: '1200px' });

function resetList() {
  list.innerHTML = '';
  state.rendered = 0;
  $('#empty').hidden = state.items.length > 0;
  $('#no-results').hidden = !(state.items.length > 0 && state.view.length === 0);
  renderMore();
}

function renderMore() {
  const slice = state.view.slice(state.rendered, state.rendered + PAGE);
  if (slice.length) list.insertAdjacentHTML('beforeend', slice.map(rowHTML).join(''));
  state.rendered += slice.length;
  observer.unobserve(sentinel);
  if (state.rendered < state.view.length) observer.observe(sentinel); // re-observe to re-trigger if still visible
}

function updateStats() {
  const total = state.items.reduce((s, i) => s + i.qty, 0);
  const value = state.items.reduce((s, i) => s + priceOf(i) * i.qty, 0);
  const shownQty = state.view.reduce((s, i) => s + i.qty, 0);
  $('#stats').innerHTML = `
    <span><b>${state.items.length.toLocaleString()}</b> unique</span>
    <span><b>${total.toLocaleString()}</b> cards</span>
    <span><b>${money(value)}</b> value</span>`;
  $('#showing').textContent = state.items.length
    ? `Showing ${state.view.length.toLocaleString()} entries (${shownQty.toLocaleString()} cards)`
    : '';
}

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

function setItems(items) {
  state.items = items;
  state.byKey = new Map(items.map((i) => [i.key, i]));
  populateSets();
  applyFilters();
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
    statusEl.textContent = `Restored ${parsed.items.length} entries from backup.`;
    finishImport(statusEl.textContent);
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
    const cardCount = incoming.reduce((s, i) => s + i.qty, 0);
    statusEl.textContent = `Imported ${cardCount.toLocaleString()} cards (${incoming.length} lines).` +
      (failed.length ? ` ${failed.length} line(s) couldn't be matched:` : ' Everything matched!');
    if (failed.length) {
      // Keep the dialog open so the unmatched lines stay visible.
      const box = $('#import-failed');
      box.hidden = false;
      box.textContent = failed.map((e) => `${e.qty} ${e.name || e.id}${e.set ? ` (${e.set.toUpperCase()})` : ''}${e.cn ? ` ${e.cn}` : ''}`).join('\n');
    } else {
      finishImport(`Imported ${cardCount.toLocaleString()} cards.`);
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
    slider.value = z;
    main.style.setProperty('--art-w', `${60 + z * 1.6}px`);          // 60px – 220px
    main.style.setProperty('--list-max', `${1100 + (100 - z) * 8}px`); // 1100px – 1900px
    main.style.setProperty('--grid-min', `${100 + z * 0.9}px`);       // 100px – 190px
    main.classList.toggle('compact', z < 40);
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
    setZoom(Number(slider.value) + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });

  const saved = Number(prefs.get('mtg.zoom', 100));
  setZoom(Number.isFinite(saved) ? saved : 100);
  setArt(prefs.get('mtg.art', '1') !== '0');
}

function openImport() {
  statusEl.textContent = '';
  $('#import-failed').hidden = true;
  importDlg.showModal();
}

// mode 'add' sums quantities for the same printing+finish; 'replace'/'merge' (backup) overwrites.
function mergeItems(existing, incoming, mode) {
  const map = new Map(existing.map((i) => [i.key, { ...i }]));
  for (const it of incoming) {
    const prev = map.get(it.key);
    if (prev && mode === 'add') prev.qty += it.qty;
    else map.set(it.key, { ...it });
  }
  return [...map.values()];
}

async function save(items, clearFirst) {
  if (clearFirst) await db.clear();
  await db.putMany(items);
  setItems(items);
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

async function changeQty(delta, removeAll) {
  const item = state.byKey.get(detailKey);
  if (!item) return;
  const qty = removeAll ? 0 : item.qty + delta;
  if (qty <= 0) {
    if (!removeAll && !confirm(`Remove ${item.card.name} from your collection?`)) return;
    await db.remove(item.key);
    setItems(state.items.filter((i) => i.key !== item.key));
    detailDlg.close();
    return;
  }
  item.qty = qty;
  await db.putMany([item]);
  applyFilters();
  openDetail(item.key);
}

// ---------- Export / refresh / clear ----------
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

async function refreshPrices() {
  if (!state.items.length) return;
  const btn = $('#btn-refresh');
  btn.disabled = true;
  try {
    const ids = [...new Set(state.items.map((i) => i.card.id))];
    const fresh = await refreshCards(ids, (_, done, total) => { btn.textContent = `Refreshing ${done}/${total}…`; });
    const items = state.items.map((i) => (fresh.has(i.card.id) ? { ...i, card: fresh.get(i.card.id) } : i));
    await save(items, false);
  } catch (err) {
    alert(`Refresh failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh prices';
  }
}

// ---------- Wire up UI ----------
function bind() {
  let searchTimer;
  $('#f-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.q = e.target.value; applyFilters(); }, 150);
  });
  for (const [id, key] of [['#f-rarity', 'rarity'], ['#f-type', 'type'], ['#f-set', 'set'], ['#f-sort', 'sort']]) {
    $(id).addEventListener('change', (e) => {
      state.filters[key] = e.target.value;
      if (key === 'sort') prefs.set('mtg.sort', e.target.value);
      applyFilters();
    });
  }
  $('#f-colors').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-color]');
    if (!btn) return;
    const c = btn.dataset.color;
    state.filters.colors.has(c) ? state.filters.colors.delete(c) : state.filters.colors.add(c);
    btn.classList.toggle('on');
    applyFilters();
  });
  $('#f-reset').addEventListener('click', () => {
    Object.assign(state.filters, { q: '', rarity: '', type: '', set: '' });
    state.filters.colors.clear();
    $('#f-search').value = '';
    ['#f-rarity', '#f-type', '#f-set'].forEach((s) => { $(s).value = ''; });
    document.querySelectorAll('#f-colors .on').forEach((b) => b.classList.remove('on'));
    applyFilters();
  });

  const setLayout = (layout) => {
    list.className = `list layout-${layout}`;
    document.querySelectorAll('#layout button').forEach((b) => b.classList.toggle('on', b.dataset.layout === layout));
    prefs.set('mtg.layout', layout);
  };
  $('#layout').addEventListener('click', (e) => { const b = e.target.closest('button[data-layout]'); if (b) setLayout(b.dataset.layout); });
  setLayout(prefs.get('mtg.layout', 'list'));
  bindZoomAndArt();

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.card-row');
    if (!row) return;
    if (e.target.closest('.flip')) {
      e.stopPropagation();
      const item = state.byKey.get(row.dataset.key);
      const face = state.faceIndex.get(item.key) === 1 ? 0 : 1;
      state.faceIndex.set(item.key, face);
      row.querySelector('.art img').src = imageOf(item.card, face);
      return;
    }
    openDetail(row.dataset.key);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.card-row');
    if (row && e.key === 'Enter') openDetail(row.dataset.key);
  });

  $('#detail-body').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'inc') changeQty(1);
    else if (act === 'dec') changeQty(-1);
    else if (act === 'remove') { if (confirm('Remove this card from your collection?')) changeQty(0, true); }
    else if (act === 'flip') {
      const img = $('#detail-body .detail-art img');
      const item = state.byKey.get(detailKey);
      const face = img.dataset.face === '1' ? 0 : 1;
      img.dataset.face = face;
      img.src = imageOf(item.card, face, 'large');
    }
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
  $('#btn-refresh').addEventListener('click', refreshPrices);
  $('#btn-clear').addEventListener('click', async () => {
    if (!state.items.length || !confirm('Delete your entire collection from this browser? (Export a backup first if unsure.)')) return;
    await db.clear();
    setItems([]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select')) { e.preventDefault(); $('#f-search').focus(); }
  });
}

async function init() {
  const sort = prefs.get('mtg.sort', 'name');
  state.filters.sort = SORTS[sort] ? sort : 'name';
  $('#f-sort').value = state.filters.sort;
  bind();
  try {
    setItems(await db.getAll());
  } catch (err) {
    console.error(err);
    alert(`Couldn't open local storage (IndexedDB): ${err.message}`);
    setItems([]);
  }
}

init();
