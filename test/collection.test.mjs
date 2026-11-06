// Filtering, sorting, merging, totals, sync rebuilding and the price-refresh schedule.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SORTS, emptyFilters, matchesFilters, filterAndSort, mergeItems, totals, itemsFromSynced,
  priceRefreshDue, ago, typeLine, DAY_MS,
} from '../public/js/collection.js';
import { loadCards, makeItem } from './support/fakes.mjs';

const cards = loadCards();
const byName = (n) => cards.find((c) => c.name === n || c.name.startsWith(`${n} //`));
const bolt = makeItem(byName('Lightning Bolt'), { qty: 4 });
const solRing = makeItem(byName('Sol Ring'));
const delver = makeItem(byName('Delver of Secrets'));
const counterspell = makeItem(byName('Counterspell'), { qty: 2 });
const ragavanFoil = makeItem(byName('Ragavan, Nimble Pilferer'), { finish: 'foil' });
const fireIce = makeItem(byName('Fire'));
const tower = makeItem(byName('Command Tower'));
const liliana = makeItem(byName('Liliana of the Veil'));
const all = [bolt, solRing, delver, counterspell, ragavanFoil, fireIce, tower, liliana];
const names = (items) => items.map((i) => i.card.name.split(' // ')[0]);
const filtered = (patch) => names(filterAndSort(all, { ...emptyFilters(), ...patch }));

describe('search', () => {
  test('no filters keeps everything, sorted by name', () => {
    assert.deepEqual(filtered({}), ['Command Tower', 'Counterspell', 'Delver of Secrets', 'Fire', 'Lightning Bolt', 'Liliana of the Veil', 'Ragavan, Nimble Pilferer', 'Sol Ring']);
  });
  test('matches name, type and rules text, case-insensitively', () => {
    assert.deepEqual(filtered({ q: 'bolt' }), ['Lightning Bolt']);
    assert.deepEqual(filtered({ q: 'PLANESWALKER' }), ['Liliana of the Veil']);
    assert.ok(filtered({ q: 'counter target spell' }).includes('Counterspell'));
  });
  test('every word must match', () => {
    assert.deepEqual(filtered({ q: 'lightning damage' }), ['Lightning Bolt']);
    assert.deepEqual(filtered({ q: 'lightning nonexistentword' }), []);
  });
  test('matches the back face of double-faced cards and the artist', () => {
    assert.deepEqual(filtered({ q: 'insectile' }), ['Delver of Secrets']);
    assert.ok(filtered({ q: byName('Sol Ring').artist.toLowerCase() }).includes('Sol Ring'));
  });
});

describe('filters', () => {
  test('color filters: each selected color must be present', () => {
    assert.deepEqual(filtered({ colors: new Set(['R']) }), ['Fire', 'Lightning Bolt', 'Ragavan, Nimble Pilferer']);
    assert.deepEqual(filtered({ colors: new Set(['R', 'U']) }), ['Fire']);
  });
  test('colorless and multicolor', () => {
    assert.deepEqual(filtered({ colors: new Set(['C']) }), ['Command Tower', 'Sol Ring']);
    assert.deepEqual(filtered({ colors: new Set(['M']) }), ['Fire']);
  });
  test('colors of double-faced cards come from their faces', () => {
    assert.deepEqual(filtered({ colors: new Set(['U']) }), ['Counterspell', 'Delver of Secrets', 'Fire']);
  });
  test('type, rarity and set', () => {
    assert.deepEqual(filtered({ type: 'planeswalker' }), ['Liliana of the Veil']);
    assert.deepEqual(filtered({ type: 'land' }), ['Command Tower']);
    assert.deepEqual(filtered({ rarity: 'mythic' }), ['Liliana of the Veil', 'Ragavan, Nimble Pilferer']);
    assert.deepEqual(filtered({ set: 'mh2' }), ['Ragavan, Nimble Pilferer']);
  });
  test('format legality includes restricted cards and excludes banned/not legal', () => {
    assert.deepEqual(filtered({ format: 'pauper' }), ['Command Tower', 'Counterspell', 'Delver of Secrets', 'Fire', 'Lightning Bolt']);
    const restricted = makeItem({ ...byName('Sol Ring'), legalities: { vintage: 'restricted' } });
    const banned = makeItem({ ...byName('Sol Ring'), id: 'x', legalities: { vintage: 'banned' } });
    assert.equal(matchesFilters(restricted, { ...emptyFilters(), format: 'vintage' }), true);
    assert.equal(matchesFilters(banned, { ...emptyFilters(), format: 'vintage' }), false);
  });
  test('mana value range, open-ended on either side', () => {
    assert.deepEqual(filtered({ mvMin: '3' }), ['Fire', 'Liliana of the Veil']);
    assert.deepEqual(filtered({ mvMax: '0' }), ['Command Tower']);
    assert.deepEqual(filtered({ mvMin: '2', mvMax: '2' }), ['Counterspell']);
  });
  test('price range uses the price of the owned finish', () => {
    const foilPrice = Number(ragavanFoil.card.prices.usd_foil);
    assert.ok(filtered({ priceMin: String(foilPrice - 0.01) }).includes('Ragavan, Nimble Pilferer'));
    assert.deepEqual(filtered({ priceMin: '1000' }), []);
    assert.ok(!filtered({ priceMax: '1' }).includes('Counterspell'));
  });
  test('non-numeric range input is ignored', () => {
    assert.equal(filtered({ mvMin: 'abc', priceMax: '' }).length, all.length);
  });
  test('filters combine', () => {
    assert.deepEqual(filtered({ colors: new Set(['R']), rarity: 'uncommon', q: 'damage' }), ['Fire', 'Lightning Bolt']);
  });
  test('typeLine joins face type lines when the card has none', () => {
    assert.equal(typeLine({ card_faces: [{ type_line: 'Instant' }, { type_line: 'Sorcery' }] }), 'Instant // Sorcery');
  });
});

describe('sorting', () => {
  const sorted = (sort) => names(filterAndSort(all, { ...emptyFilters(), sort }));
  test('price (each), highest first', () => {
    assert.equal(sorted('price')[0], 'Ragavan, Nimble Pilferer');
  });
  test('total value counts quantity', () => {
    const cheap = makeItem({ ...byName('Sol Ring'), id: 'c', name: 'Cheap', prices: { usd: '1.00' } }, { qty: 100 });
    const pricey = makeItem({ ...byName('Sol Ring'), id: 'p', name: 'Pricey', prices: { usd: '50.00' } });
    assert.deepEqual(names([pricey, cheap].sort(SORTS.total)), ['Cheap', 'Pricey']);
  });
  test('mana value ascending, ties by name', () => {
    assert.deepEqual(sorted('cmc').slice(0, 2), ['Command Tower', 'Delver of Secrets']);
  });
  test('rarity: mythic first', () => {
    assert.deepEqual(sorted('rarity').slice(0, 2), ['Liliana of the Veil', 'Ragavan, Nimble Pilferer']);
  });
  test('set: newest release first', () => {
    const order = filterAndSort(all, { ...emptyFilters(), sort: 'set' }).map((i) => i.card.released_at);
    assert.deepEqual(order, [...order].sort().reverse());
  });
  test('quantity, most first', () => {
    assert.deepEqual(sorted('qty').slice(0, 2), ['Lightning Bolt', 'Counterspell']);
  });
  test('recently added first', () => {
    const a = { ...solRing, added: 5 }, b = { ...bolt, added: 9 };
    assert.deepEqual(names([a, b].sort(SORTS.added)), ['Lightning Bolt', 'Sol Ring']);
  });
  test('unknown sort falls back to name', () => {
    assert.deepEqual(sorted('nope'), sorted('name'));
  });
});

describe('merging imports', () => {
  test('"add" sums quantities of the same printing and finish', () => {
    const merged = mergeItems([bolt], [{ ...bolt, qty: 2 }, solRing], 'add');
    assert.equal(merged.find((i) => i.key === bolt.key).qty, 6);
    assert.equal(merged.length, 2);
  });
  test('different finishes stay separate entries', () => {
    const foil = makeItem(bolt.card, { finish: 'foil' });
    assert.equal(mergeItems([bolt], [foil], 'add').length, 2);
  });
  test('backup restore overwrites instead of adding', () => {
    const merged = mergeItems([bolt], [{ ...bolt, qty: 1 }], 'merge');
    assert.equal(merged[0].qty, 1);
  });
  test('does not modify the existing items', () => {
    const existing = [{ ...bolt }];
    mergeItems(existing, [{ ...bolt, qty: 1 }], 'add');
    assert.equal(existing[0].qty, 4);
  });
});

test('totals: unique entries, card count and value', () => {
  const t = totals([bolt, counterspell]);
  assert.equal(t.unique, 2);
  assert.equal(t.cards, 6);
  assert.equal(Math.round(t.value * 100), Math.round((4 * Number(bolt.card.prices.usd) + 2 * Number(counterspell.card.prices.usd)) * 100));
  assert.deepEqual(totals([]), { unique: 0, cards: 0, value: 0 });
});

test('itemsFromSynced rebuilds items and drops cards with no data', () => {
  const synced = [
    { id: bolt.card.id, finish: 'foil', qty: 3, condition: 'Near Mint', language: '', added: 7 },
    { id: 'missing', finish: 'nonfoil', qty: 1 },
  ];
  const items = itemsFromSynced(synced, new Map([[bolt.card.id, bolt.card]]), 99);
  assert.deepEqual(items, [{ key: `${bolt.card.id}|foil`, card: bolt.card, qty: 3, finish: 'foil', condition: 'Near Mint', language: '', added: 7 }]);
  assert.equal(itemsFromSynced([{ id: bolt.card.id, finish: 'nonfoil', qty: 1 }], new Map([[bolt.card.id, bolt.card]]), 99)[0].added, 99);
});

describe('price refresh schedule', () => {
  const published = Date.parse('2026-11-05T22:06:50Z');
  test('never refreshed: refresh', () => {
    assert.equal(priceRefreshDue(0, published), true);
  });
  test('refreshed before Scryfall published new prices: refresh', () => {
    assert.equal(priceRefreshDue(published - 1000, published), true);
  });
  test('refreshed after Scryfall published: wait for the next publish', () => {
    assert.equal(priceRefreshDue(published + 1000, published, published + 20 * 60 * 60 * 1000), false);
    assert.equal(priceRefreshDue(published + 1000, published, published + 3 * DAY_MS), false, 'still the latest prices');
  });
  test('publish time unknown (check failed): refresh once a day', () => {
    const last = published;
    assert.equal(priceRefreshDue(last, 0, last + DAY_MS - 1), false);
    assert.equal(priceRefreshDue(last, 0, last + DAY_MS), true);
  });
});

test('ago() formats relative times', () => {
  const now = 1_000_000_000_000;
  assert.equal(ago(now - 10_000, now), 'just now');
  assert.equal(ago(now - 5 * 60_000, now), '5 min ago');
  assert.equal(ago(now - 60 * 60_000, now), '1 hour ago');
  assert.equal(ago(now - 5 * 60 * 60_000, now), '5 hours ago');
  assert.equal(ago(now - 3 * DAY_MS, now), '3 days ago');
});
