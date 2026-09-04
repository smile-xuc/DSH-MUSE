import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';

let projection;
apply({ inject(_services, callback) {
  callback({ sessionProjections: { register(value) { projection = value; } } });
} });

function replayTool(name, args, text) {
  let state = projection.init();
  const events = [
    { type: 'tool/call', data: { name, arguments: JSON.stringify(args), callId: 'call-1', turn: 1, step: 1 } },
    { type: 'tool/result', data: { message: { content: [{ toolCallId: 'call-1', content: text }] } } },
  ];
  for (const event of events) state = projection.apply(state, event);
  return { state, view: projection.wire.view(state) };
}

function assertLossless(value) {
  // DSH 0.1.2 rejects event arguments that change during JSON transport.
  assert.deepEqual(value, JSON.parse(JSON.stringify(value)));
}

test('opening a history with a successful shell effect produces transportable projections', () => {
  const { state, view } = replayTool('bash', { command: 'mkdir -p example' }, '');
  assert.equal(view.effects[0].status, 'executed');
  assertLossless(state);
  assertLossless(view);
});

test('legacy rendered workunits without timestamps or step notes remain transportable', () => {
  const { state, view } = replayTool('workunit', { op: 'create' },
    'WorkUnit wu-1 [active] rev=1 plan v1\nObjective: Restore history\n- step-1 [pending] Inspect history');
  assert.equal(view.workunit.id, 'wu-1');
  assert.equal(view.workunit.steps[0].title, 'Inspect history');
  assertLossless(state);
  assertLossless(view);
});

test('effect results with omitted optional summary remain transportable', () => {
  const { state, view } = replayTool('effect', { op: 'propose' }, JSON.stringify({
    ok: true, entry: { idempotencyKey: 'effect-1', action: 'fs.write', resource: 'example', status: 'executed', updatedAt: 1 },
  }));
  assert.equal(view.effects[0].key, 'effect-1');
  assertLossless(state);
  assertLossless(view);
});

test('unrelated events preserve the same projection state', () => {
  const state = projection.init();
  assert.equal(projection.apply(state, { type: 'user/message', data: {} }), state);
});
