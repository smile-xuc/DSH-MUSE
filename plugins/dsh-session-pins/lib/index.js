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

/** Hard dependencies: the browser RPC transport (with webServer for route mounting). */
export const inject = ['connection', 'webServer'];

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

function mountRpcChannel(ctx, channel, rpcHandler, options = {}) {
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const route = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const conn = ctx.get ? ctx.get('connection') : ctx.connection;
        if (conn && typeof conn.admit === 'function') {
          const admission = conn.admit(req);
          if (admission && 'rejection' in admission) {
            res.writeHead(admission.rejection);
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
        } else if (conn && typeof conn.requestRejection === 'function') {
          const rejection = conn.requestRejection(req);
          if (rejection !== undefined) {
            res.writeHead(rejection);
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
        }

        if (options.authority === 'loopback') {
          let hostname = '';
          try {
            hostname = new URL(`http://${req.headers.host || '127.0.0.1'}`).hostname.toLowerCase();
          } catch {
            hostname = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
          }
          if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1' && hostname !== '[::1]') {
            res.writeHead(403);
            res.end('forbidden: loopback authority required');
            return;
          }
        }

        if (req.method !== 'POST') {
          res.writeHead(404);
          res.end('not found');
          return;
        }

        const url = new URL(req.url, 'http://127.0.0.1');
        if (!url.pathname.startsWith(channel + '/')) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const endpoint = url.pathname.slice(channel.length + 1);

        const chunks = [];
        let bodyLength = 0;
        const MAX_BYTES = 50 * 1024 * 1024;
        req.on('data', (c) => {
          bodyLength += c.length;
          if (bodyLength <= MAX_BYTES) chunks.push(c);
        });

        await new Promise((resolve) => req.on('end', resolve));
        if (bodyLength > MAX_BYTES) {
          res.writeHead(413);
          res.end('payload too large');
          return;
        }

        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400);
          res.end('bad JSON');
          return;
        }

        const rpcId = body.rpcId || '';
        const payload = body.payload ?? {};

        try {
          const result = await rpcHandler(endpoint, payload);
          const responseBody = JSON.stringify({
            type: 'server-response',
            rpcId,
            result: result ?? { ok: true, value: null },
          });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(responseBody);
        } catch (err) {
          const responseBody = JSON.stringify({
            type: 'server-response',
            rpcId,
            result: {
              ok: false,
              error: {
                code: 'internal',
                message: err instanceof Error ? err.message : String(err),
                details: {},
              },
            },
          });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(responseBody);
        }
      },
    };

    if (typeof ctx.effect === 'function') {
      return ctx.effect(() => ctx.webServer.register(route), `rpc channel ${channel}`);
    }
    return ctx.webServer.register(route);
  }

  if (typeof ctx.connection?.register === 'function') {
    return ctx.connection.register(ctx, channel, rpcHandler);
  } else if (ctx.connection?.rpc?.handle) {
    return ctx.connection.rpc.handle(channel, rpcHandler, options);
  }
}

/** Register the pinning RPC channel. */
export function apply(ctx) {
  const logger = ctx.logger(name);
  const file = storePath();
  /* Single-process host: one in-memory copy is authoritative; every mutation
   * persists before answering so a crash never acknowledges an unsaved pin. */
  let store = loadStore(file);

  const rpcHandler = async (endpoint, payload) => {
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
  };

  mountRpcChannel(ctx, CHANNEL, rpcHandler, { authority: 'loopback' });
  logger.debug(`session-pins: serving ${CHANNEL} with ${store.pins.length} pin(s) from ${file}`);
}
