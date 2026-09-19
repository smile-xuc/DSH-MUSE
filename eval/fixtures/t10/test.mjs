import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate } from './service-auth.mjs';
import { createOrder } from './service-order.mjs';
import { processPayment } from './service-payment.mjs';

test('auth service logs structured trace and formatted message', () => {
  const anon = authenticate(null, 'tr-auth-0');
  assert.equal(anon.ok, false);
  assert.equal(typeof anon.log, 'object');
  assert.equal(anon.log.formatted, '[WARN] anonymous login attempt');
  assert.equal(anon.log.traceId, 'tr-auth-0');

  const user = authenticate('alice', 'tr-auth-1');
  assert.equal(user.ok, true);
  assert.equal(user.log.formatted, '[INFO] user alice logged in');
  assert.equal(user.log.traceId, 'tr-auth-1');
});

test('order service logs structured order creation', () => {
  const ord = createOrder('ord-99', 499, 'tr-order-99');
  assert.equal(ord.status, 'created');
  assert.equal(typeof ord.log, 'object');
  assert.equal(ord.log.formatted, '[INFO] order ord-99 created amount=499');
  assert.equal(ord.log.traceId, 'tr-order-99');
});

test('payment service logs structured payment state', () => {
  const ok = processPayment('ord-99', true, 'tr-pay-99');
  assert.equal(ok.success, true);
  assert.equal(typeof ok.log, 'object');
  assert.equal(ok.log.formatted, '[INFO] payment success for order ord-99');
  assert.equal(ok.log.traceId, 'tr-pay-99');

  const fail = processPayment('ord-100', false, 'tr-pay-100');
  assert.equal(fail.success, false);
  assert.equal(typeof fail.log, 'object');
  assert.equal(fail.log.formatted, '[ERROR] payment failed for order ord-100');
  assert.equal(fail.log.traceId, 'tr-pay-100');
});
