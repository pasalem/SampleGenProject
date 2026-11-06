// HTML rendering helpers for card rows and the detail view.
const SYMBOL_URL = 'https://svgs.scryfall.io/card-symbols/';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Replace {W}, {2/U}, {T} etc. with Scryfall's SVG mana symbols.
export function symbols(text) {
  return esc(text).replace(/\{([^}]+)\}/g, (_, s) => {
    const file = encodeURIComponent(s.replace(/\//g, '').toUpperCase());
    return `<img class="ms" src="${SYMBOL_URL}${file}.svg" alt="{${esc(s)}}" title="{${esc(s)}}">`;
  });
}

export function oracle(text) {
  return symbols(text).replace(/\([^)]*\)/g, (m) => `<i>${m}</i>`).replace(/\n/g, '<br>');
}

export function faces(card) {
  if (card.card_faces?.length) return card.card_faces;
  return [card];
}

export function imageOf(card, face = 0, size = 'normal') {
  return card.card_faces?.[face]?.image_uris?.[size] || card.image_uris?.[size] || card.card_faces?.[0]?.image_uris?.[size] || '';
}

export const hasBackImage = (card) => Boolean(card.card_faces?.[1]?.image_uris);

export function colorsOf(card) {
  if (card.colors) return card.colors;
  const set = new Set();
  (card.card_faces || []).forEach((f) => (f.colors || []).forEach((c) => set.add(c)));
  return [...set];
}

export function priceOf(item) {
  const p = item.card.prices || {};
  const byFinish = item.finish === 'etched' ? p.usd_etched : item.finish === 'foil' ? p.usd_foil : p.usd;
  return parseFloat(byFinish ?? p.usd ?? p.usd_foil ?? p.usd_etched) || 0;
}

export const money = (n) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const FINISH_LABEL = { foil: 'Foil', etched: 'Etched foil', nonfoil: '' };

function stats(f) {
  if (f.power != null && f.toughness != null) return `${esc(f.power)}/${esc(f.toughness)}`;
  if (f.loyalty != null) return `Loyalty ${esc(f.loyalty)}`;
  if (f.defense != null) return `Defense ${esc(f.defense)}`;
  return '';
}

function faceHTML(f, withFlavor) {
  const st = stats(f);
  return `
    <div class="face">
      <h3><span class="name">${esc(f.name)}</span><span class="cost">${symbols(f.mana_cost || '')}</span></h3>
      <div class="type">${esc(f.type_line || '')}</div>
      ${f.oracle_text ? `<div class="oracle">${oracle(f.oracle_text)}</div>` : ''}
      ${withFlavor && f.flavor_text ? `<div class="flavor">${esc(f.flavor_text).replace(/\n/g, '<br>')}</div>` : ''}
      ${st ? `<div class="pt">${st}</div>` : ''}
    </div>`;
}

export function rowHTML(item) {
  const c = item.card;
  const price = priceOf(item);
  return `
  <article class="card-row" data-key="${esc(item.key)}" tabindex="0">
    <div class="art">
      <img src="${esc(imageOf(c))}" alt="${esc(c.name)}" loading="lazy" decoding="async">
      ${item.qty > 1 ? `<span class="qty-badge">×${item.qty}</span>` : ''}
      ${item.finish !== 'nonfoil' ? '<span class="foil-badge">✦</span>' : ''}
      ${hasBackImage(c) ? '<button class="flip" title="Flip card" aria-label="Flip card">⟲</button>' : ''}
    </div>
    <div class="info">
      ${faces(c).map((f) => faceHTML(f, false)).join('<hr>')}
      <div class="meta">
        <span class="rarity r-${esc(c.rarity)}">${esc(cap(c.rarity))}</span>
        <span>${esc(c.set_name)} <span class="muted">(${esc((c.set || '').toUpperCase())}) #${esc(c.collector_number)}</span></span>
        ${c.artist ? `<span class="muted">🖌 ${esc(c.artist)}</span>` : ''}
        ${item.finish !== 'nonfoil' ? `<span class="finish">${FINISH_LABEL[item.finish]}</span>` : ''}
        <span class="spacer"></span>
        <span class="qty">Qty ${item.qty}</span>
        <span class="price">${price ? money(price) : '—'}</span>
      </div>
    </div>
    <div class="grid-caption"><span class="name">${esc(c.name)}</span><span class="price">${price ? money(price) : ''}</span></div>
  </article>`;
}

const FORMATS = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper', 'historic', 'brawl', 'oathbreaker'];

export function detailHTML(item) {
  const c = item.card;
  const p = c.prices || {};
  const each = priceOf(item);
  const priceRows = [
    ['USD', p.usd], ['USD foil', p.usd_foil], ['USD etched', p.usd_etched], ['EUR', p.eur], ['EUR foil', p.eur_foil], ['MTGO tix', p.tix],
  ].filter(([, v]) => v != null);
  const legal = c.legalities || {};
  return `
  <div class="detail">
    <div class="detail-art">
      <img src="${esc(imageOf(c, 0, 'large'))}" alt="${esc(c.name)}" data-key="${esc(item.key)}">
      ${hasBackImage(c) ? '<button class="flip big" data-act="flip">⟲ Flip</button>' : ''}
    </div>
    <div class="detail-info">
      ${faces(c).map((f) => faceHTML(f, true)).join('<hr>')}
      <table class="facts">
        <tr><th>Set</th><td>${esc(c.set_name)} (${esc((c.set || '').toUpperCase())}) #${esc(c.collector_number)}</td></tr>
        <tr><th>Rarity</th><td><span class="rarity r-${esc(c.rarity)}">${esc(cap(c.rarity))}</span></td></tr>
        ${c.artist ? `<tr><th>Artist</th><td>${esc(c.artist)}</td></tr>` : ''}
        ${c.released_at ? `<tr><th>Released</th><td>${esc(c.released_at)}</td></tr>` : ''}
        <tr><th>Mana value</th><td>${esc(c.cmc)}</td></tr>
        ${c.color_identity ? `<tr><th>Color identity</th><td>${c.color_identity.length ? symbols(c.color_identity.map((x) => `{${x}}`).join('')) : 'Colorless'}</td></tr>` : ''}
        ${c.edhrec_rank ? `<tr><th>EDHREC rank</th><td>#${esc(c.edhrec_rank)}</td></tr>` : ''}
        <tr><th>Finish</th><td>${esc(FINISH_LABEL[item.finish] || 'Non-foil')}</td></tr>
        ${item.condition ? `<tr><th>Condition</th><td>${esc(item.condition)}</td></tr>` : ''}
        ${item.language ? `<tr><th>Language</th><td>${esc(item.language)}</td></tr>` : ''}
        <tr><th>Value</th><td>${each ? `${money(each)} each · <b>${money(each * item.qty)}</b> total` : 'No price data'}</td></tr>
      </table>
      <div class="qty-controls">
        <span>Quantity</span>
        <button data-act="dec" aria-label="Decrease">−</button>
        <b>${item.qty}</b>
        <button data-act="inc" aria-label="Increase">+</button>
        <button data-act="remove" class="danger">Remove</button>
      </div>
      ${priceRows.length ? `<h4>Prices</h4><div class="chips">${priceRows.map(([k, v]) => `<span class="chip">${k}: ${esc(v)}</span>`).join('')}</div>` : ''}
      <h4>Legality</h4>
      <div class="legal">
        ${FORMATS.filter((f) => legal[f]).map((f) => `<span class="lg lg-${esc(legal[f])}">${cap(f)}<small>${esc(legal[f].replace('_', ' '))}</small></span>`).join('')}
      </div>
      ${c.scryfall_uri ? `<p><a href="${esc(c.scryfall_uri)}" target="_blank" rel="noopener">View on Scryfall ↗</a></p>` : ''}
    </div>
  </div>`;
}
