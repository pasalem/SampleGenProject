// Tests for the collection importer: each export format the README promises to support.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInput } from '../public/js/importer.js';

const entriesOf = (text) => {
  const r = parseInput(text);
  assert.equal(r.kind, 'entries');
  return r.entries;
};

test('plain text list with quantities, set codes, collector numbers and finishes', () => {
  const e = entriesOf(`4 Lightning Bolt
1x Sol Ring (CMR) 472
2 Ragavan, Nimble Pilferer (MH2) 138 *F*
1 Esper Sentinel [MH2] 12 *E*
Counterspell`);
  assert.equal(e.length, 5);
  assert.deepEqual(e[0], { qty: 4, name: 'Lightning Bolt', set: '', cn: '', id: '', finish: 'nonfoil', condition: '', language: '' });
  assert.deepEqual([e[1].qty, e[1].name, e[1].set, e[1].cn], [1, 'Sol Ring', 'cmr', '472']);
  assert.deepEqual([e[2].name, e[2].finish], ['Ragavan, Nimble Pilferer', 'foil']);
  assert.deepEqual([e[3].set, e[3].finish], ['mh2', 'etched']);
  assert.deepEqual([e[4].qty, e[4].name], [1, 'Counterspell']);
});

test('text list skips comments, blank lines and deck section headers', () => {
  const e = entriesOf(`Deck
// my comment
# another comment

4 Island
Sideboard:
2 Negate`);
  assert.deepEqual(e.map((x) => x.name), ['Island', 'Negate']);
});

test('the bundled sample collection parses', () => {
  const text = readFileSync(new URL('../samples/sample-collection.txt', import.meta.url), 'utf8');
  const e = entriesOf(text);
  assert.ok(e.length >= 5);
  assert.ok(e.every((x) => x.name && x.qty > 0));
});

test('Moxfield CSV', () => {
  const e = entriesOf(`"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price"
"2","0","Sol Ring","cmr","Near Mint","English","foil","","2024-01-01 00:00:00.000000","472","False","False",""
"1","0","Fire // Ice","mh2","Lightly Played","Japanese","","","2024-01-01 00:00:00.000000","290","False","False",""`);
  assert.equal(e.length, 2);
  assert.deepEqual(e[0], { qty: 2, name: 'Sol Ring', set: 'cmr', cn: '472', id: '', finish: 'foil', condition: 'Near Mint', language: 'English' });
  assert.deepEqual([e[1].name, e[1].finish, e[1].language], ['Fire // Ice', 'nonfoil', 'Japanese']);
});

test('ManaBox CSV uses the Scryfall ID and set code', () => {
  const e = entriesOf(`Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency
Lightning Bolt,2xm,Double Masters,117,normal,uncommon,3,1234,E3285E6B-3E79-4D7C-BF96-D920F973B122,0.5,false,false,near_mint,en,USD
"Ragavan, Nimble Pilferer",mh2,Modern Horizons 2,138,foil,mythic,1,5678,not-a-uuid,50,false,false,near_mint,en,USD`);
  assert.equal(e.length, 2);
  assert.equal(e[0].id, 'e3285e6b-3e79-4d7c-bf96-d920f973b122');
  assert.deepEqual([e[0].qty, e[0].set, e[0].cn, e[0].finish], [3, '2xm', '117', 'nonfoil']);
  assert.equal(e[1].name, 'Ragavan, Nimble Pilferer');
  assert.equal(e[1].id, '', 'an invalid Scryfall ID is ignored');
  assert.equal(e[1].finish, 'foil');
});

test('Deckbox CSV: full set names are not used as set codes', () => {
  const e = entriesOf(`Count,Tradelist Count,Name,Edition,Card Number,Condition,Language,Foil,Signed
1,0,Counterspell,Ice Age,64,Near Mint,English,,
4,0,Island,M21,264,Near Mint,English,foil,`);
  assert.deepEqual([e[0].set, e[0].cn], ['', '64']);
  assert.deepEqual([e[1].set, e[1].finish, e[1].qty], ['m21', 'foil', 4]);
});

test('semicolon and tab separated files, BOM and Excel "sep=" line', () => {
  const semi = entriesOf('﻿sep=;\nQuantity;Name;Set code\n2;Opt;xln');
  assert.deepEqual([semi[0].qty, semi[0].name, semi[0].set], [2, 'Opt', 'xln']);
  const tab = entriesOf('Quantity\tName\n3\tShock');
  assert.deepEqual([tab[0].qty, tab[0].name], [3, 'Shock']);
});

test('quoted fields with commas, escaped quotes and line breaks', () => {
  const e = entriesOf('Quantity,Name,Notes\n1,"Borborygmos, ""the"" Enraged","line one\nline two"\n2,Shock,');
  assert.equal(e.length, 2);
  assert.equal(e[0].name, 'Borborygmos, "the" Enraged');
  assert.equal(e[1].name, 'Shock');
});

test('missing or invalid quantities default to 1', () => {
  const e = entriesOf('Quantity,Name\n,Opt\n0,Shock\nabc,Duress');
  assert.deepEqual(e.map((x) => x.qty), [1, 1, 1]);
});

test('finish values from different apps', () => {
  const e = entriesOf('Name,Foil\nA,true\nB,false\nC,Etched\nD,Non-Foil\nE,yes\nF,');
  assert.deepEqual(e.map((x) => x.finish), ['foil', 'nonfoil', 'etched', 'nonfoil', 'foil', 'nonfoil']);
});

test('JSON backup made by the Backup button', () => {
  const backup = { items: [{ key: 'abc|foil', card: { id: 'abc', name: 'Opt' }, qty: 2, finish: 'foil' }] };
  const r = parseInput(JSON.stringify(backup));
  assert.equal(r.kind, 'backup');
  assert.equal(r.items.length, 1);
});

test('JSON that is not a backup is not treated as one', () => {
  const r = parseInput('[{"foo": 1}]');
  assert.equal(r.kind, 'entries');
});

test('empty input', () => {
  assert.deepEqual(parseInput('   '), { kind: 'entries', entries: [] });
});
