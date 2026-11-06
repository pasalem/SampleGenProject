// Collection value history: daily points and the chart markup.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './support/fakes.mjs';
import { loadHistory, recordValue, chartHTML } from '../public/js/history.js';

let storage;
beforeEach(() => { storage = installLocalStorage(); });

const at = (day, hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).getTime();

describe('recording', () => {
  test('starts empty, and survives corrupt storage', () => {
    assert.deepEqual(loadHistory(), []);
    storage.set('mtg.history', 'not json');
    assert.deepEqual(loadHistory(), []);
    storage.set('mtg.history', '{"a":1}');
    assert.deepEqual(loadHistory(), []);
  });
  test('one point per day: a later value replaces the same day', () => {
    recordValue(10, 5, at('2026-11-01', 9));
    recordValue(12.345, 6, at('2026-11-01', 18));
    recordValue(15, 7, at('2026-11-02'));
    const h = loadHistory();
    assert.equal(h.length, 2);
    assert.deepEqual([h[0].day, h[0].value, h[0].cards], ['2026-11-01', 12.35, 6]);
    assert.equal(h[1].day, '2026-11-02');
  });
  test('keeps at most 2000 points', () => {
    const start = at('2020-01-01');
    for (let i = 0; i < 2005; i++) recordValue(i, 1, start + i * 86_400_000);
    const h = loadHistory();
    assert.equal(h.length, 2000);
    assert.equal(h[h.length - 1].value, 2004);
  });
  test('storage errors are ignored', () => {
    globalThis.localStorage.setItem = () => { throw new Error('full'); };
    assert.doesNotThrow(() => recordValue(1, 1));
  });
});

describe('chart', () => {
  test('no history: explains when points are recorded', () => {
    assert.match(chartHTML([]), /No history yet/);
  });
  test('one point: a dot and a note that the line fills in', () => {
    const html = chartHTML([{ day: '2026-11-01', value: 100, cards: 3 }]);
    assert.match(html, /<circle class="dot"/);
    assert.match(html, /Only one day recorded/);
    assert.match(html, /\$100\.00/);
  });
  test('several points: a line, the change since the first day, axis labels and a table', () => {
    const points = [
      { day: '2026-11-01', value: 100, cards: 3 },
      { day: '2026-11-02', value: 80, cards: 3 },
      { day: '2026-11-03', value: 150.5, cards: 4 },
    ];
    const html = chartHTML(points);
    const d = html.match(/<path class="line" d="([^"]+)"/)[1];
    assert.equal((d.match(/[ML]/g) || []).length, 3);
    assert.match(html, /▲ \$50\.50 since/);
    assert.match(html, /class="axis"[^>]*>\$\d/);
    assert.equal((html.match(/<tr><td>/g) || []).length, 3);
    assert.ok(html.indexOf('$150.50</td>') < html.indexOf('$100.00</td>'), 'table lists newest first');
    assert.doesNotMatch(html, /Only one day recorded/);
  });
  test('a falling value shows a down arrow', () => {
    const html = chartHTML([{ day: '2026-11-01', value: 100, cards: 1 }, { day: '2026-11-02', value: 90, cards: 1 }]);
    assert.match(html, /▼ \$10\.00 since/);
  });
  test('y axis covers every value', () => {
    const html = chartHTML([{ day: '2026-11-01', value: 3, cards: 1 }, { day: '2026-11-02', value: 997, cards: 1 }]);
    const ticks = [...html.matchAll(/text-anchor="end">\$([\d,.]+)</g)].map((m) => Number(m[1].replace(/,/g, '')));
    assert.ok(Math.min(...ticks) <= 3 && Math.max(...ticks) >= 997, ticks.join(','));
  });
});
