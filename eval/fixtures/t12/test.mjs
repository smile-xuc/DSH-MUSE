import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMetric, aggregateMetrics } from './telemetry.mjs';

test('legacy events format with numeric timestamps and non-null values', () => {
  const ev1 = { id: 101, timestamp: 1726000000000, value: 42.5 };
  const res = normalizeMetric(ev1);
  assert.equal(res.id, '101');
  assert.equal(res.timeMs, 1726000000000);
  assert.equal(res.value, 42.5);
});

test('drifted events with ISO 8601 strings and null values with fallbackValue', () => {
  const ev2 = { id: 102, timestamp: '2026-09-19T08:00:00.000Z', value: null, fallbackValue: 12.34 };
  const res = normalizeMetric(ev2);
  assert.equal(res.id, '102');
  assert.equal(res.timeMs, new Date('2026-09-19T08:00:00.000Z').getTime());
  assert.equal(res.value, 12.34);
});

test('aggregate mixed legacy and drifted events', () => {
  const batch = [
    { id: 'a', timestamp: 1726000000000, value: 10 },
    { id: 'b', timestamp: '2026-09-19T08:00:00.000Z', value: null, fallbackValue: 20 },
    { id: 'c', timestamp: '2026-09-19T09:00:00.000Z', value: 30 },
  ];
  const agg = aggregateMetrics(batch);
  assert.equal(agg.count, 3);
  assert.equal(agg.total, 60);
});
