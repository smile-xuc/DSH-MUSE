/**
 * dsh-session-pins host-side tests: RPC handler behavior + JSON persistence.
 * Uses a mock cordis ctx (captures the channel handler) and a temp DSH_HOME
 * so the real store file is never touched. Run: node --test test/pins.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = mkdtempSync(join(tmpdir(), 'dsh-session-pins-test-'));
const { apply } = await import('../lib/index.js');

/* storePath() is read at apply() time, so each test gets its own DSH_HOME. */
let homeSeq = 0;

/** Capture the registered handler; return a call(endpoint, payload) shim. */
function boot() {
  process.env.DSH_HOME = join(BASE, `home-${homeSeq++}`);
  let handler = null;
  const ctx = {
    logger: () => ({ debug() {}, warn() {} }),
    connection: { rpc: { handle(_channel, fn) { handler = fn; } } },
  };
  apply(ctx);
  assert.notEqual(handler, null);
  const call = (endpoint, payload) => handler(endpoint, payload);
  call.storeFile = join(process.env.DSH_HOME, 'storages', 'session-pins.json');
  return call;
}

test('pin then list round-trips, prepending newest on top', async () => {
  const call = boot();
  let r = await call('list');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.pins, []);

  r = await call('pin', { sessionId: 'session-a', title: 'Alpha' });
  assert.equal(r.ok, true);
  r = await call('pin', { sessionId: 'session-b', title: 'Beta' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.pins.map((p) => p.sessionId), ['session-b', 'session-a']);
  assert.equal(r.value.pins[0].title, 'Beta');
  assert.equal(typeof r.value.pins[0].pinnedAt, 'number');
});

test('store persists to disk and survives a reload', async () => {
  const call = boot();
  await call('pin', { sessionId: 'session-c', title: 'Gamma' });
  assert.equal(existsSync(call.storeFile), true);
  const onDisk = JSON.parse(readFileSync(call.storeFile, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.pins.map((p) => p.sessionId), ['session-c']);
  /* lossless: every field always present (DSH 0.1.2 transport discipline) */
  assert.deepEqual(Object.keys(onDisk.pins[0]).sort(), ['pinnedAt', 'sessionId', 'title']);
});

test('re-pin is idempotent and refreshes the title without moving position', async () => {
  const call = boot();
  await call('pin', { sessionId: 'session-1', title: 'Old' });
  await call('pin', { sessionId: 'session-2', title: 'Two' });
  const r = await call('pin', { sessionId: 'session-1', title: 'New title' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.pins.map((p) => p.sessionId), ['session-2', 'session-1']);
  assert.equal(r.value.pins[1].title, 'New title');
});

test('unpin removes only the target', async () => {
  const call = boot();
  await call('pin', { sessionId: 'session-x', title: 'X' });
  await call('pin', { sessionId: 'session-y', title: 'Y' });
  const r = await call('unpin', { sessionId: 'session-x' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.pins.map((p) => p.sessionId), ['session-y']);
});

test('bad payloads are rejected without touching the store', async () => {
  const call = boot();
  await call('pin', { sessionId: 'session-kept', title: 'Kept' });
  const before = readFileSync(call.storeFile, 'utf8');
  assert.equal((await call('pin', { title: 'no id' })).ok, false);
  assert.equal((await call('pin', { sessionId: '  ' })).ok, false);
  assert.equal((await call('unpin', {})).ok, false);
  assert.equal((await call('nope', {})).ok, false);
  assert.equal(readFileSync(call.storeFile, 'utf8'), before);
});

test('a corrupt store file degrades to an empty list instead of crashing', async () => {
  const home = join(BASE, `home-${homeSeq++}`);
  process.env.DSH_HOME = home;
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'session-pins.json'), '{not json', 'utf8');
  let handler = null;
  apply({ logger: () => ({ debug() {}, warn() {} }), connection: { rpc: { handle(_c, fn) { handler = fn; } } } });
  const r = await handler('list');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.pins, []);
});
