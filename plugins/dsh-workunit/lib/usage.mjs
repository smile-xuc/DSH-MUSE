/**
 * Provider-reported tokens on one session event.
 * Only a finished assistant message counts: chunk samples are replaced by
 * the message sample for the same step, so counting both would double-charge.
 * @param {object | undefined} event
 * @returns {number}
 */
export function usageDelta(event) {
  if (event?.type !== 'assistant/message') return 0;
  const usage = event.data?.usage;
  if (usage === null || typeof usage !== 'object') return 0;
  let total = 0;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const n = usage[key];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) total += n;
  }
  return Math.trunc(total);
}

/** Stable id for one model step, so a replayed message is not charged twice. */
export function usageStepKey(sessionId, event) {
  const turn = event?.data?.turn;
  const step = event?.data?.step;
  const stepId = turn !== undefined || step !== undefined
    ? `${turn ?? ''}:${step ?? ''}`
    : String(event?.seq ?? event?.time ?? '');
  return `${sessionId}:${stepId}`;
}
