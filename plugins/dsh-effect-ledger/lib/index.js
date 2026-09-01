/**
 * dsh-effect-ledger — the side-effect ledger (Muse: 副作用日志).
 *
 * Every action that changes the world outside the transcript must be
 * representable as a ledger entry:
 *
 *   idempotencyKey   stable key; retrying the same operation must find the
 *                    existing entry instead of executing twice
 *   subject          who acts (agent session / workunit)
 *   action           what (tool name + semantic verb, e.g. fs.write)
 *   resource         where (path, URL, issue id, message target...)
 *   resourceVersion  the observed version of the resource the decision was
 *                    made against (mtime, etag, sha, row version...)
 *   paramsHash       hash of the exact approved parameter payload
 *   approval         who approved, what scope, when (or 'auto:policy')
 *   status           proposed -> approved -> executed | failed | rolled_back
 *   result           execution outcome summary + evidence refs
 *   rollback         how to undo + its own status
 *
 * With this log, "the same operation executed twice" is detectable (same
 * idempotency key reaching `executed` twice is a defect the eval layer counts
 * as duplicate_side_effect), and "tool returned success but business failed"
 * is separable (status vs. the WorkUnit's verification).
 *
 * Two producers feed the ledger:
 *   1. the model-facing `effect` tool — explicit propose/check/record for
 *      operations the model knows are side-effecting;
 *   2. dsh-guardrails, which auto-proposes entries when it intercepts
 *      side-effecting tool calls (writes, deletes, network mutation, bash).
 *
 * Storage: `storageDomain` domain `effects`. Entries are keyed by
 * idempotency key; `by_workunit` indexes workunitId -> [idempotencyKey].
 *
 * @module dsh-effect-ledger
 */
import { Service } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'effect-ledger';

/** Hard dependencies. `workunits` links entries to their business task. */
export const inject = ['storageDomain', 'tools', 'systemPrompt', 'workunits'];

/* ------------------------------------------------------------------------ */
/* Schema                                                                    */
/* ------------------------------------------------------------------------ */

const EFFECT_STATUSES = ['proposed', 'approved', 'executed', 'failed', 'rolled_back'];

const entrySchema = z.object({
  /** Stable idempotency key — the ledger primary key. */
  idempotencyKey: z.string().min(1),
  /** Who acts: `session:<id>` (required) and optional workunit link. */
  sessionId: z.string().min(1),
  workunitId: z.string().optional(),
  /** What: tool name + semantic verb. */
  tool: z.string().min(1),
  action: z.string().min(1),
  /** Where: normalized resource locator (path, URL, external id...). */
  resource: z.string().min(1),
  /** Observed resource version at decision time (mtime/etag/sha/...), if known. */
  resourceVersion: z.string().optional(),
  /** SHA-256 of the canonical JSON of the exact approved parameters. */
  paramsHash: z.string().min(1),
  /** Human-readable summary of what will change. */
  summary: z.string().min(1),
  approval: z.object({
    who: z.string().min(1), // 'user' | 'auto:policy' | 'guardrails:<rule>'
    scope: z.string().min(1),
    at: z.number(),
  }).nullable(),
  status: z.enum(EFFECT_STATUSES),
  result: z.object({
    at: z.number(),
    ok: z.boolean(),
    note: z.string().optional(),
    /** evidence ids (dsh-evidence) capturing the outcome. */
    evidenceRefs: z.array(z.string()),
  }).nullable(),
  rollback: z.object({
    supported: z.boolean(),
    note: z.string().optional(),
    at: z.number().optional(),
    ok: z.boolean().optional(),
  }).nullable(),
  /** How many times an execute was attempted (>=2 with status executed = duplicate defect). */
  executeAttempts: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const indexSchema = z.object({ keys: z.array(z.string()) });

const spec = defineDomain({
  name: 'effects',
  version: 1,
  tables: {
    ledger: domainTable(entrySchema),
    by_workunit: domainTable(indexSchema),
  },
});

/** Canonical JSON for hashing: stable key order, no whitespace. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** SHA-256 hex of the canonical parameter payload. */
export function hashParams(params) {
  return createHash('sha256').update(canonicalJson(params ?? null)).digest('hex');
}

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Programmatic ledger API. Guardrails and the model tool both go through
 * here; entries are keyed by idempotency key so `propose` is naturally
 * idempotent — proposing an existing key returns the stored entry.
 */
/** Module-level handle — see dsh-workunit for why. */
let ledgerInstance;

class EffectLedger extends Service {
  static inject = ['storageDomain'];

  constructor(ctx, config) {
    super(ctx, 'effectLedger');
    ledgerInstance = this;
  }

  /** Lazily opened domain — see dsh-workunit for the rationale. */
  _domainPromise;

  _domain() {
    if (this._domainPromise === undefined) {
      this._domainPromise = this.ctx.storageDomain.open(spec).then((domain) => {
        this.ctx.effect(() => async () => {
          await domain.close();
        }, 'effect-ledger.domainClose');
        return domain;
      }).catch((error) => {
        this._domainPromise = undefined;
        throw error;
      });
    }
    return this._domainPromise;
  }

  async _ledgerT() {
    return (await this._domain()).table('ledger');
  }

  async _byWorkunitT() {
    return (await this._domain()).table('by_workunit');
  }

  /** Lookup by idempotency key (undefined when absent). */
  async get(idempotencyKey) {
    const ledger = await this._ledgerT();
    return ledger.get(idempotencyKey);
  }

  /** All entries, newest first. */
  async list() {
    const ledger = await this._ledgerT();
    return [...ledger.entries()].map(([, e]) => e).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Entries linked to one workunit. */
  async forWorkunit(workunitId) {
    const byWorkunit = await this._byWorkunitT();
    const ledger = await this._ledgerT();
    const keys = byWorkunit.get(workunitId)?.keys ?? [];
    return keys.map((k) => ledger.get(k)).filter((e) => e !== undefined);
  }

  /**
   * Propose an effect. Idempotent: an existing key returns the stored entry
   * with `fresh: false` — callers MUST check this before executing, that is
   * the duplicate-side-effect guard.
   */
  async propose(fields) {
    const ledger = await this._ledgerT();
    const existing = ledger.get(fields.idempotencyKey);
    if (existing !== undefined) return { entry: existing, fresh: false };
    const now = Date.now();
    const entry = entrySchema.parse({
      idempotencyKey: fields.idempotencyKey,
      sessionId: fields.sessionId,
      ...(fields.workunitId !== undefined ? { workunitId: fields.workunitId } : {}),
      tool: fields.tool,
      action: fields.action,
      resource: fields.resource,
      ...(fields.resourceVersion !== undefined ? { resourceVersion: fields.resourceVersion } : {}),
      paramsHash: fields.paramsHash ?? hashParams(fields.params),
      summary: fields.summary,
      approval: fields.approval ?? null,
      status: fields.approval ? 'approved' : 'proposed',
      result: null,
      rollback: fields.rollback ?? null,
      executeAttempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ledger.put(entry.idempotencyKey, entry);
    if (entry.workunitId !== undefined) {
      const byWorkunit = await this._byWorkunitT();
      const index = byWorkunit.get(entry.workunitId) ?? { keys: [] };
      if (!index.keys.includes(entry.idempotencyKey)) {
        await byWorkunit.put(entry.workunitId, { keys: [...index.keys, entry.idempotencyKey] });
      }
    }
    return { entry, fresh: true };
  }

  /** Record approval for a proposed entry. */
  async approve(idempotencyKey, approval) {
    return this._transition(idempotencyKey, ['proposed'], (draft) => {
      draft.approval = { who: approval.who, scope: approval.scope, at: Date.now() };
      draft.status = 'approved';
    });
  }

  /**
   * Mark execution. Returns `{ duplicate: true }` without mutating when the
   * entry is already executed — the caller must NOT re-run the operation.
   */
  async markExecuted(idempotencyKey, result) {
    const ledger = await this._ledgerT();
    const stored = ledger.get(idempotencyKey);
    if (stored === undefined) throw new Error(`effect '${idempotencyKey}' not found`);
    if (stored.status === 'executed') return { entry: stored, duplicate: true };
    const entry = await ledger.update(idempotencyKey, (current) => {
      const next = structuredClone(current);
      next.executeAttempts += 1;
      next.status = result.ok ? 'executed' : 'failed';
      next.result = {
        at: Date.now(),
        ok: result.ok,
        ...(result.note !== undefined ? { note: result.note } : {}),
        evidenceRefs: result.evidenceRefs ?? [],
      };
      next.updatedAt = Date.now();
      return next;
    });
    return { entry, duplicate: false };
  }

  /** Record a rollback outcome. */
  async markRolledBack(idempotencyKey, ok, note) {
    return this._transition(idempotencyKey, ['executed', 'failed'], (draft) => {
      draft.status = 'rolled_back';
      draft.rollback = {
        supported: draft.rollback?.supported ?? true,
        ...(note !== undefined ? { note } : {}),
        at: Date.now(),
        ok,
      };
    });
  }

  async _transition(key, fromStatuses, mutate) {
    const ledger = await this._ledgerT();
    const stored = ledger.get(key);
    if (stored === undefined) throw new Error(`effect '${key}' not found`);
    if (!fromStatuses.includes(stored.status)) {
      throw new Error(`effect '${key}' is '${stored.status}', expected one of ${fromStatuses.join(', ')}`);
    }
    return ledger.update(key, (current) => {
      const next = structuredClone(current);
      mutate(next);
      next.updatedAt = Date.now();
      return next;
    });
  }
}

/* ------------------------------------------------------------------------ */
/* Model-facing tool                                                         */
/* ------------------------------------------------------------------------ */

const TOOL_DESCRIPTION = `Register and check side effects in the effect ledger. Any action that changes something outside this conversation (writing files, running mutating commands, posting to external systems) should be ledgered — the ledger is what makes retries safe and audits possible.

Ops:
- propose: before executing a side effect, propose it with a STABLE idempotencyKey (derive it from the operation's semantic identity, e.g. "write:src/config.ts:add-retry-logic"). If the key already exists, the stored entry comes back with fresh=false — DO NOT execute again; inspect the entry's status/result instead. After execution, report the outcome via 'record'.
- check: look up an entry by idempotencyKey (e.g. after a crash or retry, to learn whether the operation already ran).
- record: report the execution outcome (ok + note) for a proposed/approved entry.
- rollback: record that an executed effect was undone.
- list: recent ledger entries (or all entries for one workunit).

An approval field may be attached at propose time when approval already happened (who/scope); guardrails may also approve entries itself. Entries carry the resource version you decided against — record it when known (file mtime, etag, git sha) so stale-decision conflicts are visible.`;

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      fresh: { type: 'boolean' },
      duplicate: { type: 'boolean' },
      entry: { type: 'json' },
      entries: { type: 'array', items: { type: 'json' } },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: value.ok
      ? (value.entry
        ? [
            `Effect ${value.entry.idempotencyKey} [${value.entry.status}]${value.fresh === false ? ' (already ledgered — do not re-execute)' : ''}${value.duplicate === true ? ' (DUPLICATE — already executed)' : ''}`,
            `${value.entry.tool}:${value.entry.action} ${value.entry.resource}`,
            `Summary: ${value.entry.summary}`,
            `Approval: ${value.entry.approval === null ? '(none)' : `${value.entry.approval.who} (${value.entry.approval.scope}) @${new Date(value.entry.approval.at).toISOString()}`}`,
            `Attempts: ${value.entry.executeAttempts}${value.entry.result !== null ? `, result ok=${value.entry.result.ok}${value.entry.result.note !== undefined ? ` (${value.entry.result.note})` : ''} @${new Date(value.entry.result.at).toISOString()}` : ''}`,
            ...(value.entry.rollback !== null ? [`Rollback: ${JSON.stringify(value.entry.rollback)}`] : []),
          ].join('\n')
        : [
            `${value.entries?.length ?? 0} ledger entr${value.entries?.length === 1 ? 'y' : 'ies'}:`,
            ...(value.entries ?? []).map((e) => `- [${e.status}] ${e.tool}:${e.action} ${e.resource} (key ${e.idempotencyKey.slice(0, 60)}${e.idempotencyKey.length > 60 ? '…' : ''}${e.executeAttempts > 1 ? `, attempts=${e.executeAttempts}` : ''})`),
          ].join('\n'))
      : `effect op failed: ${value.error ?? 'unknown error'}`,
  }],
};

/* ------------------------------------------------------------------------ */
/* apply                                                                     */
/* ------------------------------------------------------------------------ */

export function apply(ctx) {
  ctx.plugin(EffectLedger);

  ctx.systemPrompt.section({
    name: 'muse:effect-ledger',
    order: 117,
    text: [
      '## Effect ledger — side-effect discipline',
      'Side effects go through the `effect` tool: propose with a stable idempotencyKey BEFORE executing; on fresh=false the operation already exists — do not run it again, read its status instead.',
      'After executing, always report the outcome via effect op=record. Tool success is not business success: delivery is only proven by WorkUnit verification.',
    ].join('\n'),
  });

  ctx.tools.register(defineTool({
    name: 'effect',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: { type: 'string', required: true, enum: ['propose', 'check', 'record', 'rollback', 'list'], description: 'Ledger operation.' },
      idempotencyKey: { type: 'string', description: 'Stable key identifying the operation (required for propose/check/record/rollback).' },
      tool: { type: 'string', description: '[propose] Tool performing the effect (e.g. write, bash).' },
      action: { type: 'string', description: '[propose] Semantic verb (e.g. fs.write, http.post, git.push).' },
      resource: { type: 'string', description: '[propose] Target resource (path, URL, external id).' },
      resourceVersion: { type: 'string', description: '[propose] Observed resource version at decision time (mtime/etag/sha).' },
      summary: { type: 'string', description: '[propose] Human-readable description of the change.' },
      params: { type: 'object', additionalProperties: true, description: '[propose] The exact parameter payload (hashed into paramsHash).' },
      approval: { type: 'object', additionalProperties: false, properties: {
        who: { type: 'string', required: true },
        scope: { type: 'string', required: true },
      }, description: '[propose] Approval already granted (who/scope).' },
      rollbackNote: { type: 'string', description: '[propose|rollback] How the effect can be undone / rollback outcome note.' },
      ok: { type: 'boolean', description: '[record|rollback] Whether execution/rollback succeeded.' },
      note: { type: 'string', description: '[record] Outcome summary.' },
      workunitId: { type: 'string', description: '[list] Restrict to one workunit.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const ledger = ledgerInstance;
      if (ledger === undefined) return { ok: false, error: 'effectLedger service unavailable' };
      const sessionId = exec.agent?.session.id;
      if (sessionId === undefined) return { ok: false, error: 'effect tool requires an owning agent session' };
      try {
        switch (args.op) {
          case 'propose': {
            for (const field of ['idempotencyKey', 'tool', 'action', 'resource', 'summary']) {
              if (typeof args[field] !== 'string' || args[field] === '') return { ok: false, error: `propose requires '${field}'` };
            }
            const workunitId = await ctx.workunits?.currentId(sessionId);
            const { entry, fresh } = await ledger.propose({
              idempotencyKey: args.idempotencyKey,
              sessionId,
              ...(workunitId !== undefined ? { workunitId } : {}),
              tool: args.tool,
              action: args.action,
              resource: args.resource,
              ...(args.resourceVersion !== undefined ? { resourceVersion: args.resourceVersion } : {}),
              ...(args.params !== undefined ? { params: args.params } : {}),
              summary: args.summary,
              ...(args.approval !== undefined ? { approval: { ...args.approval, at: Date.now() } } : {}),
              ...(args.rollbackNote !== undefined ? { rollback: { supported: true, note: args.rollbackNote } } : {}),
            });
            if (fresh && workunitId !== undefined) await ctx.workunits.linkEffect(workunitId, entry.idempotencyKey);
            return { ok: true, fresh, entry };
          }
          case 'check': {
            const entry = await ledger.get(args.idempotencyKey);
            if (!entry) return { ok: false, error: `effect '${args.idempotencyKey}' not found` };
            return { ok: true, entry };
          }
          case 'record': {
            if (typeof args.ok !== 'boolean') return { ok: false, error: "record requires 'ok'" };
            const { entry, duplicate } = await ledger.markExecuted(args.idempotencyKey, { ok: args.ok, ...(args.note !== undefined ? { note: args.note } : {}) });
            return { ok: true, duplicate, entry };
          }
          case 'rollback': {
            if (typeof args.ok !== 'boolean') return { ok: false, error: "rollback requires 'ok'" };
            const entry = await ledger.markRolledBack(args.idempotencyKey, args.ok, args.rollbackNote);
            return { ok: true, entry };
          }
          case 'list': {
            const entries = args.workunitId !== undefined ? await ledger.forWorkunit(args.workunitId) : (await ledger.list()).slice(0, 50);
            return { ok: true, entries };
          }
          default:
            return { ok: false, error: `unknown op '${args.op}'` };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Effect ${args.op}`,
      kind: args.op === 'check' || args.op === 'list' ? 'read' : 'write',
    }),
  }));
}
