/**
 * dsh-workunit — structured business-task state for the DeepSeek Harness.
 *
 * Principle (Muse): the transcript is audit material, not task state. What
 * must be structured and durable is the immutable objective, user constraints,
 * plan versions, completed/pending steps, evidence refs, effect refs, approval
 * records, artifacts, failure counts and remaining budget. A WorkUnit is that
 * record: it survives context compaction, session resume and process restarts,
 * and every mutation is revision-guarded so concurrent or resumed writers fail
 * loud instead of diverging.
 *
 * Storage: one `storageDomain` domain `workunit` (zod-validated, write-chained,
 * JSON-durable under the profile storages root). Tables:
 *   units   — WorkUnit records by id
 *   current — sessionId -> workunitId ("the task this session is driving")
 *   history — unitId -> append-only transition log (the structured audit trail)
 *
 * Audit note: this plugin deliberately does NOT append custom session events.
 * The persistence read path refuses logs whose event types sit outside the
 * build's KNOWN_SESSION_EVENT_TYPES unless the event is `ignorable`, and
 * `Session.append` cannot set that marker — a custom `workunit/*` event would
 * make the whole session unresumable. The transcript already records every
 * mutation as `tool/call` + `tool/result` pairs (audit material, per Muse);
 * the structured transition history lives in the `history` table.
 *
 * Sibling plugins (`dsh-effect-ledger`, `dsh-guardrails`, `dsh-eval`) inject
 * the `workunits` service for programmatic access.
 *
 * @module dsh-workunit
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workunit';

/** Hard dependencies: durable domain store, tool registry, prompt registry. */
export const inject = ['storageDomain', 'tools', 'systemPrompt'];

/* ------------------------------------------------------------------------ */
/* Schema                                                                    */
/* ------------------------------------------------------------------------ */

/** Failure taxonomy shared with dsh-eval (Muse: model/route/tool/state/control/delivery). */
const FAILURE_CLASSES = ['model', 'route', 'tool', 'state', 'control', 'delivery'];

const stepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']),
  note: z.string().optional(),
  updatedAt: z.number(),
});

const artifactSchema = z.object({
  id: z.string().min(1),
  /** file | patch | report | url | command-output | ... */
  kind: z.string().min(1),
  path: z.string().optional(),
  /** content hash when the artifact is a file/payload we can hash. */
  hash: z.string().optional(),
  verified: z.boolean(),
  verifyNote: z.string().optional(),
  version: z.number().int(),
  createdAt: z.number(),
});

const approvalSchema = z.object({
  at: z.number(),
  /** 'user' | 'auto:policy' | 'guardrails:<rule>' */
  who: z.string().min(1),
  /** what exactly was approved (scope description or effect idempotency key). */
  scope: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
});

const budgetSchema = z.object({
  maxTokens: z.number().optional(),
  spentTokens: z.number(),
  maxRounds: z.number().optional(),
  roundsUsed: z.number(),
  maxFailures: z.number().optional(),
  failures: z.number(),
});

const workUnitSchema = z.object({
  id: z.string().min(1),
  /** optimistic-concurrency counter; every mutation increments it. */
  revision: z.number().int(),
  sessionId: z.string().min(1),
  /** immutable after creation — the business goal. */
  objective: z.string().min(1),
  /** append-only user/business constraints. */
  constraints: z.array(z.string()),
  status: z.enum(['draft', 'active', 'waiting_approval', 'blocked', 'done', 'failed', 'cancelled']),
  /** increments whenever the step list is replaced (re-plan). */
  planVersion: z.number().int(),
  steps: z.array(stepSchema),
  budget: budgetSchema,
  artifacts: z.array(artifactSchema),
  /** evidence ids registered in dsh-evidence. */
  evidenceRefs: z.array(z.string()),
  /** idempotency keys recorded in dsh-effect-ledger. */
  effectRefs: z.array(z.string()),
  approvals: z.array(approvalSchema),
  checkpoint: z.object({
    at: z.number(),
    reason: z.string(),
    note: z.string().optional(),
  }).nullable(),
  failureClasses: z.array(z.enum(FAILURE_CLASSES)),
  /** delivery verification recorded at completion time. */
  verification: z.object({
    at: z.number(),
    method: z.string(),
    note: z.string().optional(),
  }).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
});

/** sessionId -> workunitId pointer record. */
const currentSchema = z.object({ workunitId: z.string() });

/** Append-only structured transition log for one unit. */
const historySchema = z.object({
  entries: z.array(z.object({
    at: z.number(),
    op: z.string(),
    revision: z.number(),
    status: z.string(),
    note: z.string().optional(),
  })),
});

const spec = defineDomain({
  name: 'workunit',
  version: 1,
  tables: {
    units: domainTable(workUnitSchema),
    current: domainTable(currentSchema),
    history: domainTable(historySchema),
  },
});

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

/** Thrown on optimistic-concurrency mismatch; carries a stable code. */
class RevisionConflict extends Error {
  code = 'workunit/revision-conflict';
  constructor(id, expected, actual) {
    super(`workunit '${id}': expected revision ${expected}, found ${actual} — re-read and retry`);
  }
}

/** Thrown when a mutation targets a missing unit. */
class WorkUnitNotFound extends Error {
  code = 'workunit/not-found';
  constructor(id) {
    super(`workunit '${id}' does not exist`);
  }
}

/**
 * Programmatic WorkUnit API. Reads are synchronous (domain memory is
 * authoritative); writes chain through the domain and are durable before the
 * returned promise resolves.
 */
/** Module-level handle captured at construction — tool closures use it directly
 * (cordis forbids reading ctx.<service> that the same plugin provides without
 * injecting it, and injecting your own service would deadlock activation). */
let workunitsInstance;

class WorkUnits extends Service {
  static inject = ['storageDomain'];

  constructor(ctx, config) {
    super(ctx, 'workunits');
    workunitsInstance = this;
  }

  /**
   * Lazily opened domain handle. Opening is deferred to first use so boot
   * never waits on storage I/O (and never races the JSON backend lifecycle);
   * the open promise is cached, and cleared on failure so a later call
   * retries. Once opened, domain tables are in-memory authoritative.
   */
  _domainPromise;
  _domainValue;

  _domain() {
    if (this._domainPromise === undefined) {
      this._domainPromise = this.ctx.storageDomain.open(spec).then((domain) => {
        this._domainValue = domain;
        this.ctx.effect(() => async () => {
          await domain.close();
        }, 'workunit.domainClose');
        return domain;
      }).catch((error) => {
        this._domainPromise = undefined;
        throw error;
      });
    }
    return this._domainPromise;
  }

  async _table(name) {
    const domain = await this._domain();
    return domain.table(name);
  }

  /**
   * Synchronous best-effort read for prompt-context assembly: returns the
   * session's current unit when the domain is already open, otherwise kicks
   * off a background warm-open and returns undefined for this step.
   */
  peekCurrent(sessionId) {
    if (this._domainValue === undefined) {
      void this._domain().catch(() => {});
      return undefined;
    }
    const pointer = this._domainValue.table('current').get(sessionId);
    return pointer === undefined ? undefined : this._domainValue.table('units').get(pointer.workunitId);
  }

  /** Append one transition entry to the unit's structured history. */
  async recordTransition(unit, op, note) {
    const history = await this._table('history');
    const stored = history.get(unit.id) ?? { entries: [] };
    await history.put(unit.id, {
      entries: [...stored.entries, {
        at: Date.now(),
        op,
        revision: unit.revision,
        status: unit.status,
        ...(note !== undefined ? { note } : {}),
      }],
    });
  }

  /** Read the unit's structured transition history (empty when none). */
  async history(id) {
    const history = await this._table('history');
    return history.get(id)?.entries ?? [];
  }

  /** Read one unit by id (undefined when absent). */
  async get(id) {
    const units = await this._table('units');
    return units.get(id);
  }

  /** Resolve `id` or fall back to the session's current unit. */
  async resolve(id, sessionId) {
    const units = await this._table('units');
    if (id !== undefined) return units.get(id);
    const current = await this._table('current');
    const pointer = current.get(sessionId);
    return pointer === undefined ? undefined : units.get(pointer.workunitId);
  }

  /** The session's current unit id, if any. */
  async currentId(sessionId) {
    const current = await this._table('current');
    return current.get(sessionId)?.workunitId;
  }

  /** All units, newest first. */
  async list() {
    const units = await this._table('units');
    return [...units.entries()].map(([, u]) => u).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Create and persist a new unit, making it the session's current unit.
   * @returns the stored record.
   */
  async create(fields) {
    const now = Date.now();
    const unit = workUnitSchema.parse({
      id: `wu_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      revision: 1,
      sessionId: fields.sessionId,
      objective: fields.objective,
      constraints: fields.constraints ?? [],
      status: fields.status ?? 'active',
      planVersion: 1,
      steps: (fields.steps ?? []).map((s, i) => ({
        id: s.id ?? `s${i + 1}`,
        title: s.title,
        status: 'pending',
        updatedAt: now,
      })),
      budget: {
        spentTokens: 0,
        roundsUsed: 0,
        failures: 0,
        ...(fields.budget ?? {}),
      },
      artifacts: [],
      evidenceRefs: [],
      effectRefs: [],
      approvals: [],
      checkpoint: null,
      failureClasses: [],
      verification: null,
      createdAt: now,
      updatedAt: now,
    });
    const units = await this._table('units');
    const current = await this._table('current');
    await units.put(unit.id, unit);
    await current.put(fields.sessionId, { workunitId: unit.id });
    await this.recordTransition(unit, 'create');
    return unit;
  }

  /**
   * Revision-guarded mutation. `mutate` receives a deep-cloned draft and
   * returns the next record (or nothing to keep the mutated draft).
   * @throws {WorkUnitNotFound|RevisionConflict}
   */
  async update(id, ifRevision, mutate) {
    const units = await this._table('units');
    const stored = units.get(id);
    if (stored === undefined) throw new WorkUnitNotFound(id);
    if (ifRevision !== stored.revision) throw new RevisionConflict(id, ifRevision, stored.revision);
    return units.update(id, (current) => {
      const draft = structuredClone(current);
      const returned = mutate(draft) ?? draft;
      const next = workUnitSchema.parse({
        ...returned,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      });
      return next;
    });
  }

  /** Append an approval record (called by guardrails/effect-ledger). */
  async recordApproval(id, approval) {
    const units = await this._table('units');
    return units.update(id, (current) => {
      const next = structuredClone(current);
      next.approvals.push(approvalSchema.parse(approval));
      next.revision += 1;
      next.updatedAt = Date.now();
      return next;
    });
  }

  /** Link an evidence id into the unit (idempotent). */
  async linkEvidence(id, evidenceId) {
    const units = await this._table('units');
    return units.update(id, (current) => {
      if (current.evidenceRefs.includes(evidenceId)) return current;
      const next = structuredClone(current);
      next.evidenceRefs.push(evidenceId);
      next.revision += 1;
      next.updatedAt = Date.now();
      return next;
    });
  }

  /** Link an effect idempotency key into the unit (idempotent). */
  async linkEffect(id, idempotencyKey) {
    const units = await this._table('units');
    return units.update(id, (current) => {
      if (current.effectRefs.includes(idempotencyKey)) return current;
      const next = structuredClone(current);
      next.effectRefs.push(idempotencyKey);
      next.revision += 1;
      next.updatedAt = Date.now();
      return next;
    });
  }

  /** Add spent tokens to the unit's budget ledger (idempotent per delta call). */
  async addSpentTokens(id, delta) {
    const units = await this._table('units');
    return units.update(id, (current) => {
      const next = structuredClone(current);
      next.budget.spentTokens += Math.max(0, Math.trunc(delta));
      next.revision += 1;
      next.updatedAt = Date.now();
      return next;
    });
  }
}

/* ------------------------------------------------------------------------ */
/* Model-facing tool                                                         */
/* ------------------------------------------------------------------------ */

const OPS = ['create', 'get', 'list', 'update', 'plan', 'step', 'artifact', 'checkpoint', 'complete', 'fail'];

const TOOL_DESCRIPTION = `Manage the structured business-task record (WorkUnit) for this session. The WorkUnit — not the chat transcript — is the authoritative task state: it survives compaction, resume and restarts, and it is what gets verified before delivery.

Ops:
- create: start a WorkUnit for non-trivial multi-step work. Provide the immutable objective, optional constraints, and the planned steps. The created unit becomes this session's current unit.
- get: read a unit (omit id for the current unit). Always re-read before updating.
- list: all units across sessions (newest first, summary only) — this is how a crashed session's task is found and resumed.
- update: change status or append constraints. Requires ifRevision matching the last read.
- plan: replace the step list (re-plan). Increments planVersion. Requires ifRevision.
- step: set one step's status (pending|in_progress|done|failed|skipped) with an optional note. Requires ifRevision.
- artifact: register or re-verify a deliverable (file/patch/report/...). Requires ifRevision.
- checkpoint: record a named resume point (reason + note). Do this before risky operations, long waits, and whenever a crash would lose context. Requires ifRevision.
- complete: finish the unit. REFUSED unless every step is done/skipped and a verification is supplied (method + note, e.g. tests run, build green, human confirmed). Tool success is not business success; verification is the business check.
- fail: mark failed with failure classes (model|route|tool|state|control|delivery) so evaluation can classify instead of just "failed".

Every mutation returns the full updated record including its new revision — chain your next ifRevision from it.`;

/** Output view of a WorkUnit — plain JSON (the zod schema already validated it). */
const unitViewSchema = { type: 'json' };


/** Machine-readable trailer appended to every render: session logs carry
 *  only the RENDERED text, so the Muse 工作台 bridge parses this compact
 *  JSON envelope instead of scraping prose. `-->` inside strings is escaped
 *  as \u003e (valid JSON, restores exactly on parse). */
function museTrailer(tool, value) {
  return `\n\n<!--muse:${tool} ${JSON.stringify(value).replace(/-->/g, '--\\u003e')}-->`;
}

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      unit: unitViewSchema,
      units: { type: 'array', items: { type: 'json' } },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: (value.ok
      ? (value.unit
        ? [
            `WorkUnit ${value.unit.id} [${value.unit.status}] rev=${value.unit.revision} plan v${value.unit.planVersion}`,
            `Objective: ${value.unit.objective}`,
            ...(value.unit.constraints.length > 0 ? [`Constraints: ${value.unit.constraints.join(' | ')}`] : []),
            `Steps (${value.unit.steps.filter((st) => st.status === 'done').length}/${value.unit.steps.length} done):`,
            ...value.unit.steps.map((st) => `- ${st.id} [${st.status}] ${st.title}${st.note !== undefined ? ` — ${st.note}` : ''}`),
            `Budget: tokens ${value.unit.budget.spentTokens}${value.unit.budget.maxTokens !== undefined ? `/${value.unit.budget.maxTokens}` : ''}, failures ${value.unit.budget.failures}, effects ${value.unit.effectRefs.length}, evidence ${value.unit.evidenceRefs.length}, artifacts ${value.unit.artifacts.length}`,
            ...(value.unit.checkpoint !== null ? [`Checkpoint @${new Date(value.unit.checkpoint.at).toISOString()}: ${value.unit.checkpoint.reason}${value.unit.checkpoint.note !== undefined ? ` — ${value.unit.checkpoint.note}` : ''}`] : []),
            ...(value.unit.verification !== null ? [`Verification: ${value.unit.verification.method}`] : []),
          ].join('\n')
        : [
            `${value.units?.length ?? 0} WorkUnit(s):`,
            ...(value.units ?? []).map((u) => `- ${u.id} [${u.status}] ${u.objective.slice(0, 80)}${u.objective.length > 80 ? '…' : ''} (session ${u.sessionId}, updated ${new Date(u.updatedAt).toISOString()})`),
          ].join('\n'))
      : `WorkUnit op failed: ${value.error ?? 'unknown error'}`) + museTrailer('workunit', value),
  }],
};

/** Execute one workunit op against the service. */
async function runOp(workunits, sessionId, args) {
  const { op } = args;
  switch (op) {
    case 'create': {
      if (typeof args.objective !== 'string' || args.objective.trim() === '') throw new Error("create requires a non-empty 'objective'");
      const unit = await workunits.create({
        sessionId,
        objective: args.objective,
        constraints: Array.isArray(args.constraints) ? args.constraints : [],
        steps: Array.isArray(args.steps) ? args.steps : [],
        budget: args.budget,
      });
      return { unit };
    }
    case 'get': {
      const unit = await workunits.resolve(args.id, sessionId);
      if (!unit) throw new Error(args.id ? `workunit '${args.id}' not found` : 'no current workunit — create one first');
      return { unit };
    }
    case 'list': {
      /* cross-session on purpose: this is a single-user tool, and finding a
         crashed session's unit is exactly how resume starts. */
      const units = (await workunits.list())
        .map((u) => ({ id: u.id, sessionId: u.sessionId, objective: u.objective, status: u.status, updatedAt: u.updatedAt }));
      return { units };
    }
    case 'update': {
      const unit = await requireResolved(workunits, args, sessionId);
      const next = await workunits.update(unit.id, args.ifRevision, (draft) => {
        if (args.status !== undefined) draft.status = args.status;
        if (Array.isArray(args.addConstraints)) draft.constraints.push(...args.addConstraints);
      });
      return { unit: next };
    }
    case 'plan': {
      const unit = await requireResolved(workunits, args, sessionId);
      if (!Array.isArray(args.steps)) throw new Error("plan requires 'steps'");
      const now = Date.now();
      const next = await workunits.update(unit.id, args.ifRevision, (draft) => {
        draft.planVersion += 1;
        draft.steps = args.steps.map((s, i) => ({
          id: typeof s.id === 'string' && s.id !== '' ? s.id : `s${i + 1}`,
          title: s.title,
          status: 'pending',
          updatedAt: now,
        }));
      });
      return { unit: next };
    }
    case 'step': {
      const unit = await requireResolved(workunits, args, sessionId);
      const next = await workunits.update(unit.id, args.ifRevision, (draft) => {
        const step = draft.steps.find((s) => s.id === args.stepId);
        if (!step) throw new Error(`step '${args.stepId}' not found`);
        step.status = args.stepStatus;
        step.updatedAt = Date.now();
        if (args.note !== undefined) step.note = args.note;
      });
      return { unit: next };
    }
    case 'artifact': {
      const unit = await requireResolved(workunits, args, sessionId);
      const artifact = args.artifactValue;
      const next = await workunits.update(unit.id, args.ifRevision, (draft) => {
        const index = draft.artifacts.findIndex((a) => a.id === artifact.id);
        if (index === -1) {
          draft.artifacts.push({
            version: 1,
            createdAt: Date.now(),
            verified: false,
            ...artifact,
          });
        } else {
          const existing = draft.artifacts[index];
          draft.artifacts[index] = { ...existing, ...artifact, version: existing.version + 1 };
        }
      });
      return { unit: next };
    }
    case 'checkpoint': {
      const unit = await requireResolved(workunits, args, sessionId);
      const next = await workunits.update(unit.id, args.ifRevision, (draft) => {
        draft.checkpoint = { at: Date.now(), reason: args.reason, ...(args.note !== undefined ? { note: args.note } : {}) };
      });
      return { unit: next };
    }
    case 'complete': {
      const unit = await requireResolved(workunits, args, sessionId);
      if (unit.status === 'done') throw new Error(`workunit '${unit.id}' is already done`);
      const open = unit.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress');
      if (open.length > 0) throw new Error(`cannot complete: ${open.length} step(s) still open: ${open.map((s) => s.id).join(', ')} — finish or skip them first`);
      if (typeof args.verification !== 'string' || args.verification.trim() === '') {
        throw new Error("cannot complete without 'verification': describe the business check that passed (tests, build, human confirmation). Tool success is not delivery.");
      }
      /* Transactional delivery check: declared file artifacts must exist on
         disk BEFORE the status flips to done — a post-hoc block would leave
         the record mutated. */
      const missing = unit.artifacts.filter((a) => typeof a.path === 'string' && a.path !== '' && !existsSync(a.path));
      if (missing.length > 0) {
        throw new Error(`cannot complete: ${missing.length} declared artifact(s) do not exist on disk: ${missing.map((a) => `${a.id} -> ${a.path}`).join(', ')}. Create them, fix the paths, or remove the declarations, then complete again.`);
      }
      const next = await workunits.update(unit.id, args.ifRevision, (draft) => {
        draft.status = 'done';
        draft.completedAt = Date.now();
        draft.verification = { at: Date.now(), method: args.verification, ...(args.note !== undefined ? { note: args.note } : {}) };

        /* Auto-derive deliverables from effectRefs if none were explicitly declared via op=artifact */
        if (draft.artifacts.length === 0 && Array.isArray(draft.effectRefs)) {
          const FS_EFFECT_RE = /^auto:[^:]+:(fs\.(?:write|edit)):(.+):[0-9a-f]{64}(?:#\d+)?$/;
          const autoPaths = new Set();
          for (const ref of draft.effectRefs) {
            const m = FS_EFFECT_RE.exec(ref);
            if (m && typeof m[2] === 'string' && m[2] !== '') {
              autoPaths.add(m[2]);
            }
          }
          const now = Date.now();
          for (const filePath of autoPaths) {
            if (existsSync(filePath)) {
              let id = basename(filePath);
              if (draft.artifacts.some((a) => a.id === id)) {
                id = `${id}_${draft.artifacts.length + 1}`;
              }
              draft.artifacts.push({
                id,
                kind: 'file',
                path: filePath,
                verified: true,
                version: 1,
                createdAt: now,
              });
            }
          }
        }
      });
      return { unit: next };
    }
    case 'fail': {
      const unit = await requireResolved(workunits, args, sessionId);
      if (!Array.isArray(args.classes) || args.classes.length === 0) throw new Error("fail requires 'classes' (model|route|tool|state|control|delivery)");
      const next = await workunits.update(unit.id, args.ifRevision, (draft) => {
        draft.status = 'failed';
        draft.budget.failures += 1;
        for (const c of args.classes) if (!draft.failureClasses.includes(c)) draft.failureClasses.push(c);
      });
      return { unit: next };
    }
    default:
      throw new Error(`unknown op '${op}'`);
  }
}

/** Resolve args.id-or-current, throwing a tool-facing message when absent. */
async function requireResolved(workunits, args, sessionId) {
  const unit = await workunits.resolve(args.id, sessionId);
  if (!unit) throw new Error(args.id ? `workunit '${args.id}' not found` : 'no current workunit in this session');
  return unit;
}

/* ------------------------------------------------------------------------ */
/* apply                                                                     */
/* ------------------------------------------------------------------------ */

export function apply(ctx) {
  ctx.plugin(WorkUnits);

  ctx.systemPrompt.section({
    name: 'muse:workunit',
    order: 116,
    text: [
      '## WorkUnit — structured task state',
      'This harness keeps business-task state in WorkUnits (tool: `workunit`), separate from the chat transcript.',
      '- WORKFLOW DISCIPLINE: For any engineering task, coding, file modification, bug fix, or multi-step execution, you MUST invoke `workunit` op=create as your FIRST action to establish the objective and planned steps before executing mutations.',
      '- Do not perform workspace mutations (write, edit, or mutating shell commands) before a WorkUnit is created. Only pure conversational Q&A or read-only inquiries may proceed without a WorkUnit.',
      '- Keep step statuses current (workunit op=step) as you work; re-plan with op=plan when the approach changes.',
      '- Before risky operations or long waits, op=checkpoint so a crash can resume from structured state.',
      '- Register key deliverables with `workunit` op=artifact; on op=complete, files modified on disk during the task are also auto-collected as verified deliverables.',
      '- op=complete is refused without a real business verification (tests/build/human check). Tool success is not delivery.',
      '- Mutations are revision-guarded: pass ifRevision from your last read; on conflict, re-read and retry.',
    ].join('\n'),
  });

  ctx.tools.register(defineTool({
    name: 'workunit',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: { type: 'string', required: true, enum: [...OPS], description: 'Lifecycle operation.' },
      id: { type: 'string', description: 'Target workunit id. Omit to use this session\'s current unit.' },
      ifRevision: { type: 'integer', description: 'Revision from your last read of this unit. Required by all mutating ops except create.' },
      objective: { type: 'string', description: '[create] The immutable business objective.' },
      constraints: { type: 'array', items: { type: 'string' }, description: '[create] User/business constraints.' },
      addConstraints: { type: 'array', items: { type: 'string' }, description: '[update] Constraints to append.' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' },
        title: { type: 'string', required: true },
      } }, description: '[create|plan] Step list (replaces existing on plan).' },
      status: { type: 'string', enum: ['draft', 'active', 'waiting_approval', 'blocked', 'cancelled'], description: '[update] New unit status (done/failed go through complete/fail).' },
      stepId: { type: 'string', description: '[step] Step id.' },
      stepStatus: { type: 'string', enum: ['pending', 'in_progress', 'done', 'failed', 'skipped'], description: '[step] New step status.' },
      note: { type: 'string', description: '[step|checkpoint|complete|fail] Free-form note.' },
      artifactValue: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        kind: { type: 'string', required: true },
        path: { type: 'string' },
        hash: { type: 'string' },
        verified: { type: 'boolean' },
        verifyNote: { type: 'string' },
      }, description: '[artifact] Artifact to register or update (same id = new version).' },
      reason: { type: 'string', description: '[checkpoint] Why this resume point exists.' },
      verification: { type: 'string', description: '[complete] The business check that passed (tests/build/human confirmation).' },
      classes: { type: 'array', items: { type: 'string', enum: [...FAILURE_CLASSES] }, description: '[fail] Failure classification.' },
      budget: { type: 'object', additionalProperties: false, properties: {
        maxTokens: { type: 'number' },
        maxRounds: { type: 'number' },
        maxFailures: { type: 'number' },
      }, description: '[create] Optional budget limits.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const workunits = workunitsInstance;
      if (workunits === undefined) return { ok: false, error: 'workunits service unavailable' };
      const sessionId = exec.agent?.session.id;
      if (sessionId === undefined) return { ok: false, error: 'workunit tool requires an owning agent session' };
      try {
        const result = await runOp(workunits, sessionId, args);
        if (result.unit && args.op !== 'get') {
          await workunits.recordTransition(result.unit, args.op, typeof args.note === 'string' ? args.note : undefined);
        }
        return { ok: true, ...result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `WorkUnit ${args.op}`,
      kind: args.op === 'get' || args.op === 'list' ? 'read' : 'write',
    }),
  }));

}
