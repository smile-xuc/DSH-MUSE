/**
 * Structured logger module.
 * Needs refactoring from logEvent(level, message) to logEvent({ level, message, timestamp, traceId }).
 */
export function logEvent(optionsOrLevel, maybeMessage) {
  if (typeof optionsOrLevel === 'object' && optionsOrLevel !== null) {
    const { level, message, timestamp = Date.now(), traceId = 'tr-default' } = optionsOrLevel;
    return {
      formatted: `[${String(level).toUpperCase()}] ${message}`,
      timestamp,
      traceId,
    };
  }
  // Deprecated positional signature:
  return `[${String(optionsOrLevel).toUpperCase()}] ${maybeMessage}`;
}
