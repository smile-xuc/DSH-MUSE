#!/usr/bin/env node
/**
 * static-cost — measure the DETERMINISTIC part of the Muse layer's token
 * overhead without any LLM call: the systemPrompt sections and tool
 * definitions the plugins inject into every model request, plus the live
 * task-frame at representative WorkUnit sizes.
 *
 * Method: load each host plugin's apply() with a minimal mock cordis context
 * that records registrations instead of performing them. Services are never
 * instantiated (ctx.plugin only receives the class), storage is never opened,
 * inject() callbacks are not fired (dsh-muse-bridge contributes no prompt
 * surface, only a projection — correctly measured as zero).
 *
 * Output: per-plugin chars + a rough token estimate (chars/4 — a heuristic
 * for mixed zh/en text; reported as a lower-bound-style estimate, not a
 * tokenizer-exact count), and the rendered task-frame at 0/5/10-step sizes.
 * This is the FLOOR of the per-request overhead; the LLM benchmark measures
 * the variable part on top. See docs/EVAL-METHODOLOGY.md §4.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { ensurePeers } from './_peers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* peer packages (cordis, dsh-tools, …) are borrowed from the local DSH
 * install via symlinks — the exact vendored code, never npm copies */
const peerSource = ensurePeers();
console.error(`[static-cost] peers <- ${peerSource}`);

/* A representative WorkUnit for rendering the live task frame. */
function sampleUnit(stepCount) {
  return {
    id: 'wu_sample', status: 'active', planVersion: 2,
    objective: '示例任务：修复登录页在移动端的样式回归并补回归测试',
    constraints: ['不改公开 API', '测试必须绿'],
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `s${i + 1}`,
      title: `步骤 ${i + 1}`,
      status: i < stepCount / 2 ? 'done' : i === Math.floor(stepCount / 2) ? 'in_progress' : 'pending',
    })),
    budget: { spentTokens: 42100, maxTokens: 200000, failures: 0, roundsUsed: 3 },
  };
}

/** Minimal cordis mock: record prompt surfaces and tool registrations. */
function mockCtx(unit) {
  const collected = { sections: [], contexts: [], tools: [] };
  const ctx = {
    plugin() {},
    effect() {},
    on() {},
    inject() {}, // deferred injections contribute no prompt surface
    approval: {},
    workunits: { peekCurrent: () => unit },
    systemPrompt: {
      section(s) { collected.sections.push({ name: s.name, text: s.text }); },
      context(c) { collected.contexts.push(c); },
    },
    tools: {
      register(tool) {
        collected.tools.push({
          name: tool.name,
          /* what actually rides the request: description + parameter schema */
          chars: String(tool.description ?? '').length + JSON.stringify(tool.parameters ?? {}).length,
        });
      },
    },
  };
  return { ctx, collected };
}

const PLUGINS = ['dsh-workunit', 'dsh-effect-ledger', 'dsh-evidence', 'dsh-guardrails', 'dsh-eval', 'dsh-skill-workshop', 'dsh-muse-bridge'];
const GUARDRAILS_DEFAULT_CONFIG = {
  extraDangerousPatterns: [], extraMutatingPatterns: [], askFallback: 'deny',
  ledgerFileWrites: true, ledgerBashMutations: true, deliveryCheck: true, taskFrame: true,
};

const rows = [];
let frameSamples = null;
for (const name of PLUGINS) {
  const mod = await import(pathToFileURL(join(ROOT, 'plugins', name, 'lib', 'index.js')).href);
  const { ctx, collected } = mockCtx(sampleUnit(5));
  if (typeof mod.apply !== 'function') { rows.push({ name, error: 'no apply' }); continue; }
  mod.apply(ctx, name === 'dsh-guardrails' ? GUARDRAILS_DEFAULT_CONFIG : undefined);
  const sectionChars = collected.sections.reduce((n, s) => n + s.text.length, 0);
  const toolChars = collected.tools.reduce((n, t) => n + t.chars, 0);
  /* render context providers once (task frame) for this plugin */
  const contextChars = collected.contexts
    .map((c) => { try { return String(c.text({ agent: { session: { id: 's1' } } })).length; } catch { return 0; } })
    .reduce((a, b) => a + b, 0);
  rows.push({ name, sections: collected.sections.length, sectionChars, tools: collected.tools.map((t) => t.name), toolChars, contextChars });
  if (name === 'dsh-guardrails') {
    frameSamples = [0, 5, 10].map((n) => {
      const { ctx: c2, collected: coll2 } = mockCtx(sampleUnit(n));
      mod.apply(c2, GUARDRAILS_DEFAULT_CONFIG);
      const text = coll2.contexts.map((c) => { try { return String(c.text({ agent: { session: { id: 's1' } } })); } catch { return ''; } }).join('\n');
      return { steps: n, chars: text.length };
    });
  }
}

const est = (chars) => Math.ceil(chars / 4);
const total = rows.reduce((n, r) => n + (r.sectionChars ?? 0) + (r.toolChars ?? 0) + (r.contextChars ?? 0), 0);

console.log('# Muse 层静态 prompt 开销（每请求固定部分，无 LLM 测量）\n');
console.log('| 插件 | systemPrompt 段落 | 工具定义 | 任务框(5步) | 合计 chars | ≈tokens |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.error) { console.log(`| ${r.name} | ${r.error} | — | — | — | — |`); continue; }
  const sum = r.sectionChars + r.toolChars + r.contextChars;
  console.log(`| ${r.name} | ${r.sectionChars} (${r.sections}段) | ${r.toolChars} (${r.tools.join('/') || '无'}) | ${r.contextChars} | ${sum} | ~${est(sum)} |`);
}
console.log(`| **合计** | | | | **${total}** | **~${est(total)}** |`);
console.log('\n任务框随 WorkUnit 规模的增长（字符）:');
for (const s of frameSamples ?? []) console.log(`  - ${s.steps} 步: ${s.chars} chars (~${est(s.chars)} tokens)`);
console.log('\n口径：chars/4 为混合中英文的粗略估算（下界口径，非 tokenizer 精确值）。工具定义=description+parameters schema 序列化长度。');

/* machine-readable line for CI thresholds */
console.log(`\nSTATIC_COST_TOTAL_CHARS=${total}`);
