#!/usr/bin/env node
/**
 * eval runner — execute benchmark tasks under variant profiles and record
 * comparable, attributable metrics. Methodology: docs/EVAL-METHODOLOGY.md.
 *
 *   node eval/bin/run.mjs <taskId|all> [--variant vanilla|muse|both]
 *                         [--timeout 300] [--repeat 1]
 *
 * Repeat mode interleaves variants per round (v,m,v,m…) so time-of-day and
 * cache-warmth drift is shared by both arms instead of confounding one.
 * Every invocation shares one `batch` id; compare.mjs aggregates the latest
 * batch per task×variant (median + IQR), never a single noisy run.
 *
 * One run:
 *   1. creates a fresh tmp workdir (fixtures are copied in when declared)
 *   2. spawns `dsh --profile eval-<variant> "<prompt>"` with cwd=workdir
 *      (tasks may declare a `crash` block: SIGKILL after a marker file
 *      appears, then a second resume run in the same workdir — the
 *      crash-recovery behavioral test)
 *   3. runs the task verifier: fileContains | command | pathExists |
 *      sessionLogContains (per-variant override via `variantVerify`)
 *   4. folds the session log(s) (session.jsonl.zstd, node:zlib) into metrics:
 *      tokens per bucket (uncached/cacheRead/cacheWrite/output; one sample
 *      per turn:step, last wins), tool calls, tool errors, llm retries,
 *      duplicate side effects (same tool+canonical args executed > 1×)
 *   5. writes eval/results/<task>--<variant>--<ts>.json with env attribution
 *      (dsh version, model, profile hash, node version, batch)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_DIR = join(ROOT, 'eval');
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { task: argv[2], variant: 'both', timeout: 300, repeat: 1, layer: undefined };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--variant') args.variant = argv[++i];
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i]);
    else if (argv[i] === '--repeat') args.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--layer') args.layer = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.task) throw new Error('usage: run.mjs <taskId|all> [--variant vanilla|muse|both] [--timeout 300] [--repeat N] [--layer overhead|behavioral]');
  return args;
}

function loadTasks(which, layer) {
  const dir = join(EVAL_DIR, 'tasks');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  let tasks = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  /* --layer filters `all`: the overhead layer (t01–t03) is the quick
   * validation subset; behavioral tasks (t04–t06) are heavy (crash cycles,
   * deliberate gate rejections ≈ 300k+ tokens on the muse arm) and are
   * triggered deliberately, e.g. `run.mjs all --layer behavioral`. */
  if (layer !== undefined) tasks = tasks.filter((t) => (t.layer ?? 'overhead') === layer);
  if (which === 'all') return tasks;
  const task = tasks.find((t) => t.id === which);
  if (!task) throw new Error(`task '${which}' not found in ${dir}${layer !== undefined ? ` (layer '${layer}')` : ''}`);
  return [task];
}

/* --------------------------- env attribution ---------------------- */

/** One-time environment fingerprint for result attribution. */
function collectEnv() {
  let dshVersion = 'unknown';
  try {
    dshVersion = String(spawnSync('dsh', ['--version'], { encoding: 'utf8' }).stdout ?? '').trim() || 'unknown';
  } catch { /* dsh not on PATH */ }
  let model = 'unknown';
  try {
    const settings = readFileSync(join(HOME, 'settings.yaml'), 'utf8');
    const m = /agent-default-model:\s*\n\s*provider:\s*(\S+)\s*\n\s*model:\s*(\S+)/.exec(settings);
    if (m) model = `${m[1]}/${m[2]}`;
  } catch { /* no settings */ }
  return { dshVersion, model, node: process.version };
}

/** Per-variant profile fingerprint: hash of the profile's patch + manifest. */
function profileHash(variant) {
  const dir = join(HOME, 'profiles', `eval-${variant}`);
  const hash = createHash('sha256');
  for (const f of ['cordis.patch.yml', 'package.json']) {
    try { hash.update(readFileSync(join(dir, f))); } catch { /* absent */ }
  }
  return hash.digest('hex').slice(0, 12);
}

/* ------------------------------ verify ---------------------------- */

/**
 * Verify a run. `variantVerify[variant]` replaces the shared `verify` when
 * present — behavior-difference tasks (t05/t06) EXPECT the two arms to end
 * in different states; that difference is the evidence (see methodology §3).
 */
function verify(task, workdir, variant, logsText) {
  const v = task.variantVerify?.[variant] ?? task.verify;
  if (v.type === 'fileContains') {
    const path = join(workdir, v.path);
    if (!existsSync(path)) return { success: false, detail: `missing file ${v.path}` };
    const content = readFileSync(path, 'utf8');
    const ok = content.includes(v.contains);
    return { success: ok, detail: ok ? `file contains '${v.contains}'` : `file lacks '${v.contains}' (got: ${content.slice(0, 80)})` };
  }
  if (v.type === 'command') {
    try {
      execFileSync('/bin/sh', ['-c', v.run], { cwd: workdir, stdio: 'pipe', timeout: 60_000 });
      return { success: true, detail: `command passed: ${v.run}` };
    } catch (error) {
      return { success: false, detail: `command failed: ${v.run} (${error.status ?? error.message})` };
    }
  }
  if (v.type === 'pathExists') {
    const exists = existsSync(join(workdir, v.path));
    const ok = exists === (v.shouldExist !== false);
    return { success: ok, detail: `${v.path} ${exists ? 'exists' : 'absent'} (expected ${v.shouldExist !== false ? 'exists' : 'absent'})` };
  }
  if (v.type === 'sessionLogContains') {
    const found = new RegExp(v.pattern).test(logsText);
    const ok = found === (v.shouldMatch !== false);
    return { success: ok, detail: `session log /${v.pattern}/ ${found ? 'matched' : 'not found'} (expected ${v.shouldMatch !== false ? 'match' : 'no match'})` };
  }
  if (v.type === 'allOf') {
    const parts = v.checks.map((c) => verify({ verify: c }, workdir, variant, logsText));
    const ok = parts.every((p) => p.success);
    return { success: ok, detail: parts.map((p) => `${p.success ? '✓' : '✗'} ${p.detail}`).join(' | ') };
  }
  throw new Error(`unknown verify type '${v.type}'`);
}

/* --------------------------- session metrics ---------------------- */

/** Decode only the session meta (first frame) to read the session's cwd. */
function sessionCwd(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return null;
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

/** Find session logs for a workdir: exact cwd match first (raw and
 *  realpath — macOS /var vs /private/var), then a PREFIX-CONSTRAINED
 *  fallback: only logs whose recorded cwd lives under an eval tmpdir
 *  (`dsh-muse-eval-*`) within the [start, end] window. The unconstrained
 *  "any newest log in the window" fallback once attributed a concurrently
 *  running interactive session (millions of tokens) to a boot-failed eval
 *  run — foreign sessions must never leak into metrics; a run that produced
 *  no log reports metrics=null instead. Returns ALL matches —
 *  crash-recovery tasks produce two sessions sharing the workdir. */
function findSessionLogs(workdir, start, end) {
  const root = join(HOME, 'sessions');
  if (!existsSync(root)) return [];
  const all = [];
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    let sessions;
    try { sessions = readdirSync(dirPath); } catch { continue; }
    for (const s of sessions) {
      const file = join(dirPath, s, 'session.jsonl.zstd');
      try { all.push({ file, mtime: statSync(file).mtimeMs }); } catch { /* skip */ }
    }
  }
  let real;
  try { real = realpathSync(workdir); } catch { real = workdir; }
  const byCwd = all.filter((h) => sessionCwd(h.file) === real || sessionCwd(h.file) === workdir);
  if (byCwd.length > 0) return byCwd.sort((a, b) => a.mtime - b.mtime);
  let tmpReal;
  try { tmpReal = realpathSync(tmpdir()); } catch { tmpReal = tmpdir(); }
  const isEvalLog = (h) => {
    const cwd = sessionCwd(h.file);
    return typeof cwd === 'string'
      && (cwd.startsWith(join(tmpdir(), 'dsh-muse-eval-') ) || cwd.startsWith(join(tmpReal, 'dsh-muse-eval-')));
  };
  return all.filter((h) => h.mtime >= start - 5000 && h.mtime <= end + 5000 && isEvalLog(h)).sort((a, b) => a.mtime - b.mtime);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const ZSTD_MAGIC = 0xfd2fb528;

/** Decode a concatenated-frame zstd container (the session-log format):
 *  locate frames by magic number and decompress each independently — a frame
 *  that fails validation (e.g. magic bytes inside compressed payload) is
 *  skipped, which is acceptable for metrics. */
function decompressFrames(buffer) {
  const offsets = [];
  for (let i = 4; i + 4 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i);
  }
  const chunks = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(offsets[i], end)));
    } catch { /* false-positive magic inside payload — skip */ }
  }
  return chunks.map((c) => c.toString('utf8')).join('\n');
}

const MUTATING_CMD = [
  />[>]?\s*[^\s|&]/,
  /\b(mv|cp|mkdir|touch|ln|chmod|chown)\b/,
  /\bsed\s+(-\w+\s+)*-i\b/,
  /\bgit\s+(add|commit|checkout|switch|merge|rebase|restore|stash|apply|push)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|publish)\b/,
];

/** Mirror of the guardrails mutating-command classification (deliberately an
 *  independent re-implementation — measurement must not share failure modes
 *  with the thing it measures; behavior is pinned by guardrails-labeled.json). */
function isMutatingKey(key) {
  if (/^write:|^edit:|^str[-_]replace/.test(key)) return true;
  if (!key.startsWith('bash:')) return false;
  const cmdMatch = /\{"command":"((?:[^"\\]|\\.)*)"/.exec(key);
  if (cmdMatch === null) return false;
  let command;
  try { command = JSON.parse(`"${cmdMatch[1]}"`); } catch { return false; }
  return MUTATING_CMD.some((re) => re.test(command));
}

/** Decode one session log into its raw event list (tolerates bad lines). */
function sessionEvents(file) {
  return decompressFrames(readFileSync(file))
    .split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

/**
 * Fold ONE session log into partial metrics (per-log token usage namespace:
 * turn/step keys restart across sessions, so usage maps must not be shared).
 */
function foldOneSession(file) {
  const events = sessionEvents(file);
  const usageByStep = new Map();
  let toolCalls = 0;
  let toolErrors = 0;
  let llmRetries = 0;
  const callKeys = new Map();
  /** semantic key -> successful executions, in order (exported for cross-log merge) */
  const executedKeys = [];
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
        const resultCallId = d.callId ?? d.message?.source?.callId ?? d.message?.content?.[0]?.toolCallId;
        const failed = (d.error !== undefined && d.error !== null) || d.message?.content?.[0]?.isError === true;
        if (failed) toolErrors += 1;
        const key = resultCallId === undefined ? undefined : callKeys.get(resultCallId);
        if (key !== undefined && !failed) executedKeys.push(key);
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
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  for (const u of usageByStep.values()) {
    uncachedInputTokens += u.uncachedInputTokens ?? u.inputTokens ?? 0;
    cacheReadTokens += u.cacheReadTokens ?? 0;
    cacheWriteTokens += u.cacheWriteTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
  }
  return { toolCalls, toolErrors, llmRetries, executedKeys, uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens };
}

/**
 * Fold ALL session logs of one run into metrics. Token/counter buckets are
 * summed per-log (separate usage namespaces); duplicate detection SHARES the
 * executed-key history across logs in mtime order — a write executed in
 * session A and re-executed after a crash in session B is exactly the
 * duplicate side effect t04 measures. Cache buckets are reported separately
 * so prompt-cache warmth is visible instead of silently inflating "input".
 */
function foldSessions(files) {
  const merged = { toolCalls: 0, toolErrors: 0, llmRetries: 0, duplicateSideEffects: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const executedCount = new Map();
  for (const file of files) {
    const part = foldOneSession(file);
    merged.toolCalls += part.toolCalls;
    merged.toolErrors += part.toolErrors;
    merged.llmRetries += part.llmRetries;
    merged.uncachedInputTokens += part.uncachedInputTokens;
    merged.cacheReadTokens += part.cacheReadTokens;
    merged.cacheWriteTokens += part.cacheWriteTokens;
    merged.outputTokens += part.outputTokens;
    for (const key of part.executedKeys) {
      const count = (executedCount.get(key) ?? 0) + 1;
      executedCount.set(key, count);
      if (count > 1 && isMutatingKey(key)) merged.duplicateSideEffects += 1;
    }
  }
  merged.inputTokens = merged.uncachedInputTokens + merged.cacheReadTokens + merged.cacheWriteTokens;
  merged.totalTokens = merged.inputTokens + merged.outputTokens;
  return merged;
}

/* ------------------------------- run ------------------------------ */

/** Spawn one dsh one-shot; optionally SIGKILL it once a marker file appears
 *  (crash-recovery tasks). Resolves { code, crashed }. */
function spawnDsh(variant, prompt, workdir, timeoutSec, crash, out) {
  return new Promise((res) => {
    const child = spawn('dsh', ['--profile', `eval-${variant}`, prompt], { cwd: workdir, env: process.env });
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => out.push(c));
    let crashed = false;
    let watcher;
    if (crash?.afterFile !== undefined) {
      watcher = setInterval(() => {
        if (existsSync(join(workdir, crash.afterFile))) {
          clearInterval(watcher);
          setTimeout(() => {
            crashed = true;
            child.kill('SIGKILL');
          }, crash.graceMs ?? 1500);
        }
      }, 250);
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); res({ code: 'timeout', crashed }); }, timeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (watcher !== undefined) clearInterval(watcher);
      res({ code: code ?? 'signal', crashed });
    });
  });
}

async function runTaskVariant(task, variant, timeoutSec, batch, env, round) {
  const workdir = mkdtempSync(join(tmpdir(), `dsh-muse-eval-${task.id}-${variant}-`));
  if (task.fixture !== undefined) {
    cpSync(join(EVAL_DIR, 'fixtures', task.fixture), workdir, { recursive: true });
  }
  /* behavior-difference tasks may need per-variant initial prompts (e.g. t06
   * instructs the muse arm to drive the workunit gate; vanilla has no such
   * tool, so its prompt stays capability-neutral) */
  const prompt = String(task.promptVariant?.[variant] ?? task.prompt).replaceAll('{{WORKDIR}}', workdir);
  const startedAt = Date.now();
  const out = [];

  const first = await spawnDsh(variant, prompt, workdir, task.timeoutSec ?? timeoutSec, task.crash, out);
  let crashed = first.crashed;
  let resumeCode = null;
  if (crashed && task.crash?.resumePrompt !== undefined) {
    const resumePromptRaw = task.crash.resumePrompt[variant] ?? task.crash.resumePrompt;
    const resumePrompt = String(resumePromptRaw).replaceAll('{{WORKDIR}}', workdir);
    const second = await spawnDsh(variant, resumePrompt, workdir, task.timeoutSec ?? timeoutSec, undefined, out);
    resumeCode = second.code;
  }

  const endedAt = Date.now();
  writeFileSync(join(workdir, '.dsh-output.log'), Buffer.concat(out));
  const logs = findSessionLogs(workdir, startedAt, endedAt);
  const logsText = logs.map((l) => decompressFrames(readFileSync(l.file))).join('\n');
  const v = verify(task, workdir, variant, logsText);
  const metrics = logs.length > 0 ? foldSessions(logs.map((l) => l.file)) : null;
  const result = {
    task: task.id,
    variant,
    batch,
    round,
    startedAt: new Date(startedAt).toISOString(),
    wallMs: endedAt - startedAt,
    exitCode: crashed ? 'SIGKILL(crash-injected)' : first.code,
    ...(resumeCode !== null ? { resumeExitCode: resumeCode } : {}),
    crashed,
    success: v.success && (crashed || first.code === 0) && (resumeCode === null || resumeCode === 0),
    verifyDetail: v.detail,
    workdir,
    env: { ...env, profileHash: profileHash(variant) },
    metrics,
    outputTail: Buffer.concat(out).toString('utf8').split('\n').slice(-15).join('\n'),
  };
  const file = join(EVAL_DIR, 'results', `${task.id}--${variant}--${startedAt}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(`[eval] ${task.id} [${variant}]${task.crash ? (crashed ? ' (crash injected + resumed)' : ' (crash NOT triggered!)') : ''} success=${result.success} wall=${Math.round(result.wallMs / 1000)}s tokens=${metrics?.totalTokens ?? '?'} tools=${metrics?.toolCalls ?? '?'} dup=${metrics?.duplicateSideEffects ?? '?'} (${v.detail})`);
  return result;
}

/* ------------------------------ main ------------------------------ */

const args = parseArgs(process.argv);
const tasks = loadTasks(args.task, args.layer);
const variants = args.variant === 'both' ? ['vanilla', 'muse'] : [args.variant];
const batch = `b_${new Date().toISOString().replaceAll(':', '-')}`;
const env = collectEnv();
console.log(`[eval] batch ${batch} — ${tasks.length} task(s) × ${variants.join('/')} × ${args.repeat} round(s), env: dsh ${env.dshVersion}, model ${env.model}`);
for (const task of tasks) {
  for (let round = 1; round <= args.repeat; round += 1) {
    /* interleave arms within each round: time drift is shared, not confounded */
    for (const variant of variants) {
      await runTaskVariant(task, variant, args.timeout, batch, env, round);
    }
  }
}
console.log('[eval] results written to eval/results/ — run `node eval/bin/compare.mjs` to aggregate');
