// Scryfall client: card lookup with fallbacks, batching, retries, price refresh and publish time.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeScryfall, installFetch, loadCards } from './support/fakes.mjs';
import { resolveEntries, refreshCards, trimCard, pricesPublishedAt } from '../public/js/scryfall.js';

const cards = loadCards();
const byName = (n) => cards.find((c) => c.name === n || c.name.startsWith(`${n} //`));
const entry = (o) => ({ qty: 1, name: '', set: '', cn: '', id: '', finish: 'nonfoil', condition: '', language: '', ...o });

let fake, restore;
beforeEach(() => { fake = createFakeScryfall(); restore = installFetch({ scryfall: fake }); });
afterEach(() => restore());

describe('resolving imported entries', () => {
  test('by Scryfall id, by set + collector number, and by name', async () => {
    const bolt = byName('Lightning Bolt'), sol = byName('Sol Ring');
    const { resolved, failed } = await resolveEntries([
      entry({ id: bolt.id, name: 'Lightning Bolt' }),
      entry({ name: 'Sol Ring', set: 'cmr', cn: '472' }),
      entry({ name: 'Counterspell' }),
    ]);
    assert.deepEqual(failed, []);
    assert.deepEqual(resolved.map((r) => r.card.id), [bolt.id, sol.id, byName('Counterspell').id]);
    assert.equal(fake.count('/cards/collection'), 1, 'one batched request');
  });
  test('a wrong collector number falls back to name + set, then name only', async () => {
    const { resolved, failed } = await resolveEntries([
      entry({ name: 'Ragavan, Nimble Pilferer', set: 'mh2', cn: '9999' }),
      entry({ name: 'Counterspell', set: 'zzz' }),
    ]);
    assert.deepEqual(failed, []);
    assert.deepEqual(resolved.map((r) => r.card.name), ['Ragavan, Nimble Pilferer', 'Counterspell']);
    assert.equal(fake.count('/cards/collection'), 3, 'exact, then name+set, then name');
  });
  test('a set + number that points to a different card is not accepted', async () => {
    const other = byName('Lightning Bolt');
    const { resolved } = await resolveEntries([entry({ name: 'Counterspell', set: other.set, cn: other.collector_number })]);
    assert.equal(resolved[0].card.name, 'Counterspell', 'retried by name instead of taking Lightning Bolt');
  });
  test('unknown cards are reported as failed', async () => {
    const { resolved, failed } = await resolveEntries([entry({ name: 'Not A Real Card' }), entry({ name: 'Counterspell' })]);
    assert.equal(resolved.length, 1);
    assert.deepEqual(failed.map((e) => e.name), ['Not A Real Card']);
  });
  test('entries with neither name nor id fail without a request', async () => {
    const { failed } = await resolveEntries([entry({ qty: 2 })]);
    assert.equal(failed.length, 1);
    assert.equal(fake.count('/cards/collection'), 0);
  });
  test('split and double-faced cards match by full name or front face, ignoring accents', async () => {
    const { resolved, failed } = await resolveEntries([
      entry({ name: 'Fire // Ice' }), entry({ name: 'Delver of Secrets' }), entry({ name: 'Délver of Secrets' }),
    ]);
    assert.deepEqual(failed, []);
    assert.equal(resolved.length, 3);
  });
  test('duplicate lines share one lookup but each keeps its own quantity and finish', async () => {
    const { resolved } = await resolveEntries([entry({ name: 'Counterspell', qty: 2 }), entry({ name: 'Counterspell', qty: 3, finish: 'foil' })]);
    assert.deepEqual(resolved.map((r) => [r.entry.qty, r.entry.finish]), [[2, 'nonfoil'], [3, 'foil']]);
    assert.equal(JSON.parse(fake.state.requests[0].body).identifiers.length, 1);
  });
  test('more than 75 cards are split into batches, with progress reports', async () => {
    const entries = cards.slice(0, 80).map((c) => entry({ id: c.id, name: c.name }));
    const progress = [];
    const { resolved } = await resolveEntries(entries, (label, done, total) => progress.push([label, done, total]));
    assert.equal(resolved.length, 80);
    assert.equal(fake.count('/cards/collection'), 2);
    assert.deepEqual(progress.at(-1), ['Looking up cards', 80, 80]);
    assert.deepEqual(progress[0], ['Looking up cards', 0, 80]);
  });
  test('rate limiting (429) is retried', async () => {
    fake.state.rateLimitNext = 1;
    const { resolved } = await resolveEntries([entry({ name: 'Counterspell' })]);
    assert.equal(resolved.length, 1);
    assert.equal(fake.count('/cards/collection'), 2);
  });
  test('server errors are reported', async () => {
    fake.state.failNext = 1;
    await assert.rejects(resolveEntries([entry({ name: 'Counterspell' })]), /Scryfall error 500/);
  });
});

describe('prices', () => {
  test('refreshCards returns fresh, trimmed card data by id', async () => {
    fake.state.priceBump = 1;
    const bolt = byName('Lightning Bolt');
    const fresh = await refreshCards([bolt.id]);
    assert.equal(fresh.get(bolt.id).prices.usd, (Number(bolt.prices.usd) + 1).toFixed(2));
  });
  test('pricesPublishedAt reads when Scryfall last published its daily data', async () => {
    fake.state.publishedAt = Date.parse('2026-11-05T22:06:50Z');
    assert.equal(await pricesPublishedAt(), Date.parse('2026-11-05T22:06:50Z'));
    assert.equal(fake.count('/bulk-data/default-cards'), 1);
  });
  test('pricesPublishedAt fails cleanly when Scryfall is down', async () => {
    fake.state.failNext = 1;
    await assert.rejects(pricesPublishedAt(), /Scryfall error 500/);
  });
});

test('trimCard keeps only the fields the app uses, including card faces', () => {
  const raw = { ...byName('Delver of Secrets'), extra_field: 'x', image_uris: { small: 's', normal: 'n', large: 'l', art_crop: 'a', png: 'p' } };
  const t = trimCard(raw);
  assert.equal(t.extra_field, undefined);
  assert.deepEqual(t.image_uris, { small: 's', normal: 'n', large: 'l', art_crop: 'a' });
  assert.equal(t.card_faces.length, 2);
  assert.equal(t.cmc, raw.cmc);
  assert.equal(trimCard({ id: 'x', name: 'y' }).cmc, 0, 'missing mana value defaults to 0');
});
