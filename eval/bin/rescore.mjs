#!/usr/bin/env node
/**
 * rescore — recompute metrics for existing eval/results/*.json without
 * re-running the LLM. Useful after fixing the metrics pipeline.
 *
 *   node eval/bin/rescore.mjs
 *
 * Session logs are matched by the session meta's `cwd` (realpath of the
 * recorded workdir), falling back to the run's time window.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const ZSTD_MAGIC = 0xfd2fb528;

function decompressFrames(buffer) {
  const offsets = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i);
  }
  const chunks = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    try { chunks.push(zstdDecompressSync(buffer.subarray(offsets[i], end))); } catch { /* skip */ }
  }
  return chunks.map((c) => c.toString('utf8')).join('\n');
}

function allSessionFiles() {
  const root = join(HOME, 'sessions');
  const hits = [];
  for (const dir of readdirSync(root)) {
    for (const s of readdirSync(join(root, dir))) {
      const file = join(root, dir, s, 'session.jsonl.zstd');
      try { statSync(file); hits.push(file); } catch { /* skip */ }
    }
  }
  return hits;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const MUTATING_CMD = [
  />[>]?\s*[^\s|&]/,
  /\b(mv|cp|mkdir|touch|ln|chmod|chown)\b/,
  /\bsed\s+(-\w+\s+)*-i\b/,
  /\bgit\s+(add|commit|checkout|switch|merge|rebase|restore|stash|apply|push)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|publish)\b/,
];

/** Mirror of the guardrails mutating-command classification: only duplicates
 *  of state-changing operations count as duplicate side effects (re-running
 *  a test command is a read, not a side effect). */
function isMutatingKey(key) {
  if (/^write:|^edit:|^str[-_]replace/.test(key)) return true;
  if (!key.startsWith('bash:')) return false;
  const cmdMatch = /\{"command":"((?:[^"\\]|\\.)*)"/.exec(key);
  if (cmdMatch === null) return false;
  let command;
  try { command = JSON.parse(`"${cmdMatch[1]}"`); } catch { return false; }
  return MUTATING_CMD.some((re) => re.test(command));
}

function fold(text) {
  const events = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const usageByStep = new Map();
  let toolCalls = 0;
  let toolErrors = 0;
  let llmRetries = 0;
  const callKeys = new Map();
  const executedCount = new Map();
  let duplicateSideEffects = 0;
  for (const ev of events) {
    const d = ev?.data;
    if (d === null || typeof d !== 'object') continue;
    switch (ev.type) {
      case 'tool/call': {
        toolCalls += 1;
        let argsObj;
        try { argsObj = JSON.parse(d.arguments ?? 'null'); } catch { argsObj = null; }
        const semantic = d.name === 'bash' && argsObj?.command !== undefined ? { command: argsObj.command } : argsObj;
        if (d.callId !== undefined) callKeys.set(d.callId, `${d.name}:${canonical(semantic)}`);
        break;
      }
      case 'tool/result': {
        /* the result event carries the call link at message.source.callId and
           the failure flag at message.content[0].isError (hard failures may
           also surface as data.error) */
        const resultCallId = d.callId ?? d.message?.source?.callId ?? d.message?.content?.[0]?.toolCallId;
        const failed = (d.error !== undefined && d.error !== null) || d.message?.content?.[0]?.isError === true;
        if (failed) toolErrors += 1;
        const key = resultCallId === undefined ? undefined : callKeys.get(resultCallId);
        if (key !== undefined && !failed) {
          const count = (executedCount.get(key) ?? 0) + 1;
          executedCount.set(key, count);
          if (count > 1 && isMutatingKey(key)) duplicateSideEffects += 1;
        }
        break;
      }
      case 'llm/retry':
      case 'llm/retry-started':
        llmRetries += 1;
        break;
      case 'assistant/chunk':
        if (d.chunk?.type === 'usage') usageByStep.set(`${d.turn}:${d.step}`, d.chunk.usage);
        break;
      case 'assistant/message':
        if (d.usage != null) usageByStep.set(`${d.turn}:${d.step}`, d.usage);
        break;
      default:
        break;
    }
  }
  let inputTokens = 0;
  let outputTokens = 0;
  for (const u of usageByStep.values()) {
    inputTokens += (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    outputTokens += u.outputTokens ?? 0;
  }
  return { toolCalls, toolErrors, llmRetries, duplicateSideEffects, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** Decode only the session meta line (first frame) to read cwd. */
function sessionCwd(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return null;
  /* first frame ends at the next magic (or EOF) */
  let end = buffer.length;
  for (let i = 4; i + 4 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) === ZSTD_MAGIC) { end = i; break; }
  }
  try {
    const text = zstdDecompressSync(buffer.subarray(0, end)).toString('utf8');
    const meta = JSON.parse(text.split('\n')[0]);
    return meta?.type === 'session' ? meta.cwd : null;
  } catch { return null; }
}

const resultsDir = join(EVAL_DIR(), 'results');
function EVAL_DIR() { return join(ROOT, 'eval'); }

const files = allSessionFiles();
let rescored = 0;
for (const name of readdirSync(resultsDir).filter((f) => f.endsWith('.json'))) {
  const path = join(resultsDir, name);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  const workdirReal = realpathSync(result.workdir);
  const match = files.find((f) => sessionCwd(f) === workdirReal);
  if (!match) {
    console.log(`[rescore] ${name}: no session log found for ${workdirReal}`);
    continue;
  }
  result.metrics = fold(decompressFrames(readFileSync(match)));
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
  rescored += 1;
  console.log(`[rescore] ${name}: tokens=${result.metrics.totalTokens} tools=${result.metrics.toolCalls} dup=${result.metrics.duplicateSideEffects}`);
}
console.log(`[rescore] ${rescored} result(s) updated`);
