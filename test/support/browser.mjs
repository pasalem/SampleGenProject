// Dependency-free headless browser driver for the end-to-end tests.
// Launches Chrome, Chromium or Edge, talks to it over the DevTools protocol, and answers all
// requests to Scryfall, its image hosts and GitHub from in-memory fakes, so tests never touch
// the real services. Set CHROME_PATH to choose the browser.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  }[process.platform];
  if (candidates) return candidates.find((p) => existsSync(p)) || null;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* not installed */ }
  }
  return null;
}

const IMAGE = readFileSync(new URL('../../public/icons/icon-192.png', import.meta.url));
const CORS = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PATCH, OPTIONS' },
  { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type, Accept, X-GitHub-Api-Version' },
];

export async function launch({ appOrigin, scryfall, github, width = 1280, height = 900 }) {
  const exe = findBrowser();
  if (!exe) throw new Error('No Chrome, Chromium or Edge found. Install one or set CHROME_PATH.');
  const profile = mkdtempSync(path.join(tmpdir(), 'mtg-e2e-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--hide-scrollbars', '--mute-audio',
  ];
  if (process.env.CI) args.push('--no-sandbox'); // CI runners restrict the sandbox's user namespaces
  const proc = spawn(exe, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Browser did not start: ${buf.slice(-500)}`)), 30000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Browser exited (${code}): ${buf.slice(-500)}`)); });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id != null) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p) msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      return;
    }
    for (const l of listeners) l(msg);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const b = {
    send, ws, proc, profile,
    offline: false,
    errors: [],        // uncaught page exceptions
    console: [],       // console messages
    dialogs: [],       // alert/confirm messages, in order
    dialogAnswers: [], // queued answers for confirm() (default: accept)
    downloads: new Map(),
    page: null,        // page session id
  };

  async function onRequest(sessionId, { requestId, request }) {
    const url = new URL(request.url);
    const reply = (status, body, type = 'application/json') => send('Fetch.fulfillRequest', {
      requestId, responseCode: status,
      responseHeaders: [...CORS, { name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }],
      body: Buffer.from(body).toString('base64'),
    }, sessionId).catch(() => {});
    const fail = () => send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }, sessionId).catch(() => {});

    if (url.origin === appOrigin) return b.offline ? fail() : send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
    if (b.offline) return fail();
    if (request.method === 'OPTIONS') return reply(204, '', 'text/plain');
    let body = request.postData;
    if (request.hasPostData && body == null && request.postDataEntries) {
      body = Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes || '', 'base64'))).toString('utf8');
    }
    if (url.hostname === 'api.scryfall.com') {
      const r = scryfall.handle(request.url, request.method, body);
      return reply(r.status, JSON.stringify(r.json));
    }
    if (url.hostname === 'api.github.com' || url.hostname === 'gist.githubusercontent.com') {
      const r = github.handle(request.url, request.method, body, request.headers);
      return r.text != null ? reply(r.status, r.text, 'text/plain') : reply(r.status, JSON.stringify(r.json));
    }
    if (url.hostname === 'cards.scryfall.io' || url.hostname === 'svgs.scryfall.io') return reply(200, IMAGE, 'image/png');
    return fail(); // nothing else may reach the network
  }

  listeners.push(async (msg) => {
    const { method, params, sessionId } = msg;
    if (method === 'Target.attachedToTarget') {
      const s = params.sessionId;
      const type = params.targetInfo.type;
      if (['page', 'service_worker', 'worker', 'shared_worker'].includes(type)) {
        await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, s).catch(() => {});
        if (type === 'page' && !b.page) {
          b.page = s;
          await send('Page.enable', {}, s);
          await send('Runtime.enable', {}, s);
          await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, s);
        }
      }
      if (params.waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {});
    } else if (method === 'Fetch.requestPaused') {
      onRequest(sessionId, params);
    } else if (method === 'Runtime.exceptionThrown' && sessionId === b.page) {
      const d = params.exceptionDetails;
      b.errors.push(d.exception?.description || d.text);
    } else if (method === 'Runtime.consoleAPICalled' && sessionId === b.page) {
      b.console.push(`${params.type}: ${params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (method === 'Page.javascriptDialogOpening') {
      b.dialogs.push(params.message);
      const accept = b.dialogAnswers.length ? b.dialogAnswers.shift() : true;
      send('Page.handleJavaScriptDialog', { accept }, sessionId).catch(() => {});
    } else if (method === 'Browser.downloadWillBegin') {
      b.downloads.set(params.guid, { name: params.suggestedFilename, done: false });
    } else if (method === 'Browser.downloadProgress' && params.state === 'completed') {
      const d = b.downloads.get(params.guid);
      if (d) d.done = true;
    }
  });

  b.downloadDir = path.join(profile, 'downloads');
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: b.downloadDir, eventsEnabled: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  for (let i = 0; i < 100 && !b.page; i++) await sleep(50);
  if (!b.page) throw new Error('Could not attach to the browser page');

  // ----- page helpers -----
  b.eval = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true }, b.page);
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`);
    return r.result.value;
  };
  b.waitFor = async (expression, { timeout = 15000, message } = {}) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try { last = await b.eval(`return (${expression})`); if (last) return last; } catch (e) { last = e.message; }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for: ${message || expression} (last: ${JSON.stringify(last)})`);
  };
  b.goto = async (url, { waitReady = true } = {}) => {
    await send('Page.navigate', { url }, b.page);
    if (waitReady) await b.waitFor(`document.readyState === 'complete' && document.body?.dataset.ready === 'true'`, { timeout: 20000, message: 'app ready' });
  };
  b.reload = async ({ settled = true } = {}) => {
    await b.eval('document.body.dataset.ready = ""; document.body.dataset.settled = ""; location.reload(); return 1');
    await b.waitFor(`document.body?.dataset.ready === 'true'`, { timeout: 20000, message: 'app ready after reload' });
    if (settled) await b.waitFor(`document.body.dataset.settled === 'true'`, { timeout: 20000, message: 'startup finished' });
  };
  b.setFiles = async (selector, files) => {
    const { root } = await send('DOM.getDocument', {}, b.page);
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, b.page);
    await send('DOM.setFileInputFiles', { nodeId, files }, b.page);
  };
  b.download = async (clickExpression) => {
    const before = new Set(b.downloads.keys());
    await b.eval(clickExpression);
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      for (const [guid, d] of b.downloads) {
        if (!before.has(guid) && d.done) return { name: d.name, text: readFileSync(path.join(b.downloadDir, guid), 'utf8') };
      }
      await sleep(50);
    }
    throw new Error('Download did not complete');
  };
  b.setViewport = (w, h, mobile = false) =>
    send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }, b.page);
  b.clearSiteData = (storageTypes = 'indexeddb,local_storage') =>
    send('Storage.clearDataForOrigin', { origin: appOrigin, storageTypes }, b.page);
  b.close = async () => {
    try { await send('Browser.close'); } catch { /* already closed */ }
    ws.close();
    await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5000)]);
    if (proc.exitCode == null) proc.kill();
    for (let i = 0; i < 5; i++) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } // Windows may still hold files briefly
    }
  };
  return b;
}
