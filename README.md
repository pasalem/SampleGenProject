# MTG Collection

**Live site:** <https://pasalem.github.io/SampleGenProject/>

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
- Filters for color, type, rarity and set, plus **More filters** for format legality, mana value range and price range. Sort by name, price, total value, mana value, rarity, set, quantity or date added.
- Click a card to see a large image, flavor text, all prices, format legality and a Scryfall link. You can also change the quantity, finish, condition and language, or remove the card there.
- Double-faced cards have a flip button.
- A size slider (or Ctrl + mouse wheel over the cards) shrinks the art so more card text fits on screen, and the **Art** button hides or shows card images.
- Collection totals: unique cards, total cards and estimated USD value. Scryfall publishes new prices once a day, and the app downloads them shortly after it does: when you open the page, about once an hour while it's open, and when you come back to the tab, it makes one small request to check whether Scryfall has published since your last update. The top bar shows when prices were last updated. **Refresh prices** updates them on demand.
- Click the collection value to see a chart of its value over time (one point per day you use the app).
- **Sync** keeps your collection the same across devices, using a private gist in your own GitHub account (see below).
- Works offline and can be installed as an app from the browser's address bar. Card images are cached after the first view.
- **Export CSV** and **Backup** (JSON) let you save your collection to a file.

## Where your data lives

Your collection is stored in your browser's IndexedDB for the site you open it from (`localhost:8080` or the GitHub Pages address), so each browser and each address has its own copy. If you clear that site's data in the browser, the collection is gone, so use **Backup** now and then, or turn on Sync.

### Sync between devices

Click **Sync**, then create a GitHub token with only the **gist** scope (the dialog links to the right page) and paste it in. The app stores your collection in a secret gist in your account. Do the same on each device with the same GitHub account. Changes upload a few seconds after you make them, and other devices pick them up when they load the page or you switch back to the tab. If a collection changed on both sides, the app asks which copy to keep.

Only the card IDs, finishes, quantities, conditions, languages and dates added are synced; card details and prices come from Scryfall. The token is kept in your browser's local storage. Any page on the same address could read it, so give it the gist scope only, and revoke it on GitHub if you stop using sync.

## Project layout

```
server.js            static file server (Node, no dependencies)
start.bat            Windows launcher
public/index.html    page markup
public/sw.js         service worker (offline support, image cache)
public/manifest.webmanifest, public/icons/   install-as-app metadata and icons
public/css/          styles
public/js/app.js     UI wiring: list, dialogs, import/export, price refresh, sync
public/js/collection.js  filtering, sorting, merging, totals, price schedule (no DOM)
public/js/history.js   collection value history and chart
public/js/sync.js    GitHub Gist sync
public/js/importer.js  CSV / text list parsing
public/js/scryfall.js  Scryfall lookups (batched, rate-limited)
public/js/render.js  card HTML, mana symbols
public/js/db.js      IndexedDB storage
test/                unit tests, one file per module
test/e2e/            browser tests that drive the whole app
test/support/        fake Scryfall and GitHub, headless browser driver
test/fixtures/       card data used by the tests (rebuild with make-fixtures.mjs)
```

## Tests

```
npm test            # everything
npm run test:unit   # module tests (about 3 seconds)
npm run test:e2e    # browser tests (about 20 seconds)
```

The tests need Node 22 or newer and no packages. The browser tests run the real app in headless Chrome, Chromium or Edge (whichever is installed; set `CHROME_PATH` to choose). Scryfall, card images and GitHub are simulated, so the tests work offline and never touch your data. GitHub Actions runs all tests on every push, and only deploys the site if they pass.
