/**
 * dsh-session-pins (host half) — durable session pinning.
 *
 * The stock workspace browser keeps manual session order in browser
 * localStorage, which is keyed by origin — and `dsh web` serves on a random
 * loopback port each launch, so every restart (or the 0.1.2 launcher change)
 * silently abandons the user's ordering. This plugin keeps pins in a
 * host-side JSON store instead: identical from every origin, and shared by
 * the desktop shell and any browser.
 *
 * Store: $DSH_HOME/storages/session-pins.json (default ~/.dsh/storages/),
 * atomically replaced on every mutation (tmp + rename). Shape:
 *   { version: 1, pins: [{ sessionId, title, pinnedAt }] }
 * Pins are ordered: pin prepends (newest on top, chat-app convention);
 * `list` order is display order. Every field is always present and
 * JSON-lossless — DSH 0.1.2 rejects forwarded values that are not.
 *
 * Transport: one loopback-only Connection RPC channel `/session-pins` with
 * endpoints `list` / `pin` / `unpin`. webOnly: the `connection` service
 * exists only in the web assembly; headless profiles must not mount this
 * plugin (a missing inject would keep the entry pending forever).
 *
 * @module dsh-session-pins
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-pins';

/** Hard dependencies: the browser RPC transport (web assembly only). */
export const inject = ['connection'];

/** RPC channel the client bundle calls. Must satisfy Connection's channel pattern. */
const CHANNEL = '/session-pins';

/** Pin entry field bounds (defense in depth; the client already constrains). */
const MAX_TITLE = 200;
const MAX_PINS = 200;

function storePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'storages', 'session-pins.json');
}

/** Read the store; missing/corrupt files degrade to an empty pin list. */
function loadStore(file) {
  try {
    if (!existsSync(file)) return { version: 1, pins: [] };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const pins = Array.isArray(raw?.pins) ? raw.pins : [];
    return {
      version: 1,
      pins: pins
        .filter((p) => p && typeof p.sessionId === 'string' && p.sessionId !== '')
        .map((p) => ({
          sessionId: p.sessionId,
          title: typeof p.title === 'string' ? p.title : '',
          pinnedAt: typeof p.pinnedAt === 'number' && Number.isFinite(p.pinnedAt) ? p.pinnedAt : 0,
        })),
    };
  } catch {
    return { version: 1, pins: [] };
  }
}

/** Atomically replace the store (write tmp, then rename over the target). */
function saveStore(file, store) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function sanitizeTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replaceAll('\0', '').trim().slice(0, MAX_TITLE);
}

function sanitizeSessionId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id === '' ? null : id.slice(0, 100);
}

/** Register the pinning RPC channel. */
export function apply(ctx) {
  const logger = ctx.logger(name);
  const file = storePath();
  /* Single-process host: one in-memory copy is authoritative; every mutation
   * persists before answering so a crash never acknowledges an unsaved pin. */
  let store = loadStore(file);

  ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, payload) => {
      const body = payload ?? {};
      if (endpoint === 'list') {
        return { ok: true, value: { pins: store.pins } };
      }
      if (endpoint === 'pin') {
        const sessionId = sanitizeSessionId(body.sessionId);
        if (sessionId === null) {
          return { ok: false, error: { code: 'bad-request', message: 'session-pins: pin needs a non-empty sessionId' } };
        }
        const title = sanitizeTitle(body.title);
        const existing = store.pins.find((p) => p.sessionId === sessionId);
        if (existing !== undefined) {
          /* Idempotent re-pin: refresh the title, keep the position. */
          if (title !== '') existing.title = title;
        } else {
          store.pins.unshift({ sessionId, title, pinnedAt: Date.now() });
          if (store.pins.length > MAX_PINS) store.pins.length = MAX_PINS;
        }
        saveStore(file, store);
        return { ok: true, value: { pins: store.pins } };
      }
      if (endpoint === 'unpin') {
        const sessionId = sanitizeSessionId(body.sessionId);
        if (sessionId === null) {
          return { ok: false, error: { code: 'bad-request', message: 'session-pins: unpin needs a non-empty sessionId' } };
        }
        store.pins = store.pins.filter((p) => p.sessionId !== sessionId);
        saveStore(file, store);
        return { ok: true, value: { pins: store.pins } };
      }
      return { ok: false, error: { code: 'bad-request', message: `session-pins: unknown endpoint ${JSON.stringify(endpoint)}` } };
    },
    // Loopback-only: pinning is a local surface, and this fence pins the
    // channel to loopback Host headers even on a LAN-serving deployment.
    { authority: 'loopback' },
  );
  logger.debug(`session-pins: serving ${CHANNEL} with ${store.pins.length} pin(s) from ${file}`);
}
