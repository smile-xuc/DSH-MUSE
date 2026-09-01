/**
 * dsh-eval — three-layer evaluation (Muse: 结果 / 轨迹 / 组件).
 *
 * Result:      did the business task actually deliver? (WorkUnit done AND a
 *              real verification recorded — never "the tools returned ok".)
 * Trajectory:  how did it get there? tool-call counts, duplicate side effects
 *              (same idempotency key executed twice), effects executed without
 *              approval, error-recovery turns, retries, wasted steps.
 * Component:   per-tool/per-model failure rates, so a weak component is fixed
 *              instead of the prompt being nudged.
 *
 * Failure taxonomy (Muse): model | route | tool | state | control | delivery.
 * Cost accounting: per SUCCESSFUL task — retries, escalations and verification
 * overhead all count toward the numerator; the denominator is verified tasks.
 *
 * Data sources: the `workunits`/`effectLedger`/`evidence` services plus the
 * durable session log via `ctx.sessionPersistence` (the same seam the
 * harness's own token meter uses). Computations are pure folds; results are
 * cached in the `eval` domain so reports are cheap and comparable over time.
 *
 * @module dsh-eval
 */
import { Service } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'eval';

/** Hard dependencies. */
export const inject = ['storageDomain', 'tools', 'systemPrompt', 'workunits', 'effectLedger', 'evidence', 'sessionPersistence'];

/* ------------------------------------------------------------------------ */
/* Schema                                                                    */
/* ------------------------------------------------------------------------ */

const FAILURE_CLASSES = ['model', 'route', 'tool', 'state', 'control', 'delivery'];

const recordSchema = z.object({
  workunitId: z.string(),
  sessionId: z.string(),
  computedAt: z.number(),
  result: z.object({
    status: z.string(),
    verifiedSuccess: z.boolean(),
    verificationMethod: z.string().optional(),
    artifactCount: z.number(),
    unverifiedArtifacts: z.number(),
  }),
  trajectory: z.object({
    toolCalls: z.number(),
    toolCallsByName: z.record(z.string(), z.number()),
    toolErrors: z.number(),
    turns: z.number(),
    llmRetries: z.number(),
    effectsProposed: z.number(),
    effectsExecuted: z.number(),
    duplicateEffects: z.number(),
    unapprovedEffects: z.number(),
    checkpoints: z.number(),
  }),
  component: z.object({
    toolFailures: z.record(z.string(), z.number()),
  }),
  cost: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    timeToSuccessMs: z.number().optional(),
  }),
  failures: z.array(z.string()),
});

const spec = defineDomain({
  name: 'eval',
  version: 1,
  tables: { records: domainTable(recordSchema) },
});

/* ------------------------------------------------------------------------ */
/* Trajectory fold                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Fold one session's durable events into trajectory + cost counters for the
 * window [from, to] (epoch ms). One usage sample per turn/step — an
 * assistant/message final sample replaces the step's chunk sample (the same
 * double-count guard the token meter uses).
 */
function foldSessionEvents(events, from, to) {
  const usageByStep = new Map();
  let toolCalls = 0;
  let toolErrors = 0;
  let turns = 0;
  let llmRetries = 0;
  const toolCallsByName = {};
  const toolFailures = {};
  for (const event of events) {
    if (event.time < from || (to !== undefined && event.time > to)) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    switch (event.type) {
      case 'turn/start':
        turns += 1;
        break;
      case 'tool/call':
        toolCalls += 1;
        toolCallsByName[data.name] = (toolCallsByName[data.name] ?? 0) + 1;
        break;
      case 'tool/result':
        if (data.error !== undefined && data.error !== null) {
          toolErrors += 1;
          const name = data.message?.name ?? 'unknown';
          toolFailures[name] = (toolFailures[name] ?? 0) + 1;
        }
        break;
      case 'llm/retry':
      case 'llm/retry-started':
        llmRetries += 1;
        break;
      case 'assistant/chunk':
        if (data.chunk?.type === 'usage') usageByStep.set(`${data.turn}:${data.step}`, event.time);
        break;
      case 'assistant/message':
        if (data.usage != null) usageByStep.set(`${data.turn}:${data.step}`, event.time);
        break;
      default:
        break;
    }
  }
  return { toolCalls, toolErrors, turns, llmRetries, toolCallsByName, toolFailures, usageByStep };
}

/** Sum token usage for the sampled steps (needs the events again for values). */
function sumUsage(events, stepKeys, from, to) {
  let input = 0;
  let output = 0;
  const seen = new Map();
  for (const event of events) {
    if (event.time < from || (to !== undefined && event.time > to)) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    let usage;
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'usage') usage = data.chunk.usage;
    else if (event.type === 'assistant/message' && data.usage != null) usage = data.usage;
    else continue;
    seen.set(`${data.turn}:${data.step}`, usage); // last wins
  }
  for (const key of stepKeys ?? seen.keys()) {
    const usage = seen.get(key);
    if (!usage) continue;
    input += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    output += usage.outputTokens ?? 0;
  }
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

/** Module-level handle — see dsh-workunit for why. */
let evalInstance;

class Eval extends Service {
  static inject = ['storageDomain', 'workunits', 'effectLedger', 'evidence', 'sessionPersistence'];

  constructor(ctx, config) {
    super(ctx, 'evaluation');
    evalInstance = this;
  }

  /** Lazily opened domain — see dsh-workunit for the rationale. */
  _domainPromise;

  _domain() {
    if (this._domainPromise === undefined) {
      this._domainPromise = this.ctx.storageDomain.open(spec).then((domain) => {
        this.ctx.effect(() => async () => {
          await domain.close();
        }, 'eval.domainClose');
        return domain;
      }).catch((error) => {
        this._domainPromise = undefined;
        throw error;
      });
    }
    return this._domainPromise;
  }

  async _recordsT() {
    return (await this._domain()).table('records');
  }

  /** Cached record for one unit (undefined when never computed). */
  async get(workunitId) {
    const records = await this._recordsT();
    return records.get(workunitId);
  }

  /** All cached records. */
  async list() {
    const records = await this._recordsT();
    return [...records.entries()].map(([, r]) => r);
  }

  /**
   * Compute the three-layer evaluation for one WorkUnit and cache it.
   * Reads the durable session log (detached, non-mutating).
   */
  async evaluate(workunitId, signal) {
    const unit = await this.ctx.workunits.get(workunitId);
    if (!unit) throw new Error(`workunit '${workunitId}' not found`);
    const to = unit.completedAt;
    const { events } = await this.ctx.sessionPersistence.readFrom(unit.sessionId, 0, signal);
    const fold = foldSessionEvents(events, unit.createdAt, to);
    const cost = sumUsage(events, undefined, unit.createdAt, to);

    const effects = await this.ctx.effectLedger.forWorkunit(workunitId);
    const effectsExecuted = effects.filter((e) => e.status === 'executed' || e.status === 'rolled_back');
    const duplicateEffects = effects.filter((e) => e.executeAttempts > 1 && e.status === 'executed').length;
    const unapprovedEffects = effectsExecuted.filter((e) => e.approval === null).length;

    const verifiedSuccess = unit.status === 'done' && unit.verification !== null;
    const unverifiedArtifacts = unit.artifacts.filter((a) => !a.verified).length;

    const failures = [...unit.failureClasses];
    // trajectory-inferred classes the model didn't declare:
    if (duplicateEffects > 0 && !failures.includes('control')) failures.push('control');
    if (fold.toolErrors > 0 && !verifiedSuccess && !failures.includes('tool')) failures.push('tool');
    if (unverifiedArtifacts > 0 && unit.status === 'done' && !failures.includes('delivery')) failures.push('delivery');

    const record = recordSchema.parse({
      workunitId,
      sessionId: unit.sessionId,
      computedAt: Date.now(),
      result: {
        status: unit.status,
        verifiedSuccess,
        ...(unit.verification !== null ? { verificationMethod: unit.verification.method } : {}),
        artifactCount: unit.artifacts.length,
        unverifiedArtifacts,
      },
      trajectory: {
        toolCalls: fold.toolCalls,
        toolCallsByName: fold.toolCallsByName,
        toolErrors: fold.toolErrors,
        turns: fold.turns,
        llmRetries: fold.llmRetries,
        effectsProposed: effects.length,
        effectsExecuted: effectsExecuted.length,
        duplicateEffects,
        unapprovedEffects,
        checkpoints: unit.checkpoint === null ? 0 : 1,
      },
      component: { toolFailures: fold.toolFailures },
      cost: {
        ...cost,
        ...(verifiedSuccess && to !== undefined ? { timeToSuccessMs: to - unit.createdAt } : {}),
      },
      failures,
    });
    const records = await this._recordsT();
    await records.put(workunitId, record);
    return record;
  }

  /**
   * Global metrics across every cached + computable unit:
   * verified_success, duplicate_side_effect_rate, time_to_success,
   * cost_to_success, failure-class distribution.
   */
  async summary(signal) {
    const units = await this.ctx.workunits.list();
    const records = [];
    for (const unit of units) {
      try {
        records.push(await this.evaluate(unit.id, signal));
      } catch {
        /* a session log may be unreadable (e.g. still live); skip, don't fail the report */
      }
    }
    const done = records.filter((r) => r.result.status === 'done');
    const verified = records.filter((r) => r.result.verifiedSuccess);
    const totalEffectsExecuted = records.reduce((n, r) => n + r.trajectory.effectsExecuted, 0);
    const totalDuplicates = records.reduce((n, r) => n + r.trajectory.duplicateEffects, 0);
    const failureDistribution = Object.fromEntries(FAILURE_CLASSES.map((c) => [c, 0]));
    for (const r of records) for (const f of r.failures) failureDistribution[f] = (failureDistribution[f] ?? 0) + 1;
    const successTimes = verified.map((r) => r.cost.timeToSuccessMs).filter((t) => t !== undefined);
    return {
      workunits: records.length,
      done: done.length,
      verifiedSuccess: verified.length,
      verifiedSuccessRate: records.length === 0 ? null : verified.length / records.length,
      duplicateSideEffectRate: totalEffectsExecuted === 0 ? null : totalDuplicates / totalEffectsExecuted,
      avgTimeToSuccessMs: successTimes.length === 0 ? null : Math.round(successTimes.reduce((a, b) => a + b, 0) / successTimes.length),
      totalTokens: records.reduce((n, r) => n + r.cost.totalTokens, 0),
      /** cost per VERIFIED task — the only honest denominator (Muse). */
      costPerVerifiedTaskTokens: verified.length === 0 ? null : Math.round(records.reduce((n, r) => n + r.cost.totalTokens, 0) / verified.length),
      failureDistribution,
    };
  }
}

/* ------------------------------------------------------------------------ */
/* Model-facing tool                                                         */
/* ------------------------------------------------------------------------ */

const TOOL_DESCRIPTION = `Evaluation reports over WorkUnits. Three layers: result (verified delivery, not tool success), trajectory (duplicate side effects, unapproved effects, retries, wasted steps), component (per-tool failure rates). Failures are classified model|route|tool|state|control|delivery.

Ops:
- evaluate: compute (and cache) the three-layer record for one workunit (default: current).
- summary: global metrics across all workunits — verified_success rate, duplicate_side_effect_rate, avg time-to-success, cost per verified task, failure distribution.
- get: read the cached record for one workunit.

Use after completing a unit, and when asked "how is the system performing".`;


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
      record: { type: 'json' },
      summary: { type: 'json' },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: (value.ok
      ? (value.summary
        ? `Eval summary: ${value.summary.verifiedSuccess}/${value.summary.workunits} verified, duplicate-effect rate ${value.summary.duplicateSideEffectRate ?? 'n/a'}, cost/verified-task ${value.summary.costPerVerifiedTaskTokens ?? 'n/a'} tokens.`
        : `Eval ${value.record?.workunitId ?? ''}: verified=${value.record?.result.verifiedSuccess}, tools=${value.record?.trajectory.toolCalls}, tokens=${value.record?.cost.totalTokens}.`)
      : `eval op failed: ${value.error ?? 'unknown error'}`) + museTrailer('eval', value),
  }],
};

/* ------------------------------------------------------------------------ */
/* apply                                                                     */
/* ------------------------------------------------------------------------ */

export function apply(ctx) {
  ctx.plugin(Eval);

  ctx.systemPrompt.section({
    name: 'muse:eval',
    order: 119,
    text: [
      '## Evaluation',
      'After completing a WorkUnit, run `eval_report` op=evaluate to record its three-layer score (result/trajectory/component).',
      'A task only counts as successful when verification is recorded — never confuse tool success with delivery.',
    ].join('\n'),
  });

  ctx.tools.register(defineTool({
    name: 'eval_report',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: { type: 'string', required: true, enum: ['evaluate', 'summary', 'get'], description: 'Eval operation.' },
      workunitId: { type: 'string', description: 'Target unit (default: current).' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const evaluation = evalInstance;
      if (evaluation === undefined) return { ok: false, error: 'eval service unavailable' };
      try {
        switch (args.op) {
          case 'evaluate': {
            const id = args.workunitId ?? await ctx.workunits?.currentId(exec.agent?.session.id);
            if (id === undefined) return { ok: false, error: 'no workunit specified and no current unit' };
            const record = await evaluation.evaluate(id, exec.signal);
            return { ok: true, record };
          }
          case 'summary': {
            return { ok: true, summary: await evaluation.summary(exec.signal) };
          }
          case 'get': {
            const id = args.workunitId ?? await ctx.workunits?.currentId(exec.agent?.session.id);
            if (id === undefined) return { ok: false, error: 'no workunit specified and no current unit' };
            const record = await evaluation.get(id);
            if (!record) return { ok: false, error: `no eval record for '${id}' — run evaluate first` };
            return { ok: true, record };
          }
          default:
            return { ok: false, error: `unknown op '${args.op}'` };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Eval ${args.op}`, kind: 'read' }),
  }));
}
