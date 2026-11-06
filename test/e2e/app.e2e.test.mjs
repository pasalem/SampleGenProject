// End-to-end tests: the real app in a headless browser, served by server.js, with Scryfall,
// card images and GitHub answered by in-memory fakes (see test/support/).
// Run with: npm run test:e2e   (needs Chrome, Chromium or Edge; set CHROME_PATH to pick one)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launch, findBrowser } from '../support/browser.mjs';
import { createFakeScryfall, createFakeGitHub, loadCards } from '../support/fakes.mjs';
import { parseInput } from '../../public/js/importer.js';

const ROOT = new URL('../../', import.meta.url);
const SAMPLE = readFileSync(new URL('samples/sample-collection.txt', ROOT), 'utf8');
const SAMPLE_ENTRIES = parseInput(SAMPLE).entries;
const SAMPLE_CARDS = SAMPLE_ENTRIES.reduce((s, e) => s + e.qty, 0);
const MH2 = loadCards().slice(SAMPLE_ENTRIES.length); // 70 Modern Horizons 2 cards
const MH2_LIST = MH2.map((c) => `1 ${c.name} (MH2) ${c.collector_number}`).join('\n');
const DAY = 24 * 60 * 60 * 1000;

const browserPath = findBrowser();
const skip = !browserPath && !process.env.CI ? 'no Chrome, Chromium or Edge installed (set CHROME_PATH)' : false;

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let server, b, origin;
const scryfall = createFakeScryfall();
const github = createFakeGitHub();

// ----- page helpers -----
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = (sel) => b.eval(`${q(sel)}.click(); return 1`);
const text = (sel) => b.eval(`return ${q(sel)}?.textContent.trim() ?? null`);
const rowCount = () => b.eval(`return document.querySelectorAll('.card-row').length`);
const rowNames = () => b.eval(`return [...document.querySelectorAll('.card-row')].map(r => r.querySelector('.face .name').textContent)`);
const stats = () => b.eval(`return [...document.querySelectorAll('#stats b')].map(x => x.textContent.trim())`);
const showingCount = async () => Number((await text('#showing')).match(/Showing (\d+)/)?.[1]);
const setValue = (sel, value, event = 'input') => b.eval(`const el = ${q(sel)}; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return 1`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function importText(list, { mode = 'merge', expectClose = true } = {}) {
  await click('#btn-import');
  await b.waitFor(`${q('#import-dialog')}.open`);
  await b.eval(`${q(`input[name=mode][value=${mode}]`)}.checked = true; return 1`);
  await setValue('#import-text', list);
  await click('#import-go');
  if (expectClose) await b.waitFor(`!${q('#import-dialog')}.open`, { timeout: 20000, message: 'import dialog to close' });
  else await b.waitFor(`!${q('#import-failed')}.hidden || /Couldn't|failed/.test(${q('#import-status')}.textContent)`, { timeout: 20000 });
}

async function freshApp() {
  await b.goto('about:blank', { waitReady: false });
  await b.clearSiteData();
  await b.goto(`${origin}/`);
  await b.waitFor(`document.body.dataset.settled === 'true'`);
}

async function openCard(key) {
  // Rows past the first page load as you scroll.
  await b.waitFor(`document.querySelector('.card-row[data-key="${key}"]') || (window.scrollTo(0, document.body.scrollHeight), false)`, { message: `row ${key}` });
  await b.eval(`document.querySelector('.card-row[data-key="${key}"] .info').click(); return 1`);
  await b.waitFor(`${q('#detail-dialog')}.open`);
}
const keyOf = (name, finish = 'nonfoil') => `${loadCards().find((c) => c.name === name || c.name.startsWith(`${name} //`)).id}|${finish}`;

describe('MTG Collection in a browser', { skip, timeout: 300000 }, () => {
  before(async () => {
    const port = await freePort();
    origin = `http://localhost:${port}`;
    server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => { if (/running at/.test(d)) resolve(); });
      server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
    });
    b = await launch({ appOrigin: origin, scryfall, github });
    await b.goto(`${origin}/`);
  });
  after(async () => {
    await b?.close();
    server?.kill();
  });

  describe('startup and import', () => {
    test('an empty collection shows the import prompt', async () => {
      assert.equal(await b.eval(`return ${q('#empty')}.hidden`), false);
      assert.equal(await rowCount(), 0);
      assert.equal(await text('#prices-age'), '');
    });

    test('pasting a list imports it, closes the window and confirms', async () => {
      await setValue('#f-zoom', '0'); // smallest cards, to check image sizes below
      await importText(SAMPLE);
      assert.match(await text('#toast'), new RegExp(`Imported ${SAMPLE_CARDS} cards`));
      assert.deepEqual(await stats(), [String(SAMPLE_ENTRIES.length), String(SAMPLE_CARDS), (await stats())[2]]);
      assert.equal(await rowCount(), SAMPLE_ENTRIES.length);
      assert.equal(await b.eval(`return ${q('#empty')}.hidden`), true);
      assert.match(await text('#prices-age'), /Prices updated just now/);
      assert.equal(await b.eval(`return ${q('#import-text')}.value`), '', 'the import box is emptied');
    });

    test('small cards load Scryfall small images; full size loads the larger ones', async () => {
      await b.waitFor(`[...document.querySelectorAll('.card-row .art img')].slice(0, 3).every(i => i.complete && i.currentSrc)`);
      const small = await b.eval(`return [...document.querySelectorAll('.card-row .art img')].slice(0, 3).map(i => [i.sizes, i.currentSrc.split('/')[3]])`);
      assert.deepEqual(small, [['60px', 'small'], ['60px', 'small'], ['60px', 'small']]);
      await setValue('#f-zoom', '100');
      assert.equal(await b.eval(`return ${q('.card-row .art img')}.sizes`), '220px');
    });

    test('a list with unknown cards keeps the window open and lists them', async () => {
      await importText('1 Counterspell\n2 Definitely Not A Card', { expectClose: false });
      assert.equal(await b.eval(`return ${q('#import-dialog')}.open`), true);
      assert.match(await text('#import-status'), /1 line\(s\) couldn't be matched/);
      assert.equal(await text('#import-failed'), '2 Definitely Not A Card');
      await click('#import-close');
    });

    test('input with no cards explains the problem', async () => {
      await importText('// just a comment', { expectClose: false });
      assert.match(await text('#import-status'), /Couldn't find any cards/);
      await click('#import-close');
    });
  });

  describe('other ways to import', () => {
    before(freshApp);

    test('choosing a CSV file loads it, then Import adds it', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'mtg-csv-'));
      const file = path.join(dir, 'moxfield.csv');
      writeFileSync(file, '"Count","Name","Edition","Collector Number","Foil"\n"2","Sol Ring","cmr","472",""\n"1","Lightning Bolt","","","foil"\n');
      await click('#btn-import');
      await b.setFiles('#import-file', [file]);
      await b.waitFor(`/Loaded moxfield.csv/.test(${q('#import-status')}.textContent)`);
      await click('#import-go');
      await b.waitFor(`!${q('#import-dialog')}.open`);
      assert.deepEqual((await stats()).slice(0, 2), ['2', '3']);
      assert.equal(await b.eval(`return Boolean(document.querySelector('.card-row[data-key="${keyOf('Lightning Bolt', 'foil')}"] .foil-badge'))`), true);
    });

    test('dragging a file onto the page shows the drop target and imports it', async () => {
      const shown = await b.eval(`
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify('3 Counterspell')}], 'list.txt', { type: 'text/plain' }));
        window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        const shown = !${q('#drop-overlay')}.hidden;
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return shown`);
      assert.equal(shown, true);
      await b.waitFor(`/Imported 3 cards/.test(${q('#toast')}.textContent) && !${q('#import-dialog')}.open`);
      assert.equal(await b.eval(`return ${q('#drop-overlay')}.hidden`), true);
      assert.deepEqual((await stats()).slice(0, 2), ['3', '6']);
    });

    test('importing the same card again adds to its quantity', async () => {
      await importText('1 Counterspell');
      assert.equal(await text(`.card-row[data-key="${keyOf('Counterspell')}"] .qty`), 'Qty 4');
    });

    test('"Replace existing collection" swaps the whole collection', async () => {
      await importText('1 Llanowar Elves', { mode: 'replace' });
      assert.deepEqual(await rowNames(), ['Llanowar Elves']);
    });

    test('Backup downloads JSON that restores the collection exactly', async () => {
      await importText(SAMPLE);
      await b.eval(`document.querySelector('.card-row').click(); return 1`);
      await b.waitFor(`${q('#detail-dialog')}.open`);
      await setValue('[data-field=condition]', 'Heavily Played', 'change');
      await b.waitFor(`/Heavily Played/.test(document.querySelector('#detail-body [data-field=condition]').value)`);
      await click('#detail-close');
      const before = await b.eval(`return [...document.querySelectorAll('.card-row')].map(r => r.dataset.key + ' ' + r.querySelector('.qty').textContent)`);
      const backup = await b.download(`${q('#btn-export-json')}.click(); return 1`);
      assert.match(backup.name, /^mtg-collection-backup-\d{4}-\d\d-\d\d\.json$/);
      const data = JSON.parse(backup.text);
      assert.equal(data.items.length, before.length);
      assert.ok(data.items.some((i) => i.condition === 'Heavily Played'));

      await importText('1 Command Tower', { mode: 'replace' });
      await importText(backup.text, { mode: 'replace' });
      assert.match(await text('#toast'), new RegExp(`Restored ${before.length} entries`));
      assert.deepEqual(await b.eval(`return [...document.querySelectorAll('.card-row')].map(r => r.dataset.key + ' ' + r.querySelector('.qty').textContent)`), before);
    });

    test('Export CSV produces a file this app (and others) can import', async () => {
      const csv = await b.download(`${q('#btn-export-csv')}.click(); return 1`);
      assert.match(csv.name, /^mtg-collection-\d{4}-\d\d-\d\d\.csv$/);
      const entries = parseInput(csv.text).entries;
      const [unique, cardCount] = await stats();
      assert.equal(entries.length, Number(unique));
      assert.equal(entries.reduce((s, e) => s + e.qty, 0), Number(cardCount));
      assert.ok(entries.every((e) => /^[0-9a-f-]{36}$/.test(e.id)), 'includes Scryfall IDs for exact matching');
      assert.ok(entries.some((e) => e.finish === 'foil'));
    });
  });

  describe('browsing', () => {
    before(async () => {
      await freshApp();
      await importText(`${SAMPLE}\n${MH2_LIST}`);
    });
    const reset = () => click('#f-reset');

    test('long collections load more rows as you scroll', async () => {
      const total = SAMPLE_ENTRIES.length + MH2.length;
      assert.equal(await showingCount(), total);
      assert.equal(await rowCount(), 60);
      await b.eval(`window.scrollTo(0, document.body.scrollHeight); return 1`);
      await b.waitFor(`document.querySelectorAll('.card-row').length === ${total}`);
      await b.eval(`window.scrollTo(0, 0); return 1`);
    });

    test('search matches names and rules text; every word must match', async () => {
      await setValue('#f-search', 'lightning bolt');
      await b.waitFor(`/Showing 1 /.test(${q('#showing')}.textContent)`);
      assert.deepEqual(await rowNames(), ['Lightning Bolt']);
      await setValue('#f-search', 'flying');
      await b.waitFor(`document.querySelectorAll('.card-row').length > 3`);
      assert.ok(await b.eval(`return [...document.querySelectorAll('.card-row .oracle')].every(o => /flying/i.test(o.closest('.info').textContent))`));
      await setValue('#f-search', 'zzzz no such text');
      await b.waitFor(`!${q('#no-results')}.hidden`);
      await reset();
    });

    test('"/" jumps to the search box', async () => {
      await b.eval(`document.activeElement.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })); return 1`);
      assert.equal(await b.eval(`return document.activeElement.id`), 'f-search');
    });

    test('color buttons filter by color, colorless and multicolor, and toggle off', async () => {
      await click('#f-colors [data-color=M]');
      await b.waitFor(`document.querySelectorAll('.card-row').length < 30`);
      const multi = await rowNames();
      assert.ok(multi.includes('Fire'));
      await click('#f-colors [data-color=M]');
      await click('#f-colors [data-color=C]');
      await sleep(50);
      assert.ok((await rowNames()).includes('Sol Ring') && !(await rowNames()).includes('Fire'));
      assert.equal(await b.eval(`return ${q('#f-colors [data-color=C]')}.classList.contains('on')`), true);
      await reset();
      assert.equal(await b.eval(`return document.querySelectorAll('#f-colors .on').length`), 0);
    });

    test('type, rarity and set filters', async () => {
      await setValue('#f-type', 'planeswalker', 'change');
      assert.deepEqual(await rowNames(), ['Liliana of the Veil']);
      await reset();
      await setValue('#f-rarity', 'mythic', 'change');
      assert.ok(await b.eval(`return [...document.querySelectorAll('.card-row .rarity')].every(r => r.textContent === 'Mythic')`));
      await reset();
      assert.ok(await b.eval(`return ${q('#f-set')}.options.length > 3`), 'set list built from the collection');
      await setValue('#f-set', 'cmr', 'change');
      assert.deepEqual(await rowNames(), ['Sol Ring']);
      await reset();
    });

    test('sorting changes the order and is remembered', async () => {
      await setValue('#f-sort', 'price', 'change');
      const prices = await b.eval(`return [...document.querySelectorAll('.card-row .meta .price')].map(p => Number(p.textContent.replace(/[^\\d.]/g, '')) || 0)`);
      assert.deepEqual(prices, [...prices].sort((x, y) => y - x));
      await setValue('#f-sort', 'cmc', 'change');
      assert.equal((await rowNames())[0], 'Command Tower');
      await b.reload();
      assert.equal(await b.eval(`return ${q('#f-sort')}.value`), 'cmc');
      await setValue('#f-sort', 'name', 'change');
    });

    test('More filters: format, mana value and price ranges, with an active-count label', async () => {
      await click('#f-more');
      assert.equal(await b.eval(`return ${q('#more-filters')}.hidden`), false);
      assert.ok(await b.eval(`return [...${q('#f-format')}.options].some(o => o.value === 'commander')`));
      await setValue('#f-format', 'pauper', 'change');
      const pauper = await showingCount();
      await setValue('#f-mv-min', '3');
      await setValue('#f-mv-max', '3');
      await b.waitFor(`${q('#f-more')}.textContent === 'More filters (2)'`);
      const mv3 = await showingCount();
      assert.ok(mv3 > 0 && mv3 < pauper);
      await setValue('#f-price-min', '1000');
      await b.waitFor(`!${q('#no-results')}.hidden`);
      assert.equal(await text('#f-more'), 'More filters (3)');
      await reset();
      assert.equal(await text('#f-more'), 'More filters');
      assert.deepEqual(await b.eval(`return ['#f-format', '#f-mv-min', '#f-mv-max', '#f-price-min', '#f-search'].map(s => document.querySelector(s).value)`), ['', '', '', '', '']);
      await click('#f-more');
      assert.equal(await b.eval(`return ${q('#more-filters')}.hidden`), true);
    });
  });

  describe('view settings', () => {
    test('grid and list layouts, remembered after reload', async () => {
      await click('#layout [data-layout=grid]');
      assert.equal(await b.eval(`return ${q('#list')}.className`), 'list layout-grid');
      assert.equal(await b.eval(`return getComputedStyle(${q('.card-row .grid-caption')}).display`), 'flex');
      await b.reload();
      assert.equal(await b.eval(`return ${q('#list')}.className`), 'list layout-grid');
      await click('#layout [data-layout=list]');
      assert.equal(await b.eval(`return ${q('#layout [data-layout=list]')}.classList.contains('on')`), true);
    });

    test('the size slider and Ctrl + mouse wheel shrink and grow the art', async () => {
      const artWidth = () => b.eval(`return Math.round(${q('.card-row .art')}.getBoundingClientRect().width)`);
      assert.equal(await artWidth(), 220);
      await setValue('#f-zoom', '50');
      assert.equal(await artWidth(), 140);
      await b.eval(`${q('main')}.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true })); return 1`);
      assert.equal(await b.eval(`return ${q('#f-zoom')}.value`), '45');
      await b.eval(`${q('main')}.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })); return 1`);
      assert.equal(await b.eval(`return ${q('#f-zoom')}.value`), '50');
      await b.eval(`${q('main')}.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })); return 1`);
      assert.equal(await b.eval(`return ${q('#f-zoom')}.value`), '50', 'wheel without Ctrl scrolls normally');
      await setValue('#f-zoom', '0');
      assert.equal(await b.eval(`return ${q('main')}.classList.contains('compact')`), true);
      await b.reload();
      assert.equal(await artWidth(), 60, 'size remembered');
      await setValue('#f-zoom', '100');
    });

    test('the Art button hides and shows card images, remembered after reload', async () => {
      await click('#f-art');
      assert.equal(await b.eval(`return getComputedStyle(${q('.card-row .art')}).display`), 'none');
      assert.equal(await b.eval(`return ${q('#f-art')}.getAttribute('aria-pressed')`), 'false');
      await click('#layout [data-layout=grid]');
      assert.equal(await b.eval(`return getComputedStyle(${q('.card-row .info')}).display`), 'flex', 'grid tiles show text when art is off');
      await click('#layout [data-layout=list]');
      await b.reload();
      assert.equal(await b.eval(`return getComputedStyle(${q('.card-row .art')}).display`), 'none');
      await click('#f-art');
      assert.equal(await b.eval(`return getComputedStyle(${q('.card-row .art')}).display`), 'block');
    });

    test('phone-sized screens have no sideways scrolling', async () => {
      await b.setViewport(390, 844, true);
      await sleep(200);
      assert.ok(await b.eval(`return document.documentElement.scrollWidth <= 390`), 'page fits the screen width');
      await b.setViewport(1280, 900);
    });
  });

  describe('card details', () => {
    before(async () => {
      await freshApp();
      await importText(`${MH2_LIST}\n${SAMPLE}\n1 Lightning Bolt *F*`);
    });

    test('clicking a card or pressing Enter on it opens its details', async () => {
      await openCard(keyOf('Counterspell'));
      assert.match(await text('#detail-body h3 .name'), /Counterspell/);
      await click('#detail-close');
      await b.eval(`const r = document.querySelector('.card-row'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1`);
      await b.waitFor(`${q('#detail-dialog')}.open`);
      await b.eval(`${q('#detail-dialog')}.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1`);
      assert.equal(await b.eval(`return ${q('#detail-dialog')}.open`), false, 'clicking the backdrop closes it');
    });

    test('changing quantity keeps your place in a long list', async () => {
      await b.eval(`window.scrollTo(0, document.body.scrollHeight); return 1`);
      await b.waitFor(`document.querySelectorAll('.card-row').length > 60`);
      const key = keyOf('Swords to Plowshares');
      await b.eval(`document.querySelector('.card-row[data-key="${key}"]').scrollIntoView(); return 1`);
      const y = await b.eval(`return Math.round(scrollY)`);
      assert.ok(y > 2000);
      await openCard(key);
      assert.equal(await b.eval(`return Math.round(scrollY)`), y, 'opening the window does not scroll');
      await click('[data-act=inc]');
      await b.waitFor(`${q('#detail-body .qty-controls b')}.textContent === '4'`);
      await click('[data-act=dec]');
      await click('[data-act=dec]');
      await b.waitFor(`${q('#detail-body .qty-controls b')}.textContent === '2'`);
      assert.equal(await text(`.card-row[data-key="${key}"] .qty`), 'Qty 2');
      assert.equal(await b.eval(`return Math.round(scrollY)`), y);
      assert.ok(await rowCount() > 60, 'loaded rows kept');
      await click('#detail-close');
    });

    test('reducing to zero asks first; Remove deletes the card', async () => {
      const key = keyOf('Command Tower');
      await openCard(key);
      b.dialogAnswers.push(false);
      await click('[data-act=dec]');
      await sleep(200);
      assert.match(b.dialogs.at(-1), /Remove Command Tower/);
      assert.equal(await b.eval(`return ${q('#detail-dialog')}.open`), true, 'cancelled: kept');
      await click('[data-act=dec]'); // accept
      await b.waitFor(`!document.querySelector('.card-row[data-key="${key}"]') && !${q('#detail-dialog')}.open`);
      const key2 = keyOf('Wrath of God');
      await openCard(key2);
      await click('[data-act=remove]');
      await b.waitFor(`!document.querySelector('.card-row[data-key="${key2}"]')`);
      assert.equal((await stats())[0], String(MH2.length + SAMPLE_ENTRIES.length + 1 - 2));
    });

    test('condition and language can be edited and are saved', async () => {
      const key = keyOf('Llanowar Elves');
      await openCard(key);
      await setValue('[data-field=condition]', 'Near Mint', 'change');
      await setValue('[data-field=language]', 'German', 'change');
      await b.waitFor(`${q('#detail-body [data-field=language]')}.value === 'German'`);
      await click('#detail-close');
      await b.reload();
      await openCard(key);
      assert.deepEqual(await b.eval(`return ['condition', 'language'].map(f => document.querySelector('#detail-body [data-field=' + f + ']').value)`), ['Near Mint', 'German']);
      await click('#detail-close');
    });

    test('quick repeated edits are all kept', async () => {
      const key = keyOf('Sol Ring');
      await openCard(key);
      await b.eval(`for (let i = 0; i < 3; i++) document.querySelector('#detail-body [data-act=inc]').click();
        const c = document.querySelector('#detail-body [data-field=condition]'); c.value = 'Damaged'; c.dispatchEvent(new Event('change', { bubbles: true }));
        return 1`);
      await b.waitFor(`document.querySelector('.card-row[data-key="${key}"] .qty').textContent === 'Qty 4'`);
      await b.waitFor(`${q('#detail-body [data-field=condition]')}.value === 'Damaged'`);
      await click('#detail-close');
    });

    test('changing finish moves the card to the new finish in place', async () => {
      const key = keyOf('Liliana of the Veil');
      const index = await b.eval(`return [...document.querySelectorAll('.card-row')].findIndex(r => r.dataset.key === '${key}')`);
      await openCard(key);
      await setValue('[data-field=finish]', 'foil', 'change');
      const foilKey = keyOf('Liliana of the Veil', 'foil');
      await b.waitFor(`document.querySelector('.card-row[data-key="${foilKey}"] .foil-badge')`);
      assert.equal(await b.eval(`return [...document.querySelectorAll('.card-row')].findIndex(r => r.dataset.key === '${foilKey}')`), index);
      assert.equal(await b.eval(`return Boolean(document.querySelector('.card-row[data-key="${key}"]'))`), false);
      await click('#detail-close');
    });

    test('changing finish to one you already have offers to combine them', async () => {
      const key = keyOf('Lightning Bolt');
      await openCard(key);
      b.dialogAnswers.push(false);
      await setValue('[data-field=finish]', 'foil', 'change');
      await sleep(200);
      assert.match(b.dialogs.at(-1), /already have 1 foil copy/);
      assert.equal(await b.eval(`return ${q('#detail-body [data-field=finish]')}.value`), 'nonfoil', 'cancelled: unchanged');
      await setValue('[data-field=finish]', 'foil', 'change'); // accept
      const foilKey = keyOf('Lightning Bolt', 'foil');
      await b.waitFor(`document.querySelector('.card-row[data-key="${foilKey}"] .qty')?.textContent === 'Qty 5'`);
      assert.equal(await b.eval(`return Boolean(document.querySelector('.card-row[data-key="${key}"]'))`), false);
      await click('#detail-close');
    });

    test('double-faced cards flip, in the list and in the details', async () => {
      const key = keyOf('Delver of Secrets');
      const src = () => b.eval(`return document.querySelector('.card-row[data-key="${key}"] .art img').getAttribute('src')`);
      assert.match(await src(), /\/front\//);
      await b.eval(`document.querySelector('.card-row[data-key="${key}"] .flip').click(); return 1`);
      assert.match(await src(), /\/back\//);
      assert.equal(await b.eval(`return ${q('#detail-dialog')}.open`), false, 'flipping does not open the card');
      await openCard(key);
      await click('#detail-body [data-act=flip]');
      assert.match(await b.eval(`return ${q('#detail-body .detail-art img')}.src`), /\/back\//);
      await click('#detail-close');
    });
  });

  describe('prices and value history', () => {
    let lastRefresh;
    before(async () => {
      await freshApp();
      await importText(SAMPLE);
    });
    const collectionRequests = () => scryfall.count('/cards/collection');
    const boltPrice = () => b.eval(`return Number(document.querySelector('.card-row[data-key="${keyOf('Lightning Bolt')}"] .meta .price').textContent.replace('$', ''))`);

    test('no download when prices are already newer than Scryfall\'s last update', async () => {
      scryfall.state.publishedAt = Date.now() - 60 * 60 * 1000;
      const [lookups, checks] = [collectionRequests(), scryfall.count('/bulk-data/default-cards')];
      await b.reload();
      assert.equal(scryfall.count('/bulk-data/default-cards'), checks + 1, 'one small check');
      assert.equal(collectionRequests(), lookups, 'no price download');
    });

    test('prices download after Scryfall publishes new ones', async () => {
      const before = await boltPrice();
      scryfall.state.publishedAt = Date.now(); // after the import's prices
      scryfall.state.priceBump = 10;
      const lookups = collectionRequests();
      await b.reload();
      assert.ok(collectionRequests() > lookups);
      assert.equal(await boltPrice(), Math.round((before + 10) * 100) / 100);
      assert.match(await text('#prices-age'), /Prices updated just now/);
      assert.match(await b.eval(`return ${q('#prices-age')}.title`), /once a day/);
      lastRefresh = collectionRequests();
      await b.reload();
      assert.equal(collectionRequests(), lastRefresh, 'not again until the next publish');
    });

    test('if the check fails, prices still refresh once they are a day old', async () => {
      await b.eval(`localStorage.setItem('mtg.pricesAt', String(Date.now() - 2 * ${DAY})); return 1`);
      scryfall.state.failNext = 1; // the publish-time check
      await b.reload();
      assert.ok(collectionRequests() > lastRefresh);
    });

    test('Refresh prices updates on demand and reports failures', async () => {
      scryfall.state.priceBump = 20;
      const before = await boltPrice();
      await click('#btn-refresh');
      await b.waitFor(`${q('#toast')}.textContent === 'Prices updated.' && !${q('#btn-refresh')}.disabled`);
      assert.equal(await boltPrice(), Math.round((before + 10) * 100) / 100);
      scryfall.state.failNext = 5;
      await click('#btn-refresh');
      await b.waitFor(`${q('#prices-age')}.classList.contains('warn')`);
      assert.match(b.dialogs.at(-1), /Price update failed/);
      assert.match(await text('#prices-age'), /latest update failed/);
      scryfall.state.failNext = 0;
    });

    test('the value chart shows history with hover details and a table', async () => {
      const day = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
      await b.eval(`const h = JSON.parse(localStorage.getItem('mtg.history'));
        localStorage.setItem('mtg.history', JSON.stringify([${[4, 3, 2, 1].map((n) => `{ day: '${day(n)}', t: 0, value: ${100 + n}, cards: 10 }`).join(',')}, ...h])); return 1`);
      await click('#btn-history');
      await b.waitFor(`${q('#history-dialog')}.open`);
      assert.equal(await b.eval(`return ${q('#history-body tbody')}.rows.length`), 5);
      assert.match(await b.eval(`return ${q('.chart .line')}.getAttribute('d')`), /^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+){4}$/);
      assert.equal(await text('.hist-now'), (await stats())[2], 'latest point matches the collection value');
      const tip = await b.eval(`const hit = document.querySelector('.chart .hit'); const r = hit.getBoundingClientRect();
        hit.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 2, clientY: r.top + 10, bubbles: true }));
        return { shown: !document.querySelector('.chart-tip').hidden, text: document.querySelector('.chart-tip').textContent }`);
      assert.equal(tip.shown, true);
      assert.match(tip.text, /\$104\.00/, 'nearest point is the oldest day');
      await b.eval(`document.querySelector('.chart .hit').dispatchEvent(new PointerEvent('pointerleave')); return 1`);
      assert.equal(await b.eval(`return ${q('.chart-tip')}.hidden`), true);
      await click('#history-close');
    });
  });

  describe('sync between devices', () => {
    before(freshApp);
    const syncStatus = () => text('#sync-status');

    test('a wrong token is rejected with an explanation', async () => {
      await importText(SAMPLE);
      await click('#btn-sync');
      assert.equal(await b.eval(`return ${q('#sync-on')}.hidden`), true);
      await setValue('#sync-token', 'wrong-token');
      await click('#sync-connect');
      await b.waitFor(`/Couldn't connect: GitHub rejected the token/.test(${q('#sync-status')}.textContent)`);
      assert.equal(await text('#btn-sync'), 'Sync');
    });

    test('connecting creates a private gist and uploads the collection', async () => {
      await setValue('#sync-token', 'test-token');
      await click('#sync-connect');
      await b.waitFor(`/Synced/.test(${q('#sync-status')}.textContent)`);
      assert.equal(await b.eval(`return ${q('#sync-off')}.hidden && !${q('#sync-on')}.hidden`), true);
      assert.equal(await text('#sync-account'), 'tester');
      assert.equal(await b.eval(`return ${q('#sync-token')}.value`), '', 'token field cleared');
      assert.equal(await text('#btn-sync'), 'Sync ✓');
      assert.equal(github.cloud().items.length, SAMPLE_ENTRIES.length);
      assert.equal([...github.state.gists.values()][0].public, false);
      await click('#sync-close');
    });

    test('edits upload automatically a few seconds later', async () => {
      const key = keyOf('Counterspell');
      await openCard(key);
      await click('[data-act=inc]');
      await click('#detail-close');
      const id = key.split('|')[0];
      const end = Date.now() + 10000;
      while (Date.now() < end && github.cloud().items.find((i) => i.id === id).qty !== 3) await sleep(200);
      assert.equal(github.cloud().items.find((i) => i.id === id).qty, 3);
    });

    test('changes from another device are downloaded', async () => {
      const cloud = github.cloud();
      github.setCloud({ ...cloud, updated: Date.now() + 1000, items: cloud.items.slice(1).map((i, n) => (n === 0 ? { ...i, qty: 9 } : i)) });
      await click('#btn-sync');
      await click('#sync-now');
      await b.waitFor(`/from your other device/.test(${q('#toast')}.textContent)`);
      assert.equal((await stats())[0], String(SAMPLE_ENTRIES.length - 1));
      const first = github.cloud().items[0];
      assert.equal(await text(`.card-row[data-key="${first.id}|${first.finish}"] .qty`), 'Qty 9');
      await click('#sync-close');
    });

    test('when both sides changed, you choose which copy to keep', async () => {
      const both = async (answer) => {
        const cloud = github.cloud();
        github.setCloud({ ...cloud, updated: Date.now() + 2000, items: cloud.items.slice(0, 3) });
        await importText('1 Fire // Ice'); // a local change
        b.dialogAnswers.push(answer);
        await click('#btn-sync');
        await click('#sync-now');
        await b.waitFor(`/Synced/.test(${q('#sync-status')}.textContent) && !/Syncing/.test(${q('#sync-status')}.textContent)`);
        await sleep(300);
        await click('#sync-close');
      };
      await both(true); // OK = use the cloud copy
      assert.match(b.dialogs.at(-1), /changed both on this device/);
      assert.equal((await stats())[0], '3');
      await both(false); // Cancel = keep this device's copy
      assert.equal((await stats())[0], '4');
      assert.equal(github.cloud().items.length, 4);
    });

    test('a new device downloads the collection, including card details', async () => {
      const cloudCount = github.cloud().items.length;
      await b.goto('about:blank', { waitReady: false });
      await b.clearSiteData();
      await b.goto(`${origin}/`);
      assert.equal(await rowCount(), 0);
      await click('#btn-sync');
      await setValue('#sync-token', 'test-token');
      await click('#sync-connect');
      await b.waitFor(`document.querySelectorAll('.card-row').length === ${cloudCount}`);
      assert.equal(github.state.gists.size, 1, 'reused the existing gist');
      assert.ok(await b.eval(`return [...document.querySelectorAll('.card-row .face .name')].every(n => n.textContent.length > 0)`));
      await click('#sync-close');
    });

    test('disconnecting keeps the collection on this device', async () => {
      const count = await rowCount();
      await click('#btn-sync');
      b.dialogAnswers.push(true);
      await click('#sync-disconnect');
      await b.waitFor(`!${q('#sync-off')}.hidden`);
      assert.equal(await syncStatus(), 'Not connected.');
      assert.equal(await rowCount(), count);
      assert.equal(await b.eval(`return Object.keys(localStorage).filter(k => k.startsWith('mtg.sync')).length`), 0);
      await click('#sync-close');
    });
  });

  describe('clearing', () => {
    test('Clear asks first, then empties the collection', async () => {
      const count = await rowCount();
      assert.ok(count > 0);
      b.dialogAnswers.push(false);
      await click('#btn-clear');
      await sleep(200);
      assert.equal(await rowCount(), count, 'cancelled: kept');
      await click('#btn-clear');
      await b.waitFor(`!${q('#empty')}.hidden`);
      await b.reload();
      assert.equal(await rowCount(), 0, 'stays empty after reload');
    });
  });

  describe('offline', () => {
    test('the app and card images load with no network', async () => {
      await importText(SAMPLE);
      await b.reload();
      assert.ok(await b.eval(`return Boolean(navigator.serviceWorker.controller)`), 'service worker controls the page');
      await b.waitFor(`[...document.querySelectorAll('.card-row .art img')].slice(0, 3).every(i => i.complete && i.naturalWidth > 0)`);
      b.offline = true;
      try {
        await b.reload();
        assert.equal(await rowCount(), SAMPLE_ENTRIES.length);
        await b.waitFor(`[...document.querySelectorAll('.card-row .art img')].slice(0, 3).every(i => i.complete && i.naturalWidth > 0)`, { message: 'cached images' });
        assert.equal(await b.eval(`return getComputedStyle(document.querySelector('.topbar')).position`), 'sticky', 'styles loaded from cache');
      } finally {
        b.offline = false;
      }
    });
  });

  test('no uncaught errors in the page', () => {
    assert.deepEqual(b.errors, []);
  });
});
