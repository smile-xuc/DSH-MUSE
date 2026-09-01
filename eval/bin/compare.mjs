#!/usr/bin/env node
/**
 * eval compare — aggregate eval/results/ into a statistically honest
 * comparison table, append the batch to eval/history/, and refresh the
 * README results section in place (between the EVAL RESULTS markers).
 *
 *   node eval/bin/compare.mjs
 *
 * Aggregation discipline (docs/EVAL-METHODOLOGY.md §2):
 *   - per task×variant, the LATEST BATCH (shared `batch` id from one run.mjs
 *     invocation) is aggregated — legacy results without a batch id are
 *     treated as singleton batches;
 *   - report median + IQR [p25–p75] and success rate n/N — never a single
 *     run, never a mean (LLM latency is long-tailed);
 *   - deltas are computed between the two arms' medians within that batch;
 *   - failed runs (including infra failures) count in the success-rate
 *     denominator — failure is data.
 *
 * History stays append-only and keeps the latest RAW result per arm under
 * `vanilla`/`muse` (evolve.mjs consumes those); aggregates live under `agg`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_DIR = join(ROOT, 'eval');

function loadResults() {
  const dir = join(EVAL_DIR, 'results');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

/** Nearest-rank percentile over a sorted copy; undefined-safe. */
function pct(values, q) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
}

/** Aggregate one batch of runs for one task×variant. */
function aggregate(runs) {
  const tokens = runs.map((r) => r.metrics?.totalTokens);
  const walls = runs.map((r) => r.wallMs);
  const dups = runs.map((r) => r.metrics?.duplicateSideEffects ?? 0);
  const toolCalls = runs.map((r) => r.metrics?.toolCalls);
  const toolErrors = runs.map((r) => r.metrics?.toolErrors ?? 0);
  const ok = runs.filter((r) => r.success).length;
  return {
    n: runs.length,
    successCount: ok,
    successRate: runs.length === 0 ? null : ok / runs.length,
    tokens: { p25: pct(tokens, 0.25), p50: pct(tokens, 0.5), p75: pct(tokens, 0.75) },
    wallSec: { p25: pct(walls.map((w) => Math.round(w / 1000)), 0.25), p50: pct(walls.map((w) => Math.round(w / 1000)), 0.5), p75: pct(walls.map((w) => Math.round(w / 1000)), 0.75) },
    toolCalls: { p50: pct(toolCalls, 0.5) },
    toolErrors: { max: Math.max(0, ...runs.map((r) => r.metrics?.toolErrors ?? 0)) },
    duplicates: { max: Math.max(0, ...dups) },
    crashed: runs.some((r) => r.crashed === true),
    env: runs[runs.length - 1]?.env ?? null,
  };
}

function fmt(n, unit = '') {
  return n === null || n === undefined ? 'n/a' : `${n}${unit}`;
}

function fmtSpread(agg, digits = 0) {
  if (agg.p50 === null) return 'n/a';
  const f = (x) => digits > 0 ? (x / 1000).toFixed(1) + 'k' : String(Math.round(x));
  return agg.p25 === agg.p75 ? f(agg.p50) : `${f(agg.p50)} [${f(agg.p25)}–${f(agg.p75)}]`;
}

function compare() {
  const results = loadResults();
  if (results.length === 0) {
    console.log('[eval] no results yet — run `node eval/bin/run.mjs all` first');
    return null;
  }
  /* latest batch per task×variant (legacy runs without `batch` = singletons
   * keyed by their bare ISO timestamp, which sorts BEFORE 'b_' batch ids —
   * legacy data can never shadow a newer batched run) */
  const groups = new Map();
  for (const r of results) {
    const key = `${r.task}::${r.variant}`;
    const batchKey = r.batch ?? r.startedAt;
    if (!groups.has(key)) groups.set(key, new Map());
    const byBatch = groups.get(key);
    if (!byBatch.has(batchKey)) byBatch.set(batchKey, []);
    byBatch.get(batchKey).push(r);
  }
  const tasks = [...new Set(results.map((r) => r.task))].sort();
  const rows = [];
  for (const task of tasks) {
    const row = { task };
    for (const variant of ['vanilla', 'muse']) {
      const byBatch = groups.get(`${task}::${variant}`);
      if (!byBatch) continue;
      const latestBatchKey = [...byBatch.keys()].sort().pop();
      const batchRuns = byBatch.get(latestBatchKey).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      row[variant] = batchRuns[batchRuns.length - 1]; // latest raw result (evolve compat)
      row[`${variant}Agg`] = aggregate(batchRuns);
    }
    rows.push(row);
  }

  const lines = [];
  lines.push('| Task | Variant | Success | Wall p50 | Tokens p50 [IQR] | Tool calls | Tool errors | Duplicate side effects | n |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    for (const variant of ['vanilla', 'muse']) {
      const agg = row[`${variant}Agg`];
      if (!agg) {
        lines.push(`| ${row.task} | ${variant} | (not run) | — | — | — | — | — | — |`);
        continue;
      }
      lines.push(`| ${row.task} | ${variant} | ${agg.successCount}/${agg.n}${agg.successRate === 1 ? ' ✅' : agg.successRate === 0 ? ' ❌' : ' ⚠️'} | ${fmtSpread(agg.wallSec)}s | ${fmtSpread(agg.tokens, 1)} | ${fmt(agg.toolCalls.p50)} | ${fmt(agg.toolErrors.max)} | ${fmt(agg.duplicates.max)} | ${agg.n} |`);
    }
  }
  /* deltas between arm medians, latest batch */
  lines.push('');
  lines.push('**Deltas (muse − vanilla), latest batches (medians):**');
  lines.push('');
  lines.push('| Task | Δ success rate | Δ tokens p50 | Δ wall p50 | Δ duplicates (max) |');
  lines.push('|---|---|---|---|---|');
  for (const row of rows) {
    const v = row.vanillaAgg;
    const m = row.museAgg;
    if (!v || !m || v.tokens.p50 === null || m.tokens.p50 === null) {
      lines.push(`| ${row.task} | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const dRate = (m.successRate ?? 0) - (v.successRate ?? 0);
    const dTokens = m.tokens.p50 - v.tokens.p50;
    const dWall = m.wallSec.p50 - v.wallSec.p50;
    const dDup = m.duplicates.max - v.duplicates.max;
    lines.push(`| ${row.task} | ${dRate === 0 ? '0' : `${dRate > 0 ? '+' : ''}${Math.round(dRate * 100)}pp`} | ${dTokens >= 0 ? '+' : ''}${dTokens} | ${dWall >= 0 ? '+' : ''}${dWall}s | ${dDup <= 0 ? dDup : `+${dDup}`} |`);
  }
  lines.push('');
  const envNote = rows.find((r) => r.museAgg?.env ?? r.vanillaAgg?.env);
  const env = envNote?.museAgg?.env ?? envNote?.vanillaAgg?.env;
  lines.push(`_Latest batch: ${new Date().toISOString()}${env ? ` — env: dsh ${env.dshVersion}, ${env.model}, node ${env.node}` : ''} — raw data in eval/results/, trend in eval/history/._`);

  const table = lines.join('\n');

  /* append history (raw latest per arm for evolve + aggregates for trend) */
  mkdirSync(join(EVAL_DIR, 'history'), { recursive: true });
  const batchFile = join(EVAL_DIR, 'history', `${new Date().toISOString().replaceAll(':', '-')}.json`);
  writeFileSync(batchFile, JSON.stringify({
    at: new Date().toISOString(),
    rows: rows.map((r) => ({
      task: r.task,
      vanilla: r.vanilla ?? null,
      muse: r.muse ?? null,
      agg: { vanilla: r.vanillaAgg ?? null, muse: r.museAgg ?? null },
    })),
  }, null, 2) + '\n');

  /* refresh README section in place */
  const readmePath = join(ROOT, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    const begin = '<!-- BEGIN EVAL RESULTS -->';
    const end = '<!-- END EVAL RESULTS -->';
    if (readme.includes(begin) && readme.includes(end)) {
      const updated = readme.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), `${begin}\n\n${table}\n\n${end}`);
      writeFileSync(readmePath, updated);
      console.log('[eval] README results section refreshed');
    }
  }

  writeFileSync(join(EVAL_DIR, 'report.md'), `# DSH-MUSE eval report\n\n${table}\n`);
  console.log('\n' + table + '\n');
  console.log(`[eval] history appended: ${batchFile}`);
  return { rows, table };
}

compare();
