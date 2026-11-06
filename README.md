# MTG Collection

A locally hosted website for browsing your Magic: The Gathering collection. Import your cards, and it shows each one's art, rules text, set, rarity, artist, price and format legality in a searchable, scrolling list. Card data and images come from the free [Scryfall](https://scryfall.com) API.

## Running it

**Option 1:** Double-click `start.bat`.

**Option 2:** From a terminal in this folder:

```
node server.js
```

The site opens in Firefox at <http://localhost:8080>. If Firefox isn't installed, it uses your default browser instead; to pick a different browser, set the `BROWSER` environment variable to that browser's .exe path. Press Ctrl+C in the terminal to stop the server. You don't need to run `npm install`, because the app has no dependencies. It needs [Node.js](https://nodejs.org). If Node isn't installed, `start.bat` falls back to Python, but Python's server can send `.js` files with the wrong type on some Windows setups, so Node is the reliable choice.

## Importing

Click **Import**, then pick a file or paste a list. Supported formats:

- **CSV exports** from Moxfield, ManaBox, Deckbox, Archidekt, TCGplayer, Dragon Shield and similar apps. The app uses the quantity, name, set code, collector number, foil, condition and language columns when they're present. When a file has a Scryfall ID column, the app matches the exact printing.
- **Text lists**: `4 Lightning Bolt`, `1 Sol Ring (CMR) 472`, `1 Ragavan, Nimble Pilferer (MH2) 138 *F*` (`*F*` means foil and `*E*` means etched).
- **JSON backups** made with the **Backup** button.

If the app can't find the exact printing, it falls back to the card's name. Lines that still don't match are listed after the import. To try it out, import `samples/sample-collection.txt`.

You can also drag a file onto any part of the page: it imports straight away. The import window closes by itself when the import succeeds, unless some lines couldn't be matched, in which case it stays open to list them.

## Features

- A list view (art beside full card text) and a grid view (art only). The page loads more cards as you scroll, so large collections stay fast.
- Search across names, types, rules text, artist and set. Press `/` to jump to the search box.
- Filters for color, type, rarity and set. Sort by name, price, total value, mana value, rarity, set, quantity or date added.
- Click a card to see a large image, flavor text, all prices, format legality and a Scryfall link. You can also change the quantity or remove the card there.
- Double-faced cards have a flip button.
- A size slider (or Ctrl + mouse wheel over the cards) shrinks the art so more card text fits on screen, and the **Art** button hides or shows card images.
- Collection totals: unique cards, total cards and estimated USD value. **Refresh prices** gets current prices from Scryfall.
- **Export CSV** and **Backup** (JSON) let you save your collection to a file.

## Where your data lives

Your collection is stored in your browser's IndexedDB for `localhost:8080`, so it stays on your computer. If you clear that site's data in the browser, or switch browsers or ports, the collection won't be there. Use **Backup** now and then to keep a copy.

## Project layout

```
server.js            static file server (Node, no dependencies)
start.bat            Windows launcher
public/index.html    page markup
public/css/          styles
public/js/app.js     UI state, filters, import/export
public/js/importer.js  CSV / text list parsing
public/js/scryfall.js  Scryfall lookups (batched, rate-limited)
public/js/render.js  card HTML, mana symbols
public/js/db.js      IndexedDB storage
```
