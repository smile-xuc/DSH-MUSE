import test from 'node:test';
import assert from 'node:assert/strict';
import { readSessionEvents, foldSessionEvents, sumUsage } from '../lib/index.js';

const sampleEvents = [
  {
    type: 'turn/start',
    time: 1726100000000,
    data: { turn: 1 },
  },
  {
    type: 'tool/call',
    time: 1726100000500,
    data: { name: 'bash', turn: 1, step: 1 },
  },
  {
    type: 'tool/result',
    time: 1726100000800,
    data: { message: { name: 'bash' }, turn: 1, step: 1 },
  },
  {
    type: 'assistant/chunk',
    time: 1726100001000,
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 0 } } },
  },
  {
    type: 'assistant/message',
    time: 1726100001500,
    data: { turn: 1, step: 1, usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0 } },
  },
];

test('dsh-eval readSessionEvents handles handle.read returning { events }', async () => {
  let closed = false;
  const mockSp = {
    async open(id, access) {
      assert.equal(id, 'sess-1');
      assert.equal(access, 'read');
      return {
        async read() {
          return { events: sampleEvents };
        },
        async close() {
          closed = true;
        },
      };
    },
  };

  const events = await readSessionEvents(mockSp, 'sess-1');
  assert.equal(Array.isArray(events), true);
  assert.equal(events.length, 5);
  assert.ok(closed, 'handle should be closed');
});

test('dsh-eval readSessionEvents handles handle.read returning SessionEvent[] directly (DSH 0.2.0 compatibility)', async () => {
  let closed = false;
  const mockSp = {
    async open(id, access) {
      assert.equal(id, 'sess-2');
      return {
        async read() {
          return sampleEvents; // returns array directly
        },
        async close() {
          closed = true;
        },
      };
    },
  };

  const events = await readSessionEvents(mockSp, 'sess-2');
  assert.equal(Array.isArray(events), true);
  assert.equal(events.length, 5);
  assert.ok(closed, 'handle should be closed');
});

test('dsh-eval readSessionEvents handles readFrom returning array or object', async () => {
  const mockSp1 = {
    async readFrom(id) {
      assert.equal(id, 'sess-3');
      return { events: sampleEvents };
    },
  };
  const mockSp2 = {
    async readFrom(id) {
      assert.equal(id, 'sess-4');
      return sampleEvents;
    },
  };

  const events1 = await readSessionEvents(mockSp1, 'sess-3');
  assert.equal(events1.length, 5);
  const events2 = await readSessionEvents(mockSp2, 'sess-4');
  assert.equal(events2.length, 5);
});

test('dsh-eval foldSessionEvents and sumUsage gracefully tolerate non-array input', () => {
  const fold = foldSessionEvents(null, 0, 1000);
  assert.equal(fold.toolCalls, 0);
  assert.equal(fold.turns, 0);

  const cost = sumUsage(undefined, null, 0, 1000);
  assert.equal(cost.totalTokens, 0);

  const realFold = foldSessionEvents(sampleEvents, 1726099999000, 1726100002000);
  assert.equal(realFold.toolCalls, 1);
  assert.equal(realFold.turns, 1);

  const realCost = sumUsage(sampleEvents, null, 1726099999000, 1726100002000);
  assert.equal(realCost.totalTokens, 90);
});
