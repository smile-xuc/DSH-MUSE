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
/* Anchored at a command position: start of string/line, after a shell
 * separator, or inside command substitution (`$(` / backtick — written \x60
 * because String.raw keeps a literal backslash before a backtick). The anchor
 * means a quoted mention like printf '%s' 'rm -rf x' does not trip the rule,
 * while real invocations (pipes, &&-chains, $(…) evasions) do. */
export const DEFAULT_DANGEROUS = [
  String.raw`(?:^|[|;&\n]|\$\(|\x60)\s*rm\s+(-\w*\s+)*-?\w*[rf]\w*\b`,  // rm -rf and friends
  String.raw`(?:^|[|;&\n]|\$\(|\x60)\s*git\s+(?:-\w+\s+\S+\s+|-\w+\s+)*push\b`,
  String.raw`(?:^|[|;&\n]|\$\(|\x60)\s*git\s+(?:-\w+\s+\S+\s+|-\w+\s+)*reset\s+--hard\b`,
  String.raw`(?:^|[|;&\n]|\$\(|\x60)\s*(npm|pnpm|yarn)\s+publish\b`,
  String.raw`(?:^|[|;&\n]|\$\(|\x60)\s*curl\b[^\n|;&]*-X\s*(POST|PUT|DELETE|PATCH)\b`,
  String.raw`(?:^|[|;&\n]|\$\(|\x60)\s*sudo\b`,
  String.raw`(?:^|[|;&\n]|\$\(|\x60)\s*(shutdown|reboot|halt)\b`,
  String.raw`(?:^|[|;&\n]|\$\(|\x60)\s*kill(all)?\s+-9\b`,
  /* Wrapper-mediated destruction: the anchored rules above key on the command
   * position, which wrappers hide (`ls | xargs rm -rf` was a measured false
   * negative — eval/guardrails-labeled.json). Cover the common wrappers. */
  String.raw`\b(xargs|parallel)\b[^\n|;&]*\brm\s+(-\w*\s+)*-?\w*[rf]\w*\b`,
  String.raw`\bfind\b[^\n|;&]*-exec\s+rm\s+(-\w*\s+)*-?\w*[rf]\w*\b`,
  String.raw`\b(?:ba|z|c|k|fi)?sh\s+-c\s+['"]?[^\n'"]*(?:rm\s+(-\w*\s+)*-?\w*[rf]\w*\b|git\s+push\b|git\s+reset\s+--hard\b|sudo\b)`,
];

/** Bash commands that mutate state and are ledgered with auto-approval.
 *  These patterns are intentionally NOT anchored to a command position:
 *  auto-ledgering is cheap, so the mutating tier accepts quoted-text false
 *  positives (echo "mv a b" gets ledgered) in exchange for never missing a
 *  real mutation. Only the dangerous tier (approval) is anchor-strict. */
export const DEFAULT_MUTATING = [
  String.raw`>[>]?\s*[^\s|&]`,                          // redirection writes
  String.raw`\b(mv|cp|mkdir|touch|ln|chmod|chown)\b`,
  String.raw`\bsed\s+(-\w+\s+)*-i\b`,
  String.raw`\bgit\s+(?:-\w+\s+\S+\s+|-\w+\s+)*(add|commit|checkout|switch|merge|rebase|restore|stash|apply)\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update)\b`,
  String.raw`\brm\s+\S`,                              // any deletion is ledgered (rm -rf still escalates via the dangerous tier first)
];

/** File-writing tool names and where their target path lives in arguments. */
const WRITE_TOOLS = {
  write: 'file_path',
  edit: 'file_path',
  'str-replace-editor': 'path',
  'str_replace_editor': 'path',
};

/**
 * Recommended opt-in allowlist preset for trusted devices: a STANDALONE,
 * non-force `git push` is demoted from dangerous (needs approval) to
 * mutating (ledgered automatically, no approval) — routine publishing stays
 * automatable while `--force`/`-f`-combos/`--delete`/`--mirror` remain gated
 * (note: `--force-with-lease` conservatively stays gated too).
 *
 * Anchored to the WHOLE command on purpose: any shell separator (`;`, `&&`,
 * `|`, newline) or substitution char fails the match, so a chained
 * `git push origin main; rm -rf x` can NEVER be laundered through the
 * allowlist — the dangerous tier still sees the `rm -rf`.
 */
export const ALLOW_GIT_PUSH_SAFE = String.raw`^\s*git\s+(?:-\w+\s+\S+\s+|-\w+\s+)*push\b(?![^\n|;&]*(?:--force\b|-\w*f\b|--delete\b|--mirror\b))\s*[a-zA-Z0-9._/:~^@ \t-]*$`;

/** Schemastery config; every key overridable from the loader row. */
export const Config = z.object({
  /** Extra dangerous-command regexes (merged over the built-in list). */
  extraDangerousPatterns: z.array(z.string()).default([]),
  /** Extra mutating-command regexes (merged over the built-in list). */
  extraMutatingPatterns: z.array(z.string()).default([]),
  /** Commands matching these patterns skip the dangerous tier (demoted to
   *  mutating: ledgered, auto-approved, repeat-allowed). Keep each pattern
   *  anchored to the whole command and free of shell separators, or a chained
   *  dangerous command will be laundered through it. See ALLOW_GIT_PUSH_SAFE. */
  dangerousAllowPatterns: z.array(z.string()).default([]),
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
/**
 * Build a single-argument classifier from a config (defaults applied).
 * Exported for the labeled-set regression test (eval/bin/check-guardrails.mjs)
 * AND used by apply() below — one classifier, one truth, so the labeled set
 * measures exactly what runs in production.
 */
export function createClassifier(config = {}) {
  const merged = { ledgerFileWrites: true, ledgerBashMutations: true, ...config };
  const dangerous = [...DEFAULT_DANGEROUS, ...(config.extraDangerousPatterns ?? [])].map((p) => new RegExp(p));
  const mutating = [...DEFAULT_MUTATING, ...(config.extraMutatingPatterns ?? [])].map((p) => new RegExp(p));
  const allow = (config.dangerousAllowPatterns ?? []).map((p) => new RegExp(p));
  return (exec) => classify(exec, dangerous, mutating, allow, merged);
}

function classify(exec, dangerous, mutating, allow, config) {
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
      /* Allowlist demotion (trusted-device automation): an allowlisted
       * dangerous command becomes mutating — still ledgered every time, but
       * no approval round-trip, and the duplicate guard must NOT fire on it
       * (allowRepeat): a re-run like `git push origin main` is a NEW remote
       * mutation whose semantic args are identical, so dedup-by-args is
       * meaningless and would block legitimate repeats. */
      if (allow.some((re) => re.test(command))) {
        return {
          action: 'shell.exec',
          resource: truncate(command, 120),
          summary: `allowlisted: ${truncate(command, 80)}`,
          approval: 'auto',
          rule: 'dangerous-allowed',
          allowRepeat: true,
        };
      }
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
  const classifyExec = createClassifier(config);

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
    const effect = classifyExec(exec);
    if (effect === undefined) return next();
    const ledger = ctx.effectLedger;
    const sessionId = exec.agent?.session.id;
    if (ledger === undefined || sessionId === undefined) return next();

    const key = effectKey(exec, effect);

    /* Duplicate guard: an identical effect already executed. Allowlisted
     * dangerous commands (e.g. routine git push) opt out — their semantic
     * args are stable across legitimate repeats, so dedup-by-args is
     * meaningless for them; each execution is still ledgered below. */
    const existing = effect.allowRepeat === true ? undefined : await ledger.get(key);
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
        const effect = classifyExec(exec);
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
      'Dangerous operations (destructive shell, force-pushes, publishes, external mutation) require human approval; when no approval channel exists they are denied. Commands matching the profile dangerousAllowPatterns allowlist skip the approval round-trip but are still ledgered on every execution.',
      'Completing a WorkUnit whose declared artifacts are missing on disk is blocked.',
    ].join('\n'),
  });
}
