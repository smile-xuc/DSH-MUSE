/**
 * dsh-guardrails — the four-position guardrail layer (Muse Harness 控制面).
 *
 * The four checks live at four positions because they catch different
 * failures; merging them into one "may the agent run?" switch misses most of
 * them:
 *
 *   1. per-turn (systemPrompt.context `muse:task-frame`)
 *      The current WorkUnit frame rides every model step: objective, open
 *      steps, budget consumption, checkpoint age. Drift shows up against the
 *      immutable objective instead of being discovered after the fact.
 *
 *   2. pre-execution (`tools/pre-execute` waterfall)
 *      Every tool call is classified: read-only calls pass through;
 *      side-effecting calls are ledgered (idempotency key derived from
 *      tool+action+resource+params), dangerous calls are gated on human
 *      approval. A call whose idempotency key already EXECUTED is denied as
 *      a duplicate — that is the "same operation ran twice" tripwire.
 *
 *   3. pre-side-effect approval (`ctx.approval`)
 *      Dangerous operations ask. Approval outcomes are recorded on the
 *      ledger entry (who/scope/when). When no approval answerer exists
 *      (policy `never`, headless), `askFallback` decides — default deny.
 *
 *   4. post-delivery (`tools/post-execute` on workunit complete)
 *      Completing a WorkUnit with declared file artifacts that do not exist
 *      on disk is blocked with corrective feedback — tool success is not
 *      delivery.
 *
 * Everything the layer does is recorded in the effect ledger; the eval layer
 * turns that into duplicate-effect and unapproved-effect metrics.
 *
 * @module dsh-guardrails
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import z from '@deepseek-ai/schemastery';

/** Canonical JSON for hashing: stable key order, no whitespace. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** SHA-256 hex of the canonical parameter payload (kept in sync with dsh-effect-ledger). */
function hashParams(params) {
  return createHash('sha256').update(canonicalJson(params ?? null)).digest('hex');
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'guardrails';

/** Hard dependencies. */
export const inject = ['tools', 'systemPrompt', 'workunits', 'effectLedger', 'approval'];

/** Bash commands that always require human approval. */
/* Anchored at a command position (start of string/line, or after a shell
 * separator) so a quoted mention like printf '%s' 'rm -rf x' does not trip
 * the rule, while real invocations (including pipes and &&-chains) do. */
const DEFAULT_DANGEROUS = [
  String.raw`(?:^|[|;&\n])\s*rm\s+(-\w*\s+)*-?\w*[rf]\w*\b`,  // rm -rf and friends
  String.raw`(?:^|[|;&\n])\s*git\s+push\b`,
  String.raw`(?:^|[|;&\n])\s*git\s+reset\s+--hard\b`,
  String.raw`(?:^|[|;&\n])\s*(npm|pnpm|yarn)\s+publish\b`,
  String.raw`(?:^|[|;&\n])\s*curl\b[^\n|;&]*-X\s*(POST|PUT|DELETE|PATCH)\b`,
  String.raw`(?:^|[|;&\n])\s*sudo\b`,
  String.raw`(?:^|[|;&\n])\s*(shutdown|reboot|halt)\b`,
  String.raw`(?:^|[|;&\n])\s*kill(all)?\s+-9\b`,
];

/** Bash commands that mutate state and are ledgered with auto-approval. */
const DEFAULT_MUTATING = [
  String.raw`>[>]?\s*[^\s|&]`,                          // redirection writes
  String.raw`\b(mv|cp|mkdir|touch|ln|chmod|chown)\b`,
  String.raw`\bsed\s+(-\w+\s+)*-i\b`,
  String.raw`\bgit\s+(add|commit|checkout|switch|merge|rebase|restore|stash|apply)\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update)\b`,
];

/** File-writing tool names and where their target path lives in arguments. */
const WRITE_TOOLS = {
  write: 'file_path',
  edit: 'file_path',
  'str-replace-editor': 'path',
  'str_replace_editor': 'path',
};

/** Schemastery config; every key overridable from the loader row. */
export const Config = z.object({
  /** Extra dangerous-command regexes (merged over the built-in list). */
  extraDangerousPatterns: z.array(z.string()).default([]),
  /** Extra mutating-command regexes (merged over the built-in list). */
  extraMutatingPatterns: z.array(z.string()).default([]),
  /** What to do when approval is required but no answerer exists. */
  askFallback: z.union(['deny', 'auto']).default('deny'),
  /** Ledger file-writing tool calls. */
  ledgerFileWrites: z.boolean().default(true),
  /** Ledger mutating bash commands. */
  ledgerBashMutations: z.boolean().default(true),
  /** Block workunit completion when declared file artifacts are missing. */
  deliveryCheck: z.boolean().default(true),
  /** Inject the live WorkUnit frame into every model step. */
  taskFrame: z.boolean().default(true),
});

/* ------------------------------------------------------------------------ */
/* Classification                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Classify one tool execution. Returns the effect descriptor or undefined
 * for read-only/internal calls.
 */
function classify(exec, dangerous, mutating, config) {
  const tool = exec.name;
  const args = exec.arguments ?? {};

  if (Object.hasOwn(WRITE_TOOLS, tool)) {
    if (!config.ledgerFileWrites) return undefined;
    const resource = String(args[WRITE_TOOLS[tool]] ?? 'unknown');
    return {
      action: tool === 'write' ? 'fs.write' : 'fs.edit',
      resource,
      summary: `${tool} ${resource}`,
      approval: 'auto',
      rule: 'file-write',
    };
  }

  if (tool === 'bash' || tool === 'bash_persistent' || tool === 'pwsh' || tool === 'pwsh_persistent') {
    const command = String(args.command ?? '');
    if (command === '') return undefined;
    if (dangerous.some((re) => re.test(command))) {
      return {
        action: 'shell.exec',
        resource: truncate(command, 120),
        summary: `dangerous: ${truncate(command, 80)}`,
        approval: 'ask',
        rule: 'dangerous-command',
      };
    }
    if (config.ledgerBashMutations && mutating.some((re) => re.test(command))) {
      return {
        action: 'shell.exec',
        resource: truncate(command, 120),
        summary: truncate(command, 80),
        approval: 'auto',
        rule: 'mutating-command',
      };
    }
    return undefined; // read-only shell
  }

  return undefined;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The semantic subset of arguments that defines the operation's identity. */
function semanticParams(exec) {
  const args = exec.arguments ?? {};
  switch (exec.name) {
    case 'bash':
    case 'bash_persistent':
    case 'pwsh':
    case 'pwsh_persistent':
      return { command: args.command ?? '' };
    case 'write':
      return { file_path: args.file_path ?? '', content: args.content ?? '' };
    case 'edit':
      return { file_path: args.file_path ?? '', old_string: args.old_string ?? '', new_string: args.new_string ?? '' };
    case 'str-replace-editor':
    case 'str_replace_editor':
      return { path: args.path ?? '', old_str: args.old_str ?? args.old_string ?? '', new_str: args.new_str ?? args.new_string ?? '' };
    default:
      return args;
  }
}

/** Idempotency key for one classified execution (cosmetic args like
 *  description/timeout do NOT change the key — that is what makes a retry
 *  of the same operation collide with the original). */
function effectKey(exec, effect) {
  return `auto:${exec.name}:${effect.action}:${effect.resource}:${hashParams(semanticParams(exec))}`;
}

/* ------------------------------------------------------------------------ */
/* apply                                                                     */
/* ------------------------------------------------------------------------ */

export function apply(ctx, config) {
  const dangerous = [...DEFAULT_DANGEROUS, ...config.extraDangerousPatterns].map((p) => new RegExp(p));
  const mutating = [...DEFAULT_MUTATING, ...config.extraMutatingPatterns].map((p) => new RegExp(p));

  /* ---- Position 1: the live task frame in every model step -------------- */
  if (config.taskFrame) {
    ctx.systemPrompt.context({
      name: 'muse:task-frame',
      order: 115,
      text: (context) => {
        const sessionId = context.agent?.session.id;
        if (sessionId === undefined) return '';
        const workunits = ctx.workunits;
        if (workunits === undefined) return '';
        /* sync peek: the frame never blocks prompt assembly on storage I/O;
           on a cold process the first step warms the domain, later steps
           see the resumed unit. */
        const unit = workunits.peekCurrent(sessionId);
        if (unit === undefined || unit.status === 'done' || unit.status === 'cancelled' || unit.status === 'failed') return '';
        const open = unit.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress');
        const budget = unit.budget.maxTokens !== undefined
          ? ` tokens ${unit.budget.spentTokens}/${unit.budget.maxTokens}${unit.budget.spentTokens >= unit.budget.maxTokens ? ' — BUDGET EXCEEDED: wrap up, checkpoint and report' : ''}`
          : '';
        return [
          `WorkUnit ${unit.id} [${unit.status}] plan v${unit.planVersion} — objective: ${unit.objective}`,
          unit.constraints.length > 0 ? `Constraints: ${unit.constraints.join(' | ')}` : '',
          `Open steps: ${open.length === 0 ? '(none)' : open.map((s) => `${s.id}(${s.status})`).join(', ')}.${budget}`,
        ].filter((line) => line !== '').join('\n');
      },
    });
  }

  /* ---- Positions 2+3: pre-execution rules and the side-effect gate ------ */
  ctx.on('tools/pre-execute', async (exec, next) => {
    const effect = classify(exec, dangerous, mutating, config);
    if (effect === undefined) return next();
    const ledger = ctx.effectLedger;
    const sessionId = exec.agent?.session.id;
    if (ledger === undefined || sessionId === undefined) return next();

    const key = effectKey(exec, effect);

    /* Duplicate guard: an identical effect already executed. */
    const existing = await ledger.get(key);
    if (existing !== undefined && existing.status === 'executed') {
      return {
        kind: 'deny',
        reason: `guardrails: this exact effect already executed at ${new Date(existing.result?.at ?? existing.updatedAt).toISOString()} (idempotency key '${key}'). Retrying the identical operation is a duplicate side effect. If you intend a NEW change, change the parameters (they are part of the key); if you are resuming after a crash, treat the operation as done and continue.`,
      };
    }

    const workunitId = await ctx.workunits?.currentId(sessionId);
    const { entry, fresh } = await ledger.propose({
      idempotencyKey: key,
      sessionId,
      ...(workunitId !== undefined ? { workunitId } : {}),
      tool: exec.name,
      action: effect.action,
      resource: effect.resource,
      summary: effect.summary,
      params: semanticParams(exec),
    });
    if (fresh && workunitId !== undefined) await ctx.workunits.linkEffect(workunitId, key);

    if (effect.approval === 'ask') {
      let outcome = 'unavailable';
      try {
        outcome = await ctx.approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: `[guardrails/${effect.rule}] ${effect.summary}`,
          signal: exec.signal,
        });
      } catch {
        outcome = 'unavailable';
      }
      if (outcome === 'allowed-once') {
        await ledger.approve(key, { who: 'user', scope: effect.rule });
        return next();
      }
      if (outcome === 'unavailable' && config.askFallback === 'auto') {
        await ledger.approve(key, { who: 'auto:ask-fallback', scope: effect.rule });
        return next();
      }
      return {
        kind: 'deny',
        reason: `guardrails: '${effect.summary}' requires human approval (rule '${effect.rule}') and approval was ${outcome}. Ledger entry '${key}' records this rejected attempt (check it with effect op=check).`,
      };
    }

    await ledger.approve(key, { who: 'auto:policy', scope: effect.rule });
    return next();
  });

  /* ---- Result recording: every ledgered call reports its outcome -------- */
  ctx.on('tools/result', (exec, result) => {
    void (async () => {
      try {
        const effect = classify(exec, dangerous, mutating, config);
        if (effect === undefined) return;
        const ledger = ctx.effectLedger;
        if (ledger === undefined) return;
        const key = effectKey(exec, effect);
        const stored = await ledger.get(key);
        if (stored === undefined || stored.status === 'executed' || stored.status === 'rolled_back') return;
        const isError = result?.isError === true;
        const note = typeof result?.error?.message === 'string' ? truncate(result.error.message, 200) : undefined;
        await ledger.markExecuted(key, { ok: !isError, ...(note !== undefined ? { note } : {}) });
      } catch {
        /* observation must never break the tool pipeline */
      }
    })();
  });

  /* ---- Position 4: post-delivery verification --------------------------- */
  if (config.deliveryCheck) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next();
      if (exec.name !== 'workunit' || exec.arguments?.op !== 'complete') return downstream;
      if (downstream.kind === 'block') return downstream;
      /* the raw tool output value rides on the dispatched result, not on the
         accept decision — read artifacts from there. */
      const value = result?.value;
      if (value?.ok !== true || value.unit === undefined) return downstream;
      const missing = value.unit.artifacts.filter((a) => typeof a.path === 'string' && a.path !== '' && !existsSync(a.path));
      if (missing.length === 0) return downstream;
      return {
        kind: 'block',
        feedback: `guardrails: completion blocked — ${missing.length} declared artifact(s) do not exist on disk: ${missing.map((a) => `${a.id} -> ${a.path}`).join(', ')}. Tool success is not delivery: create the artifacts, fix their paths, or remove the declarations, then complete again.`,
      };
    });
  }

  ctx.systemPrompt.section({
    name: 'muse:guardrails',
    order: 120,
    text: [
      '## Guardrails',
      'Side-effecting tool calls are ledgered automatically with an idempotency key derived from the exact parameters.',
      'An identical repeat is DENIED as a duplicate side effect — after a crash, check the ledger (effect op=list/check) instead of blindly re-running.',
      'Dangerous operations (destructive shell, pushes, publishes, external mutation) require human approval; when no approval channel exists they are denied.',
      'Completing a WorkUnit whose declared artifacts are missing on disk is blocked.',
    ].join('\n'),
  });
}
