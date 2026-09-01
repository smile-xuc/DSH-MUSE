#!/usr/bin/env node
/**
 * check-guardrails — run the guardrails command classifier against the
 * hand-labeled set (eval/guardrails-labeled.json) and report per-class
 * precision/recall plus every mismatch. Exits 1 on any mismatch: the labeled
 * set is the CONTRACT for classification behavior — change the regexes and
 * the labels must be re-affirmed in the same commit.
 *
 * Uses the plugin's own exported createClassifier() — the same code path the
 * runtime uses — so the test measures production behavior, not a copy.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensurePeers } from './_peers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

ensurePeers();
const { createClassifier } = await import(pathToFileURL(join(ROOT, 'plugins', 'dsh-guardrails', 'lib', 'index.js')).href);

const labeled = JSON.parse(readFileSync(join(ROOT, 'eval', 'guardrails-labeled.json'), 'utf8'));
const classify = createClassifier({}); // defaults — same as production default config

/** Map the effect descriptor to the label vocabulary. */
function labelOf(effect) {
  if (effect === undefined) return 'readonly';
  return effect.approval === 'ask' ? 'dangerous' : 'mutating';
}

const mismatches = [];
const confusion = {}; // expect -> actual -> count
for (const c of labeled.cases) {
  const actual = labelOf(classify({ name: 'bash', arguments: { command: c.command } }));
  confusion[c.expect] ??= {};
  confusion[c.expect][actual] = (confusion[c.expect][actual] ?? 0) + 1;
  if (actual !== c.expect) mismatches.push({ ...c, actual });
}

/* per-class precision / recall */
const classes = ['dangerous', 'mutating', 'readonly'];
console.log('# guardrails 分类器标注集报告\n');
console.log('| 类别 | precision | recall | 支持数 |');
console.log('|---|---|---|---|');
for (const cls of classes) {
  const tp = confusion[cls]?.[cls] ?? 0;
  const support = labeled.cases.filter((c) => c.expect === cls).length;
  const predicted = Object.values(confusion).reduce((n, byActual) => n + (byActual[cls] ?? 0), 0);
  const precision = predicted === 0 ? 1 : tp / predicted;
  const recall = support === 0 ? 1 : tp / support;
  console.log(`| ${cls} | ${(precision * 100).toFixed(0)}% (${tp}/${predicted}) | ${(recall * 100).toFixed(0)} (${tp}/${support}) | ${support} |`);
}

if (mismatches.length > 0) {
  console.log(`\n${mismatches.length} 处不一致：`);
  for (const m of mismatches) {
    console.log(`  ✗ [expect ${m.expect} / got ${m.actual}] ${m.command}${m.note ? `  (${m.note})` : ''}`);
  }
  process.exit(1);
}
console.log(`\n[check-guardrails] ${labeled.cases.length}/${labeled.cases.length} 用例一致 — 分类行为符合契约`);
