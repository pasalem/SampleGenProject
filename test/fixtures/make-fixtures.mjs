// Rebuilds test/fixtures/cards.json from Scryfall: the cards in samples/sample-collection.txt
// plus 70 Modern Horizons 2 cards (enough for more than one page of list rows).
// Usage: node test/fixtures/make-fixtures.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { parseInput } from '../../public/js/importer.js';
import { trimCard } from '../../public/js/scryfall.js';

const headers = { 'User-Agent': 'mtg-collection-tests/1.0', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sample = parseInput(readFileSync(new URL('../../samples/sample-collection.txt', import.meta.url), 'utf8')).entries;
const identifiers = sample.map((e) => (e.set && e.cn ? { set: e.set, collector_number: e.cn } : { name: e.name.split(' // ')[0] }));
const res = await (await fetch('https://api.scryfall.com/cards/collection', {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers }),
})).json();
if (res.not_found?.length) throw new Error(`not found: ${JSON.stringify(res.not_found)}`);
await sleep(200);

const search = await (await fetch('https://api.scryfall.com/cards/search?q=set:mh2+is:booster&order=set', { headers })).json();
const cards = [...res.data, ...search.data.slice(0, 70)];
const unique = [...new Map(cards.map((c) => [c.id, trimCard(c)])).values()];
writeFileSync(new URL('./cards.json', import.meta.url), `${JSON.stringify(unique, null, 0)}\n`);
console.log(`wrote ${unique.length} cards`);
