// Collection value over time: one point per day, kept in localStorage, drawn as an SVG line chart.
import { money, esc } from './render.js';

const KEY = 'mtg.history';
const MAX_POINTS = 2000;

export function loadHistory() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Record today's value; a later call on the same day replaces that day's point.
export function recordValue(value, cards, now = Date.now()) {
  const points = loadHistory();
  const day = dayOf(now);
  const point = { day, t: now, value: Math.round(value * 100) / 100, cards };
  if (points.length && points[points.length - 1].day === day) points[points.length - 1] = point;
  else points.push(point);
  try { localStorage.setItem(KEY, JSON.stringify(points.slice(-MAX_POINTS))); } catch { /* storage full or blocked */ }
  return points;
}

const W = 640, H = 240, PAD = { l: 64, r: 16, t: 16, b: 28 };
const fmtDay = (day) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = lo; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

// Returns chart markup; call bindChart() on the inserted container to enable hover.
export function chartHTML(points) {
  if (!points.length) {
    return '<p class="muted">No history yet. A point is recorded each day the app updates your prices.</p>';
  }
  const ticks = niceTicks(Math.min(...points.map((p) => p.value)), Math.max(...points.map((p) => p.value)));
  const yMin = ticks[0], yMax = ticks[ticks.length - 1];
  const x = (i) => (points.length === 1 ? (PAD.l + W - PAD.r) / 2 : PAD.l + (i * (W - PAD.l - PAD.r)) / (points.length - 1));
  const y = (v) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const xLabels = points.length === 1 ? [0] : [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const first = points[0], last = points[points.length - 1];
  const change = last.value - first.value;

  return `
    <div class="hist-summary">
      <span class="hist-now">${money(last.value)}</span>
      ${points.length > 1 ? `<span class="muted">${change >= 0 ? '▲' : '▼'} ${money(Math.abs(change))} since ${esc(fmtDay(first.day))}</span>` : ''}
    </div>
    <div class="chart" data-points='${esc(JSON.stringify(points.map((p, i) => [x(i), y(p.value), p.day, p.value, p.cards])))}'>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Collection value over time">
        ${ticks.map((t) => `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="axis" x="${PAD.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(money(t).replace(/\.00$/, ''))}</text>`).join('')}
        ${xLabels.map((i) => `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="${points.length === 1 ? 'middle' : i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${esc(fmtDay(points[i].day))}</text>`).join('')}
        <path class="line" d="${path}"/>
        ${points.length === 1 ? `<circle class="dot" cx="${x(0)}" cy="${y(first.value)}" r="5"/>` : ''}
        <line class="cross" y1="${PAD.t}" y2="${H - PAD.b}" hidden/>
        <circle class="hover-dot" r="5" hidden/>
        <rect class="hit" x="${PAD.l}" y="0" width="${W - PAD.l - PAD.r}" height="${H}"/>
      </svg>
      <div class="chart-tip" hidden></div>
    </div>
    ${points.length === 1 ? '<p class="muted">Only one day recorded so far. The line fills in as you use the app on more days.</p>' : ''}
    <details class="hist-table">
      <summary>Show as table</summary>
      <table><thead><tr><th>Date</th><th>Value</th><th>Cards</th></tr></thead><tbody>
        ${points.slice().reverse().map((p) => `<tr><td>${esc(fmtDay(p.day))}</td><td>${money(p.value)}</td><td>${Number(p.cards || 0).toLocaleString()}</td></tr>`).join('')}
      </tbody></table>
    </details>`;
}

// Crosshair + tooltip that snaps to the nearest day.
export function bindChart(root) {
  const chart = root.querySelector('.chart');
  if (!chart) return;
  const pts = JSON.parse(chart.dataset.points);
  const svg = chart.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.hover-dot');
  const tip = chart.querySelector('.chart-tip');
  const hide = () => { cross.setAttribute('hidden', ''); dot.setAttribute('hidden', ''); tip.hidden = true; };

  svg.querySelector('.hit').addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - sx) < Math.abs(best[0] - sx)) best = p;
    const [px, py, day, value, cards] = best;
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.removeAttribute('hidden');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.removeAttribute('hidden');
    tip.innerHTML = `<b>${money(value)}</b><span>${esc(fmtDay(day))} · ${Number(cards || 0).toLocaleString()} cards</span>`;
    tip.hidden = false;
    const left = (px / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
    tip.style.top = `${(py / H) * box.height}px`;
  });
  svg.querySelector('.hit').addEventListener('pointerleave', hide);
}
