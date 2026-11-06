// Parses collection exports into a uniform list of entries:
// { qty, name, set, cn, id, finish, condition, language }
//
// Supported:
//  - CSV/TSV exports (Moxfield, ManaBox, Deckbox, Archidekt, TCGplayer, Dragon Shield, generic)
//  - Plain text lists: "4 Lightning Bolt", "1x Sol Ring (CMR) 263 *F*"
//  - JSON backups exported from this app

const norm = (s) => String(s ?? '').trim().toLowerCase();
const looksLikeSetCode = (s) => /^[a-z0-9]{2,6}$/i.test(String(s ?? '').trim());

export function parseInput(rawText) {
  const text = String(rawText ?? '').replace(/^﻿/, '').trim();
  if (!text) return { kind: 'entries', entries: [] };

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : data.items;
      if (Array.isArray(items) && items.every((i) => i && i.key && i.card)) {
        return { kind: 'backup', items };
      }
    } catch { /* not JSON, fall through */ }
  }

  const lines = text.split(/\r?\n/);
  if (/^sep=/i.test(lines[0])) lines.shift();
  const first = lines[0] || '';
  const delim = [',', ';', '\t'].sort((a, b) => count(first, b) - count(first, a))[0];
  if (count(first, delim) > 0) {
    const header = splitRow(first, delim).map(norm);
    if (header.some((h) => NAME_COLS.includes(h) || ID_COLS.includes(h))) {
      return { kind: 'entries', entries: parseCSV(lines.join('\n'), delim) };
    }
  }
  return { kind: 'entries', entries: parseTextList(lines) };
}

function count(s, ch) {
  return s.split(ch).length - 1;
}

function splitRow(line, delim) {
  return parseRows(line, delim)[0] || [];
}

// RFC-4180-ish CSV parser (handles quotes, escaped quotes, newlines in fields).
function parseRows(text, delim) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Column names in priority order.
const QTY_COLS = ['count', 'quantity', 'qty', 'amount', 'have', 'total qty', 'copies'];
const NAME_COLS = ['simple name', 'name', 'card name', 'card', 'card_name', 'cardname'];
const SET_CODE_COLS = ['set code', 'edition code', 'set_code', 'setcode', 'edition_code', 'set id'];
const SET_ANY_COLS = ['set', 'edition', 'expansion'];
const CN_COLS = ['collector number', 'collector_number', 'collectornumber', 'card number', 'collector #', 'number', 'cn', 'card #'];
const ID_COLS = ['scryfall id', 'scryfall_id', 'scryfallid', 'scryfall uuid'];
const FOIL_COLS = ['foil', 'finish', 'printing', 'foil/variant'];
const COND_COLS = ['condition'];
const LANG_COLS = ['language', 'lang'];

function col(header, names) {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
}

function parseFinish(v) {
  const s = norm(v);
  if (!s || /non[-\s]?foil|normal|regular|^false$|^no$|^0$|^n$/.test(s)) return 'nonfoil';
  if (s.includes('etch')) return 'etched';
  if (s.includes('foil') || ['true', 'yes', '1', 'y'].includes(s)) return 'foil';
  return 'nonfoil';
}

function parseCSV(text, delim) {
  const rows = parseRows(text, delim);
  const header = rows.shift().map(norm);
  const c = {
    qty: col(header, QTY_COLS),
    name: col(header, NAME_COLS),
    setCode: col(header, SET_CODE_COLS),
    setAny: col(header, SET_ANY_COLS),
    cn: col(header, CN_COLS),
    id: col(header, ID_COLS),
    foil: col(header, FOIL_COLS),
    cond: col(header, COND_COLS),
    lang: col(header, LANG_COLS),
  };
  const get = (row, i) => (i === -1 ? '' : String(row[i] ?? '').trim());

  const entries = [];
  for (const row of rows) {
    const name = get(row, c.name);
    const id = get(row, c.id);
    if (!name && !id) continue;
    let set = get(row, c.setCode);
    if (!set) {
      const any = get(row, c.setAny);
      if (looksLikeSetCode(any)) set = any; // full set names can't be used for lookup
    }
    const qty = parseInt(get(row, c.qty), 10);
    entries.push({
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      name,
      set: set.toLowerCase(),
      cn: get(row, c.cn),
      id: /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : '',
      finish: parseFinish(get(row, c.foil)),
      condition: get(row, c.cond),
      language: get(row, c.lang),
    });
  }
  return entries;
}

const SECTION_HEADERS = /^(deck|sideboard|commander|companion|maybeboard|mainboard|about|name .*)$/i;

function parseTextList(lines) {
  const entries = [];
  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#') || line.endsWith(':') || SECTION_HEADERS.test(line)) continue;

    let finish = 'nonfoil';
    const finishMatch = line.match(/\s+\*([FE])\*\s*$/i);
    if (finishMatch) {
      finish = finishMatch[1].toUpperCase() === 'E' ? 'etched' : 'foil';
      line = line.slice(0, finishMatch.index);
    }

    const m = line.match(/^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+[(\[]([A-Za-z0-9]{2,6})[)\]](?:\s+([A-Za-z0-9★\-]+))?)?\s*$/i);
    if (!m) continue;
    entries.push({
      qty: m[1] ? parseInt(m[1], 10) : 1,
      name: m[2].trim(),
      set: (m[3] || '').toLowerCase(),
      cn: m[4] || '',
      id: '',
      finish,
      condition: '',
      language: '',
    });
  }
  return entries;
}
