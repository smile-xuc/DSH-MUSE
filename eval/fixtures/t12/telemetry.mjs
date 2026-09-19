/**
 * Telemetry event normalizer module.
 */
export function normalizeMetric(event) {
  if (!event || typeof event !== 'object') throw new Error('invalid event payload');

  // Currently only works with number timestamps
  const timeMs = Number(event.timestamp);

  // Crashes on null/undefined value
  const val = event.value.toFixed(2);

  return {
    id: String(event.id),
    timeMs,
    value: Number(val),
  };
}

export function aggregateMetrics(events) {
  let total = 0;
  for (const e of events) {
    const norm = normalizeMetric(e);
    total += norm.value;
  }
  return { count: events.length, total: Number(total.toFixed(2)) };
}
