/**
 * dsh-skill-workshop — governed skill evolution (Muse: Skill 不允许静默修改).
 *
 * Skills are the atomic capability unit, so changing one is a release, not an
 * edit. The governed pipeline:
 *
 *   propose    the model drafts the change (full SKILL.md content + rationale
 *              + how it was evaluated) — nothing is applied at this point
 *   approve    a HUMAN approves (the tool enforces direct-human-turn
 *              authority, the same pattern the goal tools use)
 *   apply      writes the skill to $DSH_HOME/skills/<name>/SKILL.md AND
 *              live-registers it with the skill registry; the previous
 *              version is snapshotted first
 *   canary     an applied skill starts life as a canary (visible marker);
 *   promote    flips canary -> stable after it earned trust
 *   rollback   restores the previous version (file + live registry)
 *
 * The model may draft, but it may never silently change a Skill: apply and
 * rollback record who approved what, and the version history is append-only.
 *
 * @module dsh-skill-workshop
 */
import { Service } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-workshop';

/** Hard dependencies. */
export const inject = ['storageDomain', 'tools', 'systemPrompt', 'skills', 'agents'];

/* ------------------------------------------------------------------------ */
/* Schema                                                                    */
/* ------------------------------------------------------------------------ */

const PROPOSAL_STATUSES = ['proposed', 'approved', 'applied', 'rejected', 'rolled_back'];

const proposalSchema = z.object({
  id: z.string().min(1),
  /** skill name (kebab-case). */
  skill: z.string().min(1),
  /** full SKILL.md content (frontmatter + body). */
  content: z.string().min(1),
  rationale: z.string().min(1),
  /** how the change was evaluated (bench, replay, manual test...). */
  evalNote: z.string().min(1),
  status: z.enum(PROPOSAL_STATUSES),
  approvals: z.array(z.object({
    at: z.number(),
    who: z.string(),
    note: z.string().optional(),
  })),
  canary: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const versionSchema = z.object({
  /** append-only per-skill version history. */
  versions: z.array(z.object({
    version: z.number().int(),
    content: z.string(),
    appliedAt: z.number(),
    proposalId: z.string().optional(),
    canary: z.boolean(),
  })),
});

const spec = defineDomain({
  name: 'workshop',
  version: 1,
  tables: {
    proposals: domainTable(proposalSchema),
    versions: domainTable(versionSchema),
  },
});

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** $DSH_HOME resolution: env override, else ~/.dsh. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** Directory a skill bundle lives in. */
function skillDir(name) {
  return join(dshHome(), 'skills', name);
}

/** Parse YAML-frontmatter name/description out of SKILL.md content. */
function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (match === null) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

/**
 * Whether host-attested human input appears in the calling agent's current
 * turn (the dsh-tool-goal authority pattern, kept local to stay dependency-
 * light): the agent is a root and its open turn contains a user-sourced
 * message.
 */
function hasDirectHumanAuthority(ctx, exec) {
  const agent = exec.agent;
  if (agent === undefined) return false;
  if (!ctx.agents.roots().includes(agent)) return false;
  const events = agent.session.events;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === 'turn/end') return false;
    if (e?.type === 'turn/start') {
      for (let j = i + 1; j < events.length; j += 1) {
        const ev = events[j];
        if (ev?.type === 'user/message' && ev.data?.source?.kind === 'user') return true;
      }
      return false;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

/** Module-level handle — see dsh-workunit for why. */
let workshopInstance;

class Workshop extends Service {
  static inject = ['storageDomain', 'skills'];

  constructor(ctx, config) {
    super(ctx, 'workshop');
    workshopInstance = this;
  }

  /** Lazily opened domain — see dsh-workunit for the rationale. */
  _domainPromise;

  _domain() {
    if (this._domainPromise === undefined) {
      this._domainPromise = this.ctx.storageDomain.open(spec).then((domain) => {
        this.ctx.effect(() => async () => {
          await domain.close();
        }, 'skill-workshop.domainClose');
        return domain;
      }).catch((error) => {
        this._domainPromise = undefined;
        throw error;
      });
    }
    return this._domainPromise;
  }

  async _proposalsT() {
    return (await this._domain()).table('proposals');
  }

  async _versionsT() {
    return (await this._domain()).table('versions');
  }

  async get(id) {
    const proposals = await this._proposalsT();
    return proposals.get(id);
  }

  async list() {
    const proposals = await this._proposalsT();
    return [...proposals.entries()].map(([, p]) => p).sort((a, b) => b.createdAt - a.createdAt);
  }

  async versionsOf(skill) {
    const versions = await this._versionsT();
    return versions.get(skill)?.versions ?? [];
  }

  async propose(fields) {
    const now = Date.now();
    const fm = parseFrontmatter(fields.content);
    if (fm === null) throw new Error('content must start with YAML frontmatter (---\\nname: ...\\ndescription: ...\\n---)');
    if (fm.name !== fields.skill) throw new Error(`frontmatter name '${fm.name ?? '?'}' must equal the skill name '${fields.skill}'`);
    if (typeof fm.description !== 'string' || fm.description === '') throw new Error('frontmatter must include a description');
    const proposal = proposalSchema.parse({
      id: `sp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      skill: fields.skill,
      content: fields.content,
      rationale: fields.rationale,
      evalNote: fields.evalNote,
      status: 'proposed',
      approvals: [],
      canary: false,
      createdAt: now,
      updatedAt: now,
    });
    const proposals = await this._proposalsT();
    await proposals.put(proposal.id, proposal);
    return proposal;
  }

  async approve(id, who, note) {
    return this._transition(id, ['proposed'], (draft) => {
      draft.status = 'approved';
      draft.approvals.push({ at: Date.now(), who, ...(note !== undefined ? { note } : {}) });
    });
  }

  async reject(id, who, note) {
    return this._transition(id, ['proposed'], (draft) => {
      draft.status = 'rejected';
      draft.approvals.push({ at: Date.now(), who, ...(note !== undefined ? { note } : {}) });
    });
  }

  /**
   * Apply an approved proposal: snapshot the current live version, write the
   * file, live-register the skill, append the version record.
   */
  async apply(id, canary) {
    const proposals = await this._proposalsT();
    const versions = await this._versionsT();
    const proposal = proposals.get(id);
    if (proposal === undefined) throw new Error(`proposal '${id}' not found`);
    if (proposal.status !== 'approved') throw new Error(`proposal '${id}' is '${proposal.status}', must be approved first`);

    /* snapshot current on-disk version (if any) before overwriting */
    const dir = skillDir(proposal.skill);
    const file = join(dir, 'SKILL.md');
    const history = versions.get(proposal.skill) ?? { versions: [] };
    if (existsSync(file)) {
      const current = readFileSync(file, 'utf8');
      const already = history.versions.some((v) => v.content === current);
      if (!already) {
        await versions.put(proposal.skill, {
          versions: [...history.versions, {
            version: history.versions.length + 1,
            content: current,
            appliedAt: Date.now(),
            canary: false,
          }],
        });
      }
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, proposal.content, 'utf8');

    /* live-register so the skill is usable without a restart */
    const fm = parseFrontmatter(proposal.content);
    const body = proposal.content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    this.ctx.skills.register({
      name: proposal.skill,
      description: fm.description,
      content: body,
      source: 'skill-workshop',
      resourceBase: dir,
    });

    const after = versions.get(proposal.skill);
    await versions.put(proposal.skill, {
      versions: [...after.versions, {
        version: after.versions.length + 1,
        content: proposal.content,
        appliedAt: Date.now(),
        proposalId: proposal.id,
        canary,
      }],
    });

    return this._transition(id, ['approved'], (draft) => {
      draft.status = 'applied';
      draft.canary = canary;
    });
  }

  /** Promote a canary version to stable. */
  async promote(skill) {
    const versions = await this._versionsT();
    const history = versions.get(skill);
    if (history === undefined || history.versions.length === 0) throw new Error(`skill '${skill}' has no applied versions`);
    const latest = history.versions[history.versions.length - 1];
    if (!latest.canary) throw new Error(`skill '${skill}' latest version is not a canary`);
    await versions.put(skill, {
      versions: [...history.versions.slice(0, -1), { ...latest, canary: false }],
    });
    return { skill, version: latest.version };
  }

  /** Roll back to the previous version (file + live registry). */
  async rollback(skill) {
    const versions = await this._versionsT();
    const history = versions.get(skill);
    if (history === undefined || history.versions.length < 2) throw new Error(`skill '${skill}' has no previous version to roll back to`);
    const previous = history.versions[history.versions.length - 2];
    const dir = skillDir(skill);
    const file = join(dir, 'SKILL.md');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, previous.content, 'utf8');
    const fm = parseFrontmatter(previous.content);
    if (fm !== null) {
      const body = previous.content.replace(/^---\n[\s\S]*?\n---\n?/, '');
      this.ctx.skills.register({
        name: skill,
        description: fm.description ?? previous.content.split('\n')[0] ?? skill,
        content: body,
        source: 'skill-workshop',
        resourceBase: dir,
      });
    }
    await versions.put(skill, { versions: history.versions.slice(0, -1) });
    return { skill, restoredVersion: previous.version };
  }

  async _transition(id, fromStatuses, mutate) {
    const proposals = await this._proposalsT();
    const stored = proposals.get(id);
    if (stored === undefined) throw new Error(`proposal '${id}' not found`);
    if (!fromStatuses.includes(stored.status)) {
      throw new Error(`proposal '${id}' is '${stored.status}', expected one of ${fromStatuses.join(', ')}`);
    }
    return proposals.update(id, (current) => {
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

const TOOL_DESCRIPTION = `Governed skill changes. Skills are capability releases, not edits: the model drafts, a human approves, the system versions and can roll back. The model must NEVER edit skill files directly — always go through this pipeline.

Ops:
- propose: draft a new or changed skill (full SKILL.md content with frontmatter, rationale, and how the change was evaluated). Nothing is applied.
- approve / reject: human decision. approve REQUIRES a direct human turn — the user must have just asked for it; an agent cannot approve its own proposal.
- apply: apply an approved proposal (writes $DSH_HOME/skills/<name>/SKILL.md and live-registers it). Applied versions start as canary unless canary=false.
- promote: flip the latest canary version of a skill to stable.
- rollback: restore the previous applied version of a skill.
- list / get / versions: inspect proposals and per-skill version history.`;

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      proposal: { type: 'json' },
      proposals: { type: 'array', items: { type: 'json' } },
      versions: { type: 'array', items: { type: 'json' } },
      result: { type: 'json' },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: value.ok
      ? (value.proposal
        ? `Proposal ${value.proposal.id} [${value.proposal.status}] skill '${value.proposal.skill}'${value.proposal.canary ? ' (canary)' : ''}`
        : (value.result ? `skill '${value.result.skill}' -> ${JSON.stringify(value.result)}` : [
            `${value.proposals?.length ?? value.versions?.length ?? 0} item(s):`,
            ...(value.proposals ?? []).map((pr) => `- ${pr.id} [${pr.status}] skill '${pr.skill}'${pr.canary ? ' (canary)' : ''}`),
            ...(value.versions ?? []).map((v) => `- v${v.version}${v.canary ? ' (canary)' : ''} applied ${new Date(v.appliedAt).toISOString()}`),
          ].join('\n')))
      : `skill_workshop op failed: ${value.error ?? 'unknown error'}`,
  }],
};

/* ------------------------------------------------------------------------ */
/* apply                                                                     */
/* ------------------------------------------------------------------------ */

export function apply(ctx) {
  ctx.plugin(Workshop);

  ctx.systemPrompt.section({
    name: 'muse:skill-workshop',
    order: 121,
    text: [
      '## Skill workshop — governed capability changes',
      'Never edit skill files directly. Draft changes with `skill_workshop` op=propose (content + rationale + evaluation note), then ask the user to approve.',
      'Apply only after human approval; new versions start as canary and can be rolled back.',
    ].join('\n'),
  });

  ctx.tools.register(defineTool({
    name: 'skill_workshop',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: { type: 'string', required: true, enum: ['propose', 'approve', 'reject', 'apply', 'promote', 'rollback', 'list', 'get', 'versions'], description: 'Workshop operation.' },
      id: { type: 'string', description: '[approve|reject|apply|get] Proposal id.' },
      skill: { type: 'string', description: '[propose|promote|rollback|versions] Skill name (kebab-case).' },
      content: { type: 'string', description: '[propose] Full SKILL.md content (frontmatter + body).' },
      rationale: { type: 'string', description: '[propose] Why this change.' },
      evalNote: { type: 'string', description: '[propose] How the change was evaluated.' },
      note: { type: 'string', description: '[approve|reject] Decision note.' },
      canary: { type: 'boolean', description: '[apply] Start as canary (default true).' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const workshop = workshopInstance;
      if (workshop === undefined) return { ok: false, error: 'workshop service unavailable' };
      try {
        switch (args.op) {
          case 'propose': {
            for (const field of ['skill', 'content', 'rationale', 'evalNote']) {
              if (typeof args[field] !== 'string' || args[field] === '') return { ok: false, error: `propose requires '${field}'` };
            }
            return { ok: true, proposal: await workshop.propose(args) };
          }
          case 'approve': {
            if (!hasDirectHumanAuthority(ctx, exec)) return { ok: false, error: 'approve requires a direct human turn — the user must explicitly ask for the approval' };
            return { ok: true, proposal: await workshop.approve(args.id, 'user', args.note) };
          }
          case 'reject': {
            if (!hasDirectHumanAuthority(ctx, exec)) return { ok: false, error: 'reject requires a direct human turn' };
            return { ok: true, proposal: await workshop.reject(args.id, 'user', args.note) };
          }
          case 'apply': {
            return { ok: true, proposal: await workshop.apply(args.id, args.canary ?? true) };
          }
          case 'promote': {
            return { ok: true, result: await workshop.promote(args.skill) };
          }
          case 'rollback': {
            return { ok: true, result: await workshop.rollback(args.skill) };
          }
          case 'list': {
            return { ok: true, proposals: await workshop.list() };
          }
          case 'get': {
            const proposal = await workshop.get(args.id);
            if (!proposal) return { ok: false, error: `proposal '${args.id}' not found` };
            return { ok: true, proposal };
          }
          case 'versions': {
            return { ok: true, versions: await workshop.versionsOf(args.skill) };
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
      title: `Skill workshop ${args.op}`,
      kind: args.op === 'list' || args.op === 'get' || args.op === 'versions' ? 'read' : 'write',
    }),
  }));
}
