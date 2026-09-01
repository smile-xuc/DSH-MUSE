#!/usr/bin/env node
/**
 * evolve — the self-iteration loop over eval history.
 *
 * Reads eval/history/ batches and produces a dated improvement-proposal
 * document at docs/proposals/<date>.md:
 *
 *   - tasks where muse LOST to vanilla (success regression)      -> P0 fix
 *   - tasks where muse token overhead exceeds the budget (+60%)  -> P1 trim
 *   - duplicate-side-effect wins                                 -> keep/extend
 *   - failure-class hints from tool errors / retries             -> prompt or
 *     guardrail adjustments, drafted in skill_workshop format so a DSH
 *     session can turn them into governed skill proposals directly
 *
 * The loop: run eval -> compare -> evolve -> review proposal -> (inside DSH)
 * `skill_workshop` propose -> human approve -> apply -> re-run eval. That is
 * the Muse self-evolution story, wired to the benchmark instead of vibes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_DIR = join(ROOT, 'eval');
const OVERHEAD_BUDGET = 0.6; // muse may cost up to +60% tokens before a trim is proposed

function loadHistory() {
  const dir = join(EVAL_DIR, 'history');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

const history = loadHistory();
if (history.length === 0) {
  console.log('[evolve] no history yet — run `node eval/bin/run.mjs all` then `node eval/bin/compare.mjs`');
  process.exit(0);
}

const latest = history[history.length - 1];
const findings = [];

for (const row of latest.rows) {
  const v = row.vanilla;
  const m = row.muse;
  if (!v || !m || !v.metrics || !m.metrics) continue;

  if (v.success && !m.success) {
    findings.push({
      priority: 'P0',
      task: row.task,
      kind: 'success-regression',
      detail: `vanilla succeeded but muse failed (${m.verifyDetail}). The Muse layer is blocking a task it should not — inspect guardrails denials and the workunit completion gate for this task shape.`,
    });
  }
  if (v.metrics.totalTokens > 0) {
    const overhead = (m.metrics.totalTokens - v.metrics.totalTokens) / v.metrics.totalTokens;
    if (overhead > OVERHEAD_BUDGET) {
      findings.push({
        priority: 'P1',
        task: row.task,
        kind: 'token-overhead',
        detail: `muse costs +${Math.round(overhead * 100)}% tokens (${v.metrics.totalTokens} -> ${m.metrics.totalTokens}). Consider trimming systemPrompt sections, narrowing the task-frame injection, or reducing ledger verbosity.`,
      });
    }
  }
  if ((v.metrics.duplicateSideEffects ?? 0) > (m.metrics.duplicateSideEffects ?? 0)) {
    findings.push({
      priority: 'keep',
      task: row.task,
      kind: 'duplicate-guard-win',
      detail: `muse prevented ${v.metrics.duplicateSideEffects - m.metrics.duplicateSideEffects} duplicate side effect(s) that vanilla executed.`,
    });
  }
  if ((m.metrics.toolErrors ?? 0) > (v.metrics.toolErrors ?? 0) + 1) {
    findings.push({
      priority: 'P1',
      task: row.task,
      kind: 'tool-errors',
      detail: `muse run produced ${m.metrics.toolErrors} tool errors vs vanilla's ${v.metrics.toolErrors}. Check whether workunit/effect tool misuse dominates; if so, improve the tool descriptions or the task frame.`,
    });
  }
}

const date = new Date().toISOString().slice(0, 10);
const lines = [
  `# DSH-MUSE evolution proposals — ${date}`,
  '',
  `Source batch: ${latest.at} (${latest.rows.length} task row(s), history depth ${history.length}).`,
  '',
  findings.length === 0 ? 'No findings: muse matched vanilla on success within overhead budget. Widen the task suite.' : '',
  ...findings.map((f) => [
    `## [${f.priority}] ${f.kind} — ${f.task}`,
    '',
    f.detail,
    '',
    'Suggested next step: open a DSH session, turn this into a governed change:',
    '',
    '```',
    `skill_workshop op=propose  # content = the fix, rationale = this finding, evalNote = reference batch ${latest.at}`,
    '```',
    '',
  ].join('\n')),
];

mkdirSync(join(ROOT, 'docs', 'proposals'), { recursive: true });
const file = join(ROOT, 'docs', 'proposals', `${date}.md`);
writeFileSync(file, lines.filter((l) => l !== '').join('\n') + '\n');
console.log(`[evolve] ${findings.length} finding(s) -> ${file}`);
for (const f of findings) console.log(`  [${f.priority}] ${f.kind} @${f.task}`);
