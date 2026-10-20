import test from 'node:test'
import assert from 'node:assert/strict'
import { usageDelta, usageStepKey } from '../lib/usage.mjs'

test('a finished assistant message sums provider usage', () => {
  const delta = usageDelta({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 2,
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1 },
    },
  })
  assert.equal(delta, 18)
})

test('chunk samples are not charged', () => {
  assert.equal(usageDelta({
    type: 'assistant/chunk',
    data: { chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } } },
  }), 0)
})

test('a message without usage is zero', () => {
  assert.equal(usageDelta({ type: 'assistant/message', data: {} }), 0)
})

test('step keys stay stable for the same turn and step', () => {
  const event = { type: 'assistant/message', data: { turn: 3, step: 1, usage: { outputTokens: 1 } } }
  assert.equal(usageStepKey('sess', event), usageStepKey('sess', event))
  assert.notEqual(usageStepKey('sess', event), usageStepKey('other', event))
})
