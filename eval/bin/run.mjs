#!/usr/bin/env node
/**
 * eval runner — execute one benchmark task under one variant profile and
 * record comparable metrics.
 *
 *   node eval/bin/run.mjs <taskId|all> [--variant vanilla|muse|both] [--timeout 300]
 *
 * A run:
 *   1. creates a fresh tmp workdir (fixtures are copied in when declared)
 *   2. spawns `dsh --profile eval-<variant> "<prompt>"` with cwd=workdir
 *   3. runs the task's verifier (fileContains | command)
 *   4. folds the session log (session.jsonl.zstd, node:zlib) into metrics:
 *      tokens (one sample per turn:step, last wins), tool calls, tool errors,
 *      llm retries, duplicate side effects (same tool+canonical args > 1×)
 *   5. writes eval/results/<task>--<variant>--<ts>.json
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_DIR = join(ROOT, 'eval');
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { task: argv[2], variant: 'both', timeout: 300 };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--variant') args.variant = argv[++i];
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.task) throw new Error('usage: run.mjs <taskId|all> [--variant vanilla|muse|both]');
  return args;
}

function loadTasks(which) {
  const dir = join(EVAL_DIR, 'tasks');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const tasks = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  if (which === 'all') return tasks;
  const task = tasks.find((t) => t.id === which);
  if (!task) throw new Error(`task '${which}' not found in ${dir}`);
  return [task];
}

/* ------------------------------ verify ---------------------------- */

function verify(task, workdir) {
  const v = task.verify;
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

/** Find the session log for a workdir: exact cwd match first, then the
 *  newest log inside the [start, end] time window as a fallback. */
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
  return all.filter((h) => h.mtime >= start - 5000 && h.mtime <= end + 5000).sort((a, b) => a.mtime - b.mtime);
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
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
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

function foldSession(file) {
  const events = decompressFrames(readFileSync(file))
    .split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const usageByStep = new Map();
  let toolCalls = 0;
  let toolErrors = 0;
  let llmRetries = 0;
  /* duplicates count EXECUTIONS (a call paired with a non-error result), not
   * attempts — a guardrail-denied retry is a prevented duplicate, not an
   * executed one. */
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

/* ------------------------------- run ------------------------------ */

function runTaskVariant(task, variant, timeoutSec) {
  const workdir = mkdtempSync(join(tmpdir(), `dsh-muse-eval-${task.id}-${variant}-`));
  if (task.fixture !== undefined) {
    cpSync(join(EVAL_DIR, 'fixtures', task.fixture), workdir, { recursive: true });
  }
  const prompt = task.prompt.replaceAll('{{WORKDIR}}', workdir);
  const startedAt = Date.now();

  const outputFile = join(workdir, '.dsh-output.log');
  const out = [];
  const child = spawn('dsh', ['--profile', `eval-${variant}`, prompt], { cwd: workdir, env: process.env });
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => out.push(c));
  const exitCode = new Promise((res) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); res('timeout'); }, timeoutSec * 1000);
    child.on('close', (code) => { clearTimeout(timer); res(code ?? 'signal'); });
  });

  return exitCode.then((code) => {
    const endedAt = Date.now();
    writeFileSync(outputFile, Buffer.concat(out));
    const v = verify(task, workdir);
    const logs = findSessionLogs(workdir, startedAt, endedAt);
    const metrics = logs.length > 0 ? foldSession(logs[logs.length - 1].file) : null;
    const result = {
      task: task.id,
      variant,
      startedAt: new Date(startedAt).toISOString(),
      wallMs: endedAt - startedAt,
      exitCode: code,
      success: v.success && code === 0,
      verifyDetail: v.detail,
      workdir,
      metrics,
      outputTail: Buffer.concat(out).toString('utf8').split('\n').slice(-15).join('\n'),
    };
    const file = join(EVAL_DIR, 'results', `${task.id}--${variant}--${startedAt}.json`);
    writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
    console.log(`[eval] ${task.id} [${variant}] success=${result.success} wall=${Math.round(result.wallMs / 1000)}s tokens=${metrics?.totalTokens ?? '?'} tools=${metrics?.toolCalls ?? '?'} dup=${metrics?.duplicateSideEffects ?? '?'} (${v.detail})`);
    return result;
  });
}

/* ------------------------------ main ------------------------------ */

const args = parseArgs(process.argv);
const tasks = loadTasks(args.task);
const variants = args.variant === 'both' ? ['vanilla', 'muse'] : [args.variant];
for (const task of tasks) {
  for (const variant of variants) {
    await runTaskVariant(task, variant, args.timeout);
  }
}
console.log('[eval] results written to eval/results/ — run `node eval/bin/compare.mjs` to aggregate');
