import test from 'node:test'
import assert from 'node:assert/strict'
import { formatTaskFrame, STALE_AFTER_MS } from '../lib/index.js'

const now = 1_800_000_000_000

function unit(overrides = {}) {
  return {
    id: 'wu_test',
    status: 'active',
    planVersion: 1,
    objective: 'ship the fix',
    constraints: [],
    steps: [{ id: 's1', status: 'pending' }],
    budget: { spentTokens: 0 },
    updatedAt: now - 60_000,
    ...overrides,
  }
}

test('a fresh active unit stays the current plan', () => {
  const text = formatTaskFrame(unit(), now)
  assert.match(text, /ship the fix/)
  assert.match(text, /s1\(pending\)/)
  assert.doesNotMatch(text, /STALE/)
})

test('an active unit untouched for more than a day is not the current plan', () => {
  const text = formatTaskFrame(unit({ updatedAt: now - STALE_AFTER_MS - 1 }), now)
  assert.match(text, /STALE/)
  assert.match(text, /do not execute/i)
  assert.doesNotMatch(text, /s1\(pending\)/)
})

test('spent tokens show up even when no ceiling is set', () => {
  const text = formatTaskFrame(unit({ budget: { spentTokens: 1200 } }), now)
  assert.match(text, /tokens spent 1200/)
})

test('a ceiling that has been passed tells the model to wrap up', () => {
  const text = formatTaskFrame(unit({ budget: { spentTokens: 50, maxTokens: 40 } }), now)
  assert.match(text, /50\/40/)
  assert.match(text, /BUDGET EXCEEDED/)
})

test('a finished unit adds nothing to the prompt', () => {
  assert.equal(formatTaskFrame(unit({ status: 'done' }), now), '')
})
