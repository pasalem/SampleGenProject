// GitHub Gist sync: decisions, connecting, uploading, downloading and errors.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub, installFetch, installLocalStorage, SYNC_FILE } from './support/fakes.mjs';
import * as sync from '../public/js/sync.js';

const { decide, slim } = sync;

describe('decide', () => {
  test('nothing changed anywhere', () => assert.equal(decide(100, 100, false), 'none'));
  test('only this device changed: upload', () => assert.equal(decide(100, 100, true), 'push'));
  test('only the cloud changed: download', () => assert.equal(decide(200, 100, false), 'pull'));
  test('both changed: ask the user', () => assert.equal(decide(200, 100, true), 'conflict'));
  test('first connect to an empty new gist uploads local cards', () => assert.equal(decide(0, 0, true), 'push'));
  test('first connect on a device with no cards downloads the cloud copy', () => assert.equal(decide(500, 0, false), 'pull'));
});

test('slim keeps only what identifies each card', () => {
  const items = [{ key: 'x|foil', card: { id: 'x', name: 'Opt', prices: { usd: '1' } }, qty: 2, finish: 'foil', condition: 'Near Mint', added: 5 }];
  assert.deepEqual(slim(items), [{ id: 'x', finish: 'foil', qty: 2, condition: 'Near Mint', language: '', added: 5 }]);
});

describe('with GitHub', () => {
  let gh, restore, storage;
  const item = (id, qty = 1) => ({ key: `${id}|nonfoil`, card: { id }, qty, finish: 'nonfoil', condition: '', language: '', added: 1 });
  beforeEach(() => {
    storage = installLocalStorage();
    gh = createFakeGitHub();
    restore = installFetch({ github: gh });
  });
  afterEach(() => restore());

  test('starts disconnected', () => {
    assert.equal(sync.isConnected(), false);
    assert.equal(sync.account(), '');
    assert.equal(sync.gistUrl(), '');
  });

  test('a rejected token gives a clear error and stays disconnected', async () => {
    await assert.rejects(sync.connect('wrong', false), /rejected the token/);
    assert.equal(sync.isConnected(), false);
  });

  test('connect creates a secret gist when none exists', async () => {
    await sync.connect('test-token', true);
    assert.equal(sync.isConnected(), true);
    assert.equal(sync.account(), 'tester');
    const g = [...gh.state.gists.values()][0];
    assert.equal(g.public, false);
    assert.match(sync.gistUrl(), new RegExp(`gist.github.com/${g.id}$`));
    assert.deepEqual(gh.cloud(), { version: 1, updated: 0, items: [] });
  });

  test('connect finds an existing sync gist instead of creating another', async () => {
    gh.addGist(null, { 'notes.txt': 'unrelated' });
    const id = gh.addGist({ version: 1, updated: 50, items: [] });
    await sync.connect('test-token', false);
    assert.equal(gh.state.gists.size, 2);
    assert.match(sync.gistUrl(), new RegExp(`${id}$`));
  });

  test('connect looks past the first page of gists', async () => {
    for (let i = 0; i < 100; i++) gh.addGist(null, { [`other${i}.txt`]: 'x' });
    const id = gh.addGist({ version: 1, updated: 50, items: [] });
    await sync.connect('test-token', false);
    assert.match(sync.gistUrl(), new RegExp(`${id}$`));
  });

  test('first sync: upload when this device has cards', async () => {
    await sync.connect('test-token', true);
    assert.equal((await sync.check()).action, 'push');
    await sync.push([item('a', 2)]);
    assert.equal(gh.cloud().items[0].qty, 2);
    assert.ok(gh.cloud().updated > 0);
    assert.equal((await sync.check()).action, 'none', 'in sync after pushing');
  });

  test('first sync: download when this device is empty and the cloud has cards', async () => {
    gh.addGist({ version: 1, updated: 50, items: slim([item('a')]) });
    await sync.connect('test-token', false);
    const { action, remote } = await sync.check();
    assert.equal(action, 'pull');
    assert.equal(remote.items.length, 1);
    sync.accept(remote);
    assert.equal((await sync.check()).action, 'none');
  });

  test('local edits are marked and uploaded; remote edits are detected', async () => {
    await sync.connect('test-token', false);
    sync.markChanged();
    assert.equal((await sync.check()).action, 'push');
    await sync.push([item('a')]);
    gh.setCloud({ ...gh.cloud(), updated: gh.cloud().updated + 1000, items: [] });
    assert.equal((await sync.check()).action, 'pull');
    sync.markChanged();
    assert.equal((await sync.check()).action, 'conflict');
  });

  test('large collections (truncated by the API) are read from the raw file', async () => {
    gh.addGist({ version: 1, updated: 50, items: slim([item('a'), item('b')]) });
    await sync.connect('test-token', false);
    gh.state.truncate = true;
    const { remote } = await sync.check();
    assert.equal(remote.items.length, 2);
  });

  test('a gist missing the sync file reads as empty', async () => {
    await sync.connect('test-token', false);
    delete [...gh.state.gists.values()][0].files[SYNC_FILE];
    assert.deepEqual((await sync.check()).remote, { version: 1, updated: 0, items: [] });
  });

  test('markChanged does nothing while disconnected', () => {
    sync.markChanged();
    assert.equal(storage.get('mtg.sync.dirty'), undefined);
  });

  test('disconnect forgets the token and gist on this device', async () => {
    await sync.connect('test-token', true);
    sync.disconnect();
    assert.equal(sync.isConnected(), false);
    assert.equal([...storage.keys()].filter((k) => k.startsWith('mtg.sync')).length, 0);
  });

  test('a revoked token and missing gist permission give clear errors', async () => {
    await sync.connect('test-token', true);
    gh.state.token = 'rotated';
    await assert.rejects(sync.check(), /rejected the token/);
    gh.state.token = 'test-token';
    gh.state.gists.clear();
    await assert.rejects(sync.check(), /gist/);
  });
});
