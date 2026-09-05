/**
 * dsh-muse-bridge — Muse observability bridge.
 *
 * The muse plugins deliberately do not append custom session events (unknown
 * event types would make the log unresumable), so everything the model does
 * through them lives in the transcript as ordinary `tool/call` +
 * `tool/result` pairs. This bridge folds those pairs — plus the write/shell
 * calls that dsh-guardrails intercepts — into ONE pure-derived session
 * projection (`muse`) that the web client renders as the Muse 工作台 view.
 *
 * Fold contract (session-projection): `apply` is a pure transition over
 * committed events; uninterested events MUST return the same state reference.
 * No clocks, no randomness, no closure scratch — even the call→result join
 * (`pending`) lives inside the fold state so a replay rebuilds it identically.
 * The `view` strips the join table before the state leaves the host.
 *
 * @module dsh-muse-bridge
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'muse-bridge';

/* ------------------------------------------------------------------------ */
/* Tool classification (mirrors dsh-guardrails; display-grade only)         */
/* ------------------------------------------------------------------------ */

const MUSE_TOOLS = new Set(['workunit', 'effect', 'evidence', 'eval_report', 'skill_workshop']);

/** File-writing tools -> the argument carrying the target path. */
const WRITE_TOOLS = {
  write: 'file_path',
  edit: 'file_path',
  'str-replace-editor': 'path',
  'str_replace_editor': 'path',
};

const SHELL_TOOLS = new Set(['bash', 'bash_persistent', 'pwsh', 'pwsh_persistent']);

/* Same regexes as guardrails DEFAULT_MUTATING/DEFAULT_DANGEROUS — used only
 * to decide whether a shell call is worth showing as a side effect. */
const SHELL_EFFECT_PATTERNS = [
  String.raw`>[>]?\s*[^\s|&]`,
  String.raw`\b(mv|cp|mkdir|touch|ln|chmod|chown)\b`,
  String.raw`\bsed\s+(-\w+\s+)*-i\b`,
  String.raw`\bgit\s+(add|commit|checkout|switch|merge|rebase|restore|stash|apply)\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update)\b`,
  String.raw`(?:^|[|;&\n])\s*(rm|git\s+push|git\s+reset\s+--hard|sudo|npm\s+publish|pnpm\s+publish|yarn\s+publish|shutdown|reboot|halt)\b`,
  String.raw`(?:^|[|;&\n])\s*curl\b[^\n|;&]*-X\s*(POST|PUT|DELETE|PATCH)\b`,
].map((source) => new RegExp(source));

/* ------------------------------------------------------------------------ */
/* Projection state                                                          */
/* ------------------------------------------------------------------------ */

const stateSchema = z.object({
  /** Fold counter — display ordering; never a wall clock. */
  seq: z.number(),
  /** The workunit this session is currently driving (latest tool-reported snapshot). */
  workunit: z.unknown().nullable(),
  /** All units ever seen this session, newest first (id/status/objective). */
  units: z.array(z.unknown()),
  /** Side-effect entries: explicit `effect` calls + guardrails auto-ledgered writes. */
  effects: z.array(z.unknown()),
  /** Evidence items, newest first. */
  evidence: z.array(z.unknown()),
  /** Latest eval_report record/summary. */
  eval: z.unknown().nullable(),
  /** Muse-relevant tool activity feed, oldest -> newest. */
  activity: z.array(z.unknown()),
  /** Aggregate counters for the header strip. */
  stats: z.record(z.string(), z.number()),
  /** callId -> call join table; stripped by the wire view. */
  pending: z.record(z.string(), z.unknown()),
});

const MAX_EFFECTS = 25;
const MAX_EVIDENCE = 25;
const MAX_ACTIVITY = 60;
const MAX_UNITS = 10;

function initialState() {
  return {
    seq: 0,
    workunit: null,
    units: [],
    effects: [],
    evidence: [],
    eval: null,
    activity: [],
    stats: { museCalls: 0, writeOps: 0, executed: 0, failed: 0, denied: 0 },
    pending: {},
  };
}

/* ------------------------------------------------------------------------ */
/* Helpers (all pure)                                                        */
/* ------------------------------------------------------------------------ */

function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Extract the concatenated text of a ToolResultMessage's content blocks. */
function resultText(message) {
  const block = message?.content?.[0];
  if (!block || typeof block !== 'object') return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

function isErrorResult(message, error) {
  if (error !== undefined) return true;
  return message?.content?.[0]?.isError === true;
}

/* Session logs persist the RENDERED tool text, not the structured value —
 * so every muse plugin appends a compact `<!--muse:<tool> {json}-->` trailer
 * to its render. Parse that envelope first; fall back to a bare-JSON body
 * for sessions recorded before the trailer existed. */
const TRAILER_RE = /<!--muse:(\w+) (\{[\s\S]*?\})-->/;

function payloadFrom(text) {
  const match = TRAILER_RE.exec(text);
  if (match !== null) {
    const trailer = parseJson(match[2]);
    if (trailer !== null) return trailer;
  }
  return parseJson(text);
}

/**
 * Backfill parser for pre-trailer sessions: their workunit results persisted
 * as rendered prose only. Rebuilds the projection-relevant fields from that
 * stable format (artifacts stay unrecoverable — the render only has a count).
 */
const WU_HEAD_RE = /^WorkUnit (\S+) \[(\w+)\] rev=\d+ plan v(\d+)$/m;
const WU_STEP_RE = /^- (\S+) \[(pending|in_progress|done|failed|skipped)\] (.+)$/gm;

function parseWorkunitRender(text) {
  const head = WU_HEAD_RE.exec(text);
  if (head === null) return null;
  const objective = /^Objective: (.+)$/m.exec(text)?.[1] ?? null;
  const steps = [];
  WU_STEP_RE.lastIndex = 0;
  let match;
  while ((match = WU_STEP_RE.exec(text)) !== null) {
    const parts = match[3].split(' — ');
    steps.push({
      id: match[1],
      status: match[2],
      title: parts[0],
      note: parts.length > 1 ? parts.slice(1).join(' — ') : null,
    });
  }
  const verification = /^Verification: (.+)$/m.exec(text)?.[1];
  return {
    ok: true,
    unit: {
      id: head[1],
      status: head[2],
      objective,
      constraints: [],
      planVersion: Number(head[3]),
      steps,
      budget: null,
      artifacts: [],
      verification: verification !== undefined ? { method: verification } : null,
    },
  };
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Would guardrails ledger this shell command? (display-grade re-derivation) */
function shellEffect(command) {
  if (command === '') return null;
  return SHELL_EFFECT_PATTERNS.some((re) => re.test(command))
    ? { action: 'shell.exec', resource: truncate(command, 100) }
    : null;
}

function describeMuseCall(name, args) {
  const op = args?.op;
  switch (name) {
    case 'workunit': {
      if (op === 'create') return `workunit create: ${truncate(args?.objective, 70)}`;
      if (op === 'step') return `workunit step ${args?.stepId ?? ''} → ${args?.status ?? ''}`;
      if (op === 'plan') return `workunit plan v${args?.version ?? '?'} (${Array.isArray(args?.steps) ? args.steps.length : '?'} steps)`;
      if (op === 'artifact') return `workunit artifact: ${truncate(args?.path ?? '', 70)}`;
      return `workunit ${op ?? ''}`;
    }
    case 'effect':
      return op === 'propose' ? `effect propose: ${truncate(args?.resource ?? '', 60)}` : `effect ${op ?? ''}`;
    case 'evidence':
      return op === 'register' ? `evidence: ${truncate(args?.claim ?? '', 70)}` : `evidence ${op ?? ''}`;
    case 'eval_report':
      return `eval ${op ?? ''}`;
    case 'skill_workshop':
      return `skill ${op ?? ''}`;
    default:
      return name;
  }
}

/* ------------------------------------------------------------------------ */
/* Muse tool result folds                                                    */
/* ------------------------------------------------------------------------ */

function briefUnit(unit) {
  return {
    id: unit.id,
    status: unit.status,
    objective: truncate(unit.objective, 80),
    updatedAt: unit.updatedAt ?? null,
  };
}

function applyWorkunitResult(state, payload) {
  let next = state;
  if (payload?.ok && payload.unit && typeof payload.unit === 'object') {
    const unit = payload.unit;
    next = {
      ...next,
      workunit: {
        id: unit.id,
        status: unit.status,
        objective: unit.objective,
        constraints: unit.constraints ?? [],
        planVersion: unit.planVersion,
        steps: unit.steps ?? [],
        budget: unit.budget ?? null,
        artifacts: unit.artifacts ?? [],
        verification: unit.verification ?? null,
        failureClasses: unit.failureClasses ?? [],
        updatedAt: unit.updatedAt ?? null,
      },
      units: [briefUnit(unit), ...next.units.filter((candidate) => candidate.id !== unit.id)].slice(0, MAX_UNITS),
    };
  }
  if (Array.isArray(payload?.units)) {
    const seen = new Set(next.units.map((candidate) => candidate.id));
    for (const unit of payload.units) {
      if (unit?.id && !seen.has(unit.id)) {
        next = { ...next, units: [...next.units, briefUnit(unit)] };
        seen.add(unit.id);
      }
    }
    next = { ...next, units: next.units.slice(0, MAX_UNITS) };
  }
  return next;
}

function applyEffectResult(state, payload) {
  if (!payload?.ok) return state;
  let next = state;
  const upsert = (entry) => {
    if (!entry?.idempotencyKey) return;
    const rest = next.effects.filter((candidate) => candidate.key !== entry.idempotencyKey);
    next = {
      ...next,
      effects: [
        {
          key: entry.idempotencyKey,
          action: entry.action,
          resource: truncate(entry.resource, 100),
          summary: entry.summary ? truncate(entry.summary, 100) : null,
          status: entry.status,
          origin: 'explicit',
          approval: entry.approval?.who ?? null,
          at: entry.updatedAt,
        },
        ...rest,
      ].slice(0, MAX_EFFECTS),
    };
  };
  if (payload.entry) upsert(payload.entry);
  if (Array.isArray(payload.entries)) for (const entry of payload.entries) upsert(entry);
  return next;
}

function applyEvidenceResult(state, payload) {
  if (!payload?.ok) return state;
  let next = state;
  const upsert = (item) => {
    if (!item?.id) return;
    const rest = next.evidence.filter((candidate) => candidate.id !== item.id);
    next = {
      ...next,
      evidence: [
        {
          id: item.id,
          kind: item.kind,
          trust: item.trust,
          claim: truncate(item.claim, 90),
          hash: item.hash ? String(item.hash).slice(0, 12) : null,
          freshUntil: item.freshUntil ?? null,
          capturedAt: item.capturedAt,
        },
        ...rest,
      ].slice(0, MAX_EVIDENCE),
    };
  };
  if (payload.item) upsert(payload.item);
  if (Array.isArray(payload.items)) for (const item of payload.items) upsert(item);
  return next;
}

function applyEvalResult(state, payload) {
  if (!payload?.ok) return state;
  const record = payload.record ?? null;
  const summary = payload.summary ?? null;
  if (record === null && summary === null) return state;
  return { ...state, eval: { record, summary } };
}

/* ------------------------------------------------------------------------ */
/* The fold                                                                  */
/* ------------------------------------------------------------------------ */

/** Wire view: everything except the internal call→result join table. */
const viewSchema = stateSchema.omit({ pending: true });
function toView(state) {
  const { pending, ...view } = state;
  return view;
}

/* ------------------------------------------------------------------------ */
/* Native file reveal in OS file manager (Finder / Explorer / File Manager)  */
/* ------------------------------------------------------------------------ */

export function revealPathInFinder(rawPath, options = {}) {
  const {
    cwd = process.cwd(),
    platform = process.platform,
    exec = execFile,
    fsExists = existsSync,
    fsStat = statSync,
    home = homedir(),
  } = options;

  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return Promise.resolve({
      ok: false,
      error: { code: 'bad-request', message: 'Path must be a non-empty string' },
    });
  }

  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const trimmed = rawPath.trim();
  const expanded = trimmed.replace(/^~(?=$|\/|\\)/, home);
  const fullPath = pathMod.isAbsolute(expanded) ? pathMod.resolve(expanded) : pathMod.resolve(cwd, expanded);

  let target = fullPath;
  let isDir = false;

  if (fsExists(target)) {
    try {
      isDir = fsStat(target).isDirectory();
    } catch (_) {
      isDir = false;
    }
  } else {
    // If target does not exist, find the closest existing ancestor directory
    let cur = pathMod.dirname(target);
    while (cur && cur !== pathMod.dirname(cur)) {
      if (fsExists(cur)) {
        target = cur;
        isDir = true;
        break;
      }
      cur = pathMod.dirname(cur);
    }
    if (!isDir && !fsExists(target)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'not-found', message: `Target path does not exist and no ancestor directory found: ${rawPath}` },
      });
    }
  }

  let cmd = 'open';
  let args = [];
  if (platform === 'darwin') {
    cmd = 'open';
    args = isDir ? [target] : ['-R', target];
  } else if (platform === 'win32') {
    cmd = 'explorer.exe';
    args = isDir ? [target] : [`/select,${target}`];
  } else {
    cmd = 'xdg-open';
    args = [isDir ? target : dirname(target)];
  }

  return new Promise((res) => {
    exec(cmd, args, (err) => {
      if (err) {
        return res({
          ok: false,
          error: { code: 'exec-error', message: err.message },
        });
      }
      res({ ok: true, value: { target, isDir } });
    });
  });
}

export function apply(ctx) {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'muse',
      stateSchema,
      init: initialState,
      apply: (state, event) => {
        if (event.type === 'tool/call') {
          const data = event.data;
          const tool = data.name;
          const args = parseJson(data.arguments) ?? {};

          if (MUSE_TOOLS.has(tool)) {
            const seq = state.seq + 1;
            const label = describeMuseCall(tool, args);
            return {
              ...state,
              seq,
              pending: { ...state.pending, [data.callId]: { name: tool, label, autoEffect: false } },
              stats: { ...state.stats, museCalls: state.stats.museCalls + 1 },
              activity: [...state.activity, { seq, turn: data.turn, step: data.step, tool, kind: 'muse', label, status: 'running' }].slice(-MAX_ACTIVITY),
            };
          }

          let effect = null;
          if (Object.hasOwn(WRITE_TOOLS, tool)) {
            const resource = String(args[WRITE_TOOLS[tool]] ?? 'unknown');
            effect = { action: tool === 'write' ? 'fs.write' : 'fs.edit', resource };
          } else if (SHELL_TOOLS.has(tool)) {
            effect = shellEffect(String(args.command ?? ''));
          }
          if (effect === null) return state;

          const seq = state.seq + 1;
          const label = `${effect.action} ${effect.resource}`;
          return {
            ...state,
            seq,
            pending: { ...state.pending, [data.callId]: { name: tool, label, autoEffect: true } },
            effects: [
              {
                key: `auto:${data.callId}`,
                action: effect.action,
                resource: effect.resource,
                status: 'executing',
                origin: 'auto',
                approval: 'auto:policy',
                at: null,
              },
              ...state.effects,
            ].slice(0, MAX_EFFECTS),
            stats: { ...state.stats, writeOps: state.stats.writeOps + 1 },
            activity: [...state.activity, { seq, turn: data.turn, step: data.step, tool, kind: 'write', label, status: 'running' }].slice(-MAX_ACTIVITY),
          };
        }

        if (event.type === 'tool/result') {
          const data = event.data;
          const block = data.message?.content?.[0];
          const call = state.pending[block?.toolCallId];
          if (call === undefined) return state;

          const { [block.toolCallId]: consumed, ...restPending } = state.pending;
          const failed = isErrorResult(data.message, data.error);
          const text = resultText(data.message);
          const denied = failed && /duplicate side effect|already executed|guardrails:/.test(text);
          let payload = payloadFrom(text);
          if (payload === null && call.name === 'workunit') payload = parseWorkunitRender(text);

          let next = { ...state, pending: restPending };
          if (call.name === 'workunit') next = applyWorkunitResult(next, payload);
          else if (call.name === 'effect') next = applyEffectResult(next, payload);
          else if (call.name === 'evidence') next = applyEvidenceResult(next, payload);
          else if (call.name === 'eval_report') next = applyEvalResult(next, payload);

          if (call.autoEffect) {
            const head = next.effects[0];
            if (head?.origin === 'auto') {
              const status = denied ? 'denied' : failed ? 'failed' : 'executed';
              next = {
                ...next,
                effects: [{ ...head, status, note: denied ? truncate(text, 140) : null }, ...next.effects.slice(1)],
                stats: {
                  ...next.stats,
                  executed: next.stats.executed + (failed ? 0 : 1),
                  failed: next.stats.failed + (failed && !denied ? 1 : 0),
                  denied: next.stats.denied + (denied ? 1 : 0),
                },
              };
            }
          }

          /* replace the running row with its settled twin */
          const activity = next.activity.slice();
          for (let index = activity.length - 1; index >= 0; index -= 1) {
            const row = activity[index];
            if (row.label === call.label && row.status === 'running') {
              activity[index] = { ...row, status: denied ? 'denied' : failed ? 'error' : 'ok' };
              break;
            }
          }
          return { ...next, activity };
        }

        return state;
      },
      wire: { viewSchema, view: toView },
      // Rebuild cached projections whose optional fields contained undefined.
      // Forwarded host events in DSH 0.1.2 require lossless JSON values.
      stateVersion: 2,
    });
  });

  ctx.inject(['connection'], (connCtx) => {
    if (!connCtx?.connection?.rpc?.handle) return;
    connCtx.connection.rpc.handle(
      '/muse-file',
      async (endpoint, payload) => {
        if (endpoint !== 'reveal') {
          return { ok: false, error: { code: 'bad-request', message: `muse-file: unknown endpoint ${JSON.stringify(endpoint)}` } };
        }
        return revealPathInFinder(payload?.path, { cwd: payload?.cwd });
      },
      { authority: 'loopback' },
    );
  });
}
