// HTML rendering: escaping, mana symbols, prices, images, list rows and the card detail view.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, symbols, oracle, faces, imageOf, srcsetOf, hasBackImage, colorsOf, priceOf, money,
  rowHTML, detailHTML, CONDITIONS, LANGUAGES, FORMATS,
} from '../public/js/render.js';
import { loadCards, makeItem } from './support/fakes.mjs';

const cards = loadCards();
const byName = (n) => cards.find((c) => c.name === n || c.name.startsWith(`${n} //`));
const delver = byName('Delver of Secrets');
const bolt = byName('Lightning Bolt');
const fireIce = byName('Fire');

describe('escaping and symbols', () => {
  test('esc escapes HTML special characters and handles null', () => {
    assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(esc(null), '');
    assert.equal(esc(3), '3');
  });
  test('mana symbols become Scryfall SVG images', () => {
    const html = symbols('{2}{W/U}{T}');
    assert.match(html, /card-symbols\/2\.svg/);
    assert.match(html, /card-symbols\/WU\.svg/, 'hybrid slash removed');
    assert.match(html, /card-symbols\/T\.svg/);
    assert.match(html, /crossorigin="anonymous"/, 'cacheable by the service worker');
  });
  test('symbols escape the surrounding text', () => {
    assert.match(symbols('<b>{R}'), /^&lt;b&gt;<img/);
  });
  test('oracle text italicises reminder text and keeps line breaks', () => {
    assert.equal(oracle('Flying (It flies.)\nHaste'), 'Flying <i>(It flies.)</i><br>Haste');
  });
});

describe('card data helpers', () => {
  test('faces returns card faces, or the card itself', () => {
    assert.equal(faces(delver).length, 2);
    assert.deepEqual(faces(bolt), [bolt]);
  });
  test('images: top-level, per face, and the back face of double-faced cards', () => {
    assert.match(imageOf(bolt), /\/normal\//);
    assert.match(imageOf(bolt, 0, 'large'), /\/large\//);
    assert.match(imageOf(delver, 1), /\/back\//);
    assert.equal(hasBackImage(delver), true);
    assert.equal(hasBackImage(bolt), false);
    assert.equal(hasBackImage(fireIce), false, 'split cards have one image');
    assert.equal(imageOf({}), '');
  });
  test('srcset offers the small and normal images with their widths', () => {
    assert.match(srcsetOf(bolt), /\/small\/.* 146w, .*\/normal\/.* 488w$/);
    assert.match(srcsetOf(delver, 1), /\/back\//);
  });
  test('colors: from the card, or combined from its faces', () => {
    assert.deepEqual(colorsOf(bolt), ['R']);
    assert.deepEqual(colorsOf({ card_faces: [{ colors: ['U'] }, { colors: ['U', 'B'] }] }), ['U', 'B']);
    assert.deepEqual(colorsOf({}), []);
  });
  test('price follows the finish, falling back to any available price', () => {
    const card = { prices: { usd: '1.00', usd_foil: '3.00', usd_etched: '5.00' } };
    assert.equal(priceOf({ card, finish: 'nonfoil' }), 1);
    assert.equal(priceOf({ card, finish: 'foil' }), 3);
    assert.equal(priceOf({ card, finish: 'etched' }), 5);
    assert.equal(priceOf({ card: { prices: { usd_foil: '2.50' } }, finish: 'nonfoil' }), 2.5);
    assert.equal(priceOf({ card: { prices: {} }, finish: 'nonfoil' }), 0);
    assert.equal(priceOf({ card: {}, finish: 'nonfoil' }), 0);
  });
  test('money formats US dollars with two decimals', () => {
    assert.equal(money(3), '$3.00');
    assert.equal(money(1234.5), '$1,234.50');
  });
});

describe('list rows', () => {
  test('a row shows name, type, rules text, set, artist, quantity and price', () => {
    const html = rowHTML(makeItem(bolt, { qty: 4 }));
    for (const s of [bolt.name, bolt.type_line, bolt.set_name, bolt.artist, 'Qty 4', `$${Number(bolt.prices.usd).toFixed(2)}`]) {
      assert.ok(html.includes(esc(s)), `missing ${s}`);
    }
    assert.match(html, /data-key="[^"]+\|nonfoil"/);
    assert.match(html, /class="qty-badge">×4</);
  });
  test('foil items show a foil badge and label', () => {
    const html = rowHTML(makeItem(bolt, { finish: 'foil' }));
    assert.match(html, /foil-badge/);
    assert.match(html, /class="finish">Foil</);
    assert.doesNotMatch(rowHTML(makeItem(bolt)), /foil-badge/);
  });
  test('quantity badge only above 1', () => {
    assert.doesNotMatch(rowHTML(makeItem(bolt)), /qty-badge/);
  });
  test('image uses responsive srcset, the given sizes, lazy loading and CORS', () => {
    const html = rowHTML(makeItem(bolt), '73px');
    assert.match(html, /srcset="[^"]*146w[^"]*488w"/);
    assert.match(html, /sizes="73px"/);
    assert.match(html, /loading="lazy"/);
    assert.match(html, /crossorigin="anonymous"/);
  });
  test('double-faced cards get a flip button and can render their back face', () => {
    assert.match(rowHTML(makeItem(delver)), /class="flip"/);
    assert.match(rowHTML(makeItem(delver), '220px', 1), /src="[^"]*\/back\//);
    assert.doesNotMatch(rowHTML(makeItem(bolt)), /class="flip"/);
  });
  test('both faces of a split card are shown', () => {
    const html = rowHTML(makeItem(fireIce));
    assert.ok(html.includes('>Fire<') && html.includes('>Ice<'));
  });
  test('missing prices show a dash', () => {
    assert.match(rowHTML(makeItem({ ...bolt, prices: {} })), /class="price">—</);
  });
  test('card text is escaped', () => {
    const html = rowHTML(makeItem({ ...bolt, name: '<script>x</script>' }));
    assert.ok(!html.includes('<script>'));
  });
});

describe('detail view', () => {
  const sel = (html, field) => html.match(new RegExp(`data-field="${field}">([\\s\\S]*?)</select>`))[1];
  const selected = (html, field) => sel(html, field).match(/<option value="([^"]*)" selected>/)?.[1];

  test('shows set, rarity, artist, value, prices and a Scryfall link', () => {
    const html = detailHTML(makeItem(bolt, { qty: 2 }));
    assert.ok(html.includes(esc(bolt.set_name)));
    assert.match(html, /r-uncommon/);
    assert.match(html, /<b>2<\/b>/);
    assert.match(html, /USD: /);
    assert.ok(html.includes(bolt.scryfall_uri));
    assert.match(html, /<b>\$[\d.]+<\/b> total/);
  });
  test('legality lists every known format the card has data for', () => {
    const html = detailHTML(makeItem(bolt));
    for (const f of FORMATS) if (bolt.legalities[f]) assert.match(html, new RegExp(`lg-${bolt.legalities[f]}">${f[0].toUpperCase()}`));
  });
  test('finish choices come from the printing, with the current one selected', () => {
    const html = detailHTML(makeItem(bolt, { finish: 'foil' }));
    assert.deepEqual([...sel(html, 'finish').matchAll(/value="(\w+)"/g)].map((m) => m[1]), bolt.finishes);
    assert.equal(selected(html, 'finish'), 'foil');
  });
  test('condition and language offer presets and "Not set"', () => {
    const html = detailHTML(makeItem(bolt, { condition: 'Lightly Played', language: 'Japanese' }));
    assert.equal(selected(html, 'condition'), 'Lightly Played');
    assert.equal(selected(html, 'language'), 'Japanese');
    for (const c of CONDITIONS) assert.ok(sel(html, 'condition').includes(`>${c}<`));
    for (const l of LANGUAGES) assert.ok(sel(html, 'language').includes(`>${l}<`));
    assert.equal(selected(detailHTML(makeItem(bolt)), 'condition'), '');
  });
  test('imported values outside the presets are kept as options', () => {
    const html = detailHTML(makeItem(bolt, { condition: 'near_mint', language: 'en' }));
    assert.equal(selected(html, 'condition'), 'near_mint');
    assert.equal(selected(html, 'language'), 'en');
  });
  test('double-faced cards get a flip button, and both faces are described', () => {
    const html = detailHTML(makeItem(delver));
    assert.match(html, /data-act="flip"/);
    assert.ok(html.includes('Insectile Aberration'));
  });
  test('cards without prices say so', () => {
    assert.match(detailHTML(makeItem({ ...bolt, prices: {} })), /No price data/);
  });
});
