#!/usr/bin/env node
/**
 * eval compare — aggregate eval/results/ into a comparison table, append the
 * batch to eval/history/, and refresh the README results section in place
 * (between <!-- BEGIN EVAL RESULTS --> / <!-- END EVAL RESULTS --> markers).
 *
 *   node eval/bin/compare.mjs
 *
 * Latest result per task×variant wins. History is append-only so trends over
 * time (and over DSH mainline upgrades) stay visible — that is the raw
 * material for the self-iteration loop (see evolve.mjs).
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

function fmt(n, unit = '') {
  return n === null || n === undefined ? 'n/a' : `${n}${unit}`;
}

function compare() {
  const results = loadResults();
  if (results.length === 0) {
    console.log('[eval] no results yet — run `node eval/bin/run.mjs all` first');
    return null;
  }
  /* latest per task×variant */
  const latest = new Map();
  for (const r of results) {
    const key = `${r.task}::${r.variant}`;
    if (!latest.has(key) || latest.get(key).startedAt < r.startedAt) latest.set(key, r);
  }
  const tasks = [...new Set(results.map((r) => r.task))].sort();
  const rows = [];
  for (const task of tasks) {
    const v = latest.get(`${task}::vanilla`);
    const m = latest.get(`${task}::muse`);
    rows.push({ task, vanilla: v, muse: m });
  }

  const lines = [];
  lines.push('| Task | Variant | Verified success | Wall time | Tokens (in+out) | Tool calls | Tool errors | Duplicate side effects |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    for (const variant of ['vanilla', 'muse']) {
      const r = row[variant];
      if (!r) {
        lines.push(`| ${row.task} | ${variant} | (not run) | — | — | — | — | — |`);
        continue;
      }
      const mt = r.metrics ?? {};
      lines.push(`| ${row.task} | ${variant} | ${r.success ? '✅' : '❌'} | ${fmt(Math.round(r.wallMs / 1000), 's')} | ${fmt(mt.totalTokens)} | ${fmt(mt.toolCalls)} | ${fmt(mt.toolErrors)} | ${fmt(mt.duplicateSideEffects)} |`);
    }
  }
  /* deltas */
  lines.push('');
  lines.push('**Deltas (muse − vanilla), latest runs:**');
  lines.push('');
  lines.push('| Task | Δ success | Δ tokens | Δ wall | Δ duplicates |');
  lines.push('|---|---|---|---|---|');
  for (const row of rows) {
    const v = row.vanilla;
    const m = row.muse;
    if (!v || !m || !v.metrics || !m.metrics) {
      lines.push(`| ${row.task} | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const dTokens = m.metrics.totalTokens - v.metrics.totalTokens;
    const dWall = Math.round((m.wallMs - v.wallMs) / 1000);
    const dDup = m.metrics.duplicateSideEffects - v.metrics.duplicateSideEffects;
    const dSuccess = (m.success ? 1 : 0) - (v.success ? 1 : 0);
    lines.push(`| ${row.task} | ${dSuccess === 0 ? '0' : (dSuccess > 0 ? '+1 ✅' : '-1 ❌')} | ${dTokens >= 0 ? '+' : ''}${dTokens} | ${dWall >= 0 ? '+' : ''}${dWall}s | ${dDup <= 0 ? dDup : `+${dDup}`} |`);
  }
  lines.push('');
  lines.push(`_Latest batch: ${new Date().toISOString()} — raw data in eval/results/, trend in eval/history/._`);

  const table = lines.join('\n');

  /* append history */
  mkdirSync(join(EVAL_DIR, 'history'), { recursive: true });
  const batchFile = join(EVAL_DIR, 'history', `${new Date().toISOString().replaceAll(':', '-')}.json`);
  writeFileSync(batchFile, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2) + '\n');

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
