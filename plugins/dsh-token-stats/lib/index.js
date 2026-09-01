/**
 * dsh-token-stats (host half) — aggregate provider-reported token usage across
 * every durable session log and serve it to this package's client bundle over
 * a loopback-only Connection RPC channel (`/token-stats/summary`).
 *
 * Data source: `ctx.sessionPersistence` (the same seam the harness itself
 * uses), so no log-format knowledge lives here. Per session the fold keeps
 * ONE usage sample per turn/step — an `assistant/message` final sample
 * replaces the step's earlier `assistant/chunk` usage sample, mirroring
 * `@deepseek-ai/dsh-token-meter`'s `tokenUsage` projection, so streaming
 * double-reports never double count. Buckets follow `TokenUsage`:
 * `inputTokens` is uncached input; cached input rides `cacheReadTokens` /
 * `cacheWriteTokens` (billed input = sum of the three); `outputTokens`
 * already includes reasoning tokens.
 *
 * Caching: `listSnapshots()` hands each log an opaque revision; unchanged
 * logs are never re-parsed, so polling is cheap after the first scan.
 *
 * @module dsh-token-stats
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'token-stats';

/** Hard dependencies: the log seam and the browser RPC transport. */
export const inject = ['sessionPersistence', 'connection'];

/** RPC channel the client bundle calls. Must satisfy Connection's channel pattern. */
const CHANNEL = '/token-stats';

/** One day bucket's disjoint token counters. */
function zeroBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/** Map one provider `TokenUsage` onto the plugin's own bucket shape. */
function bucketsFrom(usage) {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** Add one usage sample into a mutable bucket row. */
function addInto(row, sample) {
  row.input += sample.input;
  row.output += sample.output;
  row.cacheRead += sample.cacheRead;
  row.cacheWrite += sample.cacheWrite;
  row.total += sample.total;
}

/** Local-time `YYYY-MM-DD` key for one epoch-ms timestamp (host zone == the user's machine). */
function dayKey(time) {
  const d = new Date(time);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Local Monday-start week key: the Monday date of the week containing `time`. */
function weekKey(time) {
  const d = new Date(time);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  return dayKey(monday.getTime());
}

/**
 * Fold one session's stored events into per-step usage samples. `readFrom`
 * is a detached physical read (no recovery, no mutation of the log), safe to
 * run against live sessions; it reflects the durable prefix only.
 */
async function readSessionUsage(ctx, id, signal) {
  const { events } = await ctx.sessionPersistence.readFrom(id, 0, signal);
  /** @type {Map<string, {time: number, usage: object}>} turn:step -> newest sample */
  const steps = new Map();
  for (const event of events) {
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    let usage;
    if (event.type === 'assistant/chunk') {
      const chunk = data.chunk;
      if (chunk?.type !== 'usage') continue;
      usage = chunk.usage;
    } else if (event.type === 'assistant/message') {
      if (data.usage === undefined || data.usage === null) continue;
      usage = data.usage;
    } else {
      continue;
    }
    // Insertion order + overwrite: a later event for the same step replaces the
    // earlier sample (message finalizes the step's chunk sample).
    steps.set(`${data.turn}:${data.step}`, { time: event.time, usage });
  }
  const rows = [];
  for (const { time, usage } of steps.values()) rows.push({ time, ...bucketsFrom(usage) });
  return rows;
}

/**
 * Compose the summary payload: per-day rows (descending), per-week rows, and
 * the headline totals the sidebar row shows.
 */
function buildSummary(days, sessionsWithUsage, sessionCount) {
  const dayRows = [...days.entries()]
    .map(([day, row]) => ({ day, ...row }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));

  const weeks = new Map();
  for (const row of dayRows) {
    const key = weekKey(new Date(`${row.day}T12:00:00`).getTime());
    let bucket = weeks.get(key);
    if (bucket === undefined) {
      bucket = zeroBuckets();
      weeks.set(key, bucket);
    }
    addInto(bucket, row);
  }
  const weekRows = [...weeks.entries()]
    .map(([week, row]) => ({ week, ...row }))
    .sort((a, b) => (a.week < b.week ? 1 : -1));

  const now = Date.now();
  const todayKey = dayKey(now);
  const thisWeekKey = weekKey(now);
  const last7Cutoff = dayKey(now - 6 * 24 * 60 * 60 * 1000);

  const today = zeroBuckets();
  const thisWeek = zeroBuckets();
  const last7Days = zeroBuckets();
  const all = zeroBuckets();
  for (const row of dayRows) {
    addInto(all, row);
    if (row.day === todayKey) addInto(today, row);
    if (weekKey(new Date(`${row.day}T12:00:00`).getTime()) === thisWeekKey) addInto(thisWeek, row);
    if (row.day >= last7Cutoff) addInto(last7Days, row);
  }

  return {
    generatedAt: now,
    sessionCount,
    sessionsWithUsage,
    totals: { today, thisWeek, last7Days, all },
    days: dayRows,
    weeks: weekRows,
  };
}

/** Register the aggregation RPC channel. */
export function apply(ctx) {
  const logger = ctx.logger(name);
  /** sessionId -> { revision: string, rows: Array<{time, input, output, cacheRead, cacheWrite, total}> } */
  const cache = new Map();

  async function collect(signal) {
    const snapshots = await ctx.sessionPersistence.listSnapshots(signal);
    const seen = new Set();
    const days = new Map();
    let sessionsWithUsage = 0;
    for (const snapshot of snapshots) {
      signal?.throwIfAborted();
      const id = snapshot.header.id;
      seen.add(id);
      const revision = String(snapshot.revision);
      let entry = cache.get(id);
      if (entry === undefined || entry.revision !== revision) {
        let rows;
        let failed = false;
        try {
          rows = await readSessionUsage(ctx, id, signal);
        } catch (error) {
          // One unreadable log must not blank the whole panel; keep any prior cache.
          failed = true;
          logger.warn(`token-stats: skipping session ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (failed) {
          if (entry === undefined) continue;
        } else {
          entry = { revision, rows };
          cache.set(id, entry);
        }
      }
      if (entry.rows.length > 0) sessionsWithUsage += 1;
      for (const row of entry.rows) {
        const key = dayKey(row.time);
        let bucket = days.get(key);
        if (bucket === undefined) {
          bucket = zeroBuckets();
          days.set(key, bucket);
        }
        addInto(bucket, row);
      }
      // Long logs parse synchronously; yield between sessions so a first scan
      // never stalls the host event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
    return buildSummary(days, sessionsWithUsage, snapshots.length);
  }

  ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, _payload, signal) => {
      if (endpoint !== 'summary') {
        return { ok: false, error: { code: 'bad-request', message: `token-stats: unknown endpoint ${JSON.stringify(endpoint)}` } };
      }
      try {
        return { ok: true, value: await collect(signal) };
      } catch (error) {
        return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } };
      }
    },
    // Loopback-only: the panel is a local surface, and this fence pins the
    // channel to loopback Host headers even on a LAN-serving deployment.
    { authority: 'loopback' },
  );
}
