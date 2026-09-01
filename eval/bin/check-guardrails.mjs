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
const plugin = await import(pathToFileURL(join(ROOT, 'plugins', 'dsh-guardrails', 'lib', 'index.js')).href);
const { createClassifier } = plugin;

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
}

/* ---- allowlist semantics: the labeled allowlistCases section runs each
 *  command through BOTH the default classifier and one with the named preset
 *  enabled — the allowlist must demote exactly what it promises and nothing
 *  more (chained commands must stay gated). The preset is resolved from the
 *  plugin's own exports so the pattern string has a single source of truth. */
let allowlistBad = 0;
if (labeled.allowlistCases !== undefined) {
  const section = labeled.allowlistCases;
  const preset = plugin[section.preset];
  if (typeof preset !== 'string') {
    console.error(`\n[check-guardrails] 插件未导出预设 ${section.preset}`);
    process.exit(1);
  }
  const strictCl = createClassifier({});
  const laxCl = createClassifier({ dangerousAllowPatterns: [preset] });
  console.log(`\n# 白名单语义（预设 ${section.preset}）\n`);
  for (const c of section.cases) {
    const s = labelOf(strictCl({ name: 'bash', arguments: { command: c.command } }));
    const l = labelOf(laxCl({ name: 'bash', arguments: { command: c.command } }));
    const ok = s === c.strict && l === c.allowlisted;
    if (!ok) {
      allowlistBad += 1;
      console.log(`  ✗ [strict ${c.strict}/${s} · allowlisted ${c.allowlisted}/${l}] ${c.command}${c.note ? `  (${c.note})` : ''}`);
    }
  }
  console.log(allowlistBad === 0
    ? `  ${section.cases.length}/${section.cases.length} 白名单用例符合预期`
    : `  ${allowlistBad}/${section.cases.length} 白名单用例不符`);
}

if (mismatches.length > 0 || allowlistBad > 0) process.exit(1);
console.log(`\n[check-guardrails] ${labeled.cases.length}/${labeled.cases.length} 用例一致 + 白名单 ${labeled.allowlistCases?.cases.length ?? 0} 例 — 分类行为符合契约`);
