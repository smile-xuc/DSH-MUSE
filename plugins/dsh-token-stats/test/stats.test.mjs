import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function createMockContext(persistenceMock) {
  let registeredHandler = null;
  const ctx = {
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
    sessionPersistence: persistenceMock,
    connection: {
      register: (_owner, channel, handler) => {
        if (channel === '/token-stats') registeredHandler = handler;
      },
      rpc: {
        handle: (channel, handler) => {
          if (channel === '/token-stats') registeredHandler = handler;
        },
      },
    },
  };
  apply(ctx);
  return { ctx, handler: registeredHandler };
}

const sampleEvents = [
  {
    type: 'assistant/chunk',
    time: 1726100000000,
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 } } },
  },
  {
    type: 'assistant/message',
    time: 1726100001000,
    data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 1 } },
  },
];

test('dsh-token-stats works with DSH 0.1.5 sessionPersistence (list + open handle)', async () => {
  let handleClosed = false;
  const mockPersistence = {
    async list() {
      return [{ header: { id: 'sess-01' }, revision: 'rev-1' }];
    },
    async open(id, access) {
      assert.equal(id, 'sess-01');
      assert.equal(access, 'read');
      return {
        async read() {
          return { events: sampleEvents };
        },
        async close() {
          handleClosed = true;
        },
      };
    },
  };

  const { handler } = createMockContext(mockPersistence);
  assert.ok(handler, 'rpc handler should be registered');

  const res = await handler('summary', {});
  assert.equal(res.ok, true);
  assert.ok(handleClosed, 'session handle should be closed after read');
  assert.equal(res.value.sessionCount, 1);
  assert.equal(res.value.sessionsWithUsage, 1);
  // input(10) + output(20) + cacheRead(2) + cacheWrite(1) = 33
  assert.equal(res.value.totals.all.total, 33);
  assert.equal(res.value.totals.all.output, 20);
});

test('dsh-token-stats works with DSH 0.1.2 sessionPersistence (listSnapshots + readFrom)', async () => {
  const mockPersistence = {
    async listSnapshots() {
      return [{ header: { id: 'sess-02' }, revision: 'rev-2' }];
    },
    async readFrom(id, fromSeq) {
      assert.equal(id, 'sess-02');
      assert.equal(fromSeq, 0);
      return { events: sampleEvents };
    },
  };

  const { handler } = createMockContext(mockPersistence);
  assert.ok(handler, 'rpc handler should be registered');

  const res = await handler('summary', {});
  assert.equal(res.ok, true);
  assert.equal(res.value.sessionCount, 1);
  assert.equal(res.value.sessionsWithUsage, 1);
  assert.equal(res.value.totals.all.total, 33);
});

test('rpc error envelope contains details object conforming to client-connection schema', async () => {
  const mockPersistence = {
    async list() {
      throw new Error('storage read failed');
    },
  };

  const { handler } = createMockContext(mockPersistence);
  const errRes1 = await handler('unknown-endpoint', {});
  assert.equal(errRes1.ok, false);
  assert.equal(typeof errRes1.error.details, 'object');
  assert.notEqual(errRes1.error.details, null);

  const errRes2 = await handler('summary', {});
  assert.equal(errRes2.ok, false);
  assert.equal(typeof errRes2.error.details, 'object');
  assert.notEqual(errRes2.error.details, null);
  assert.match(errRes2.error.message, /storage read failed/);
});
