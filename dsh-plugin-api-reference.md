# DSH Host-Plugin API Reference — cordis service seams

Runtime under inspection: `/Users/bruce/Library/Application Support/ai.deepseek.harness/runtime/node_modules/@deepseek-ai/` (all packages version `0.1.1-rc.2`). Paths below are written as `@deepseek-ai/<pkg>/lib/...` relative to that root. Every package ships compiled ESM at `lib/index.js` with preserved JSDoc, plus type faces at `lib/types/*.d.ts`.

## 0. Plugin anatomy (canonical pattern)

From the user examples (`~/.dsh/profiles/plugins/dsh-token-stats`, `dsh-web-search-bailian`) and in-repo plugins:

```js
// lib/index.js — host half
export const name = 'my-plugin';                    // cordis plugin name (loader diagnostics)
export const inject = ['tools', 'sessionPersistence']; // hard cordis service dependencies
// Optional: export const Config = z.object({...})   // schemastery (@deepseek-ai/schemastery)
export function apply(ctx, config = {}) {
  const logger = ctx.logger(name);
  const dispose = ctx.tools.register(/* ... */);    // registrations return effect disposers
  // Optional soft dependency:
  ctx.inject(['sessionProjections'], (pctx) => { /* runs only if that service exists */ });
}
```

- `package.json`: `"type": "module"`, `"main": "lib/index.js"`, `exports["."]`. An optional `"./client"` export + a `dsh.client` manifest block (`inject` list of client packages, `platform: "web"`) ships a browser bundle (see dsh-token-stats).
- Cordis basics: `ctx.on(event, listener)` subscribes; listeners registered on a context are disposed with the plugin fiber. `ctx.effect(() => disposer, label?)` ties cleanup to unload. Most `register*` APIs already return "the exact effect disposer".
- **Scoping**: registering through a plain plugin `ctx` is **global**; registering through an agent-scoped context (`agent.ctx`, or the `setup(agentCtx)` callback of `agents.create`) is **scoped to that agent** and shadows the global entry of the same name. Scope-filtered event dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's events.

---

## 1. Tools — `@deepseek-ai/dsh-tools`

**Service name: `tools`** (`class ToolRuntime extends Service`, `super(ctx, 'tools')` — `dsh-tools/lib/index.js:2553,2592`; types `dsh-tools/lib/types/index.d.ts`).

### Registration

```js
import { defineTool } from '@deepseek-ai/dsh-tools';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register(defineTool({ /* ... */ }));   // -> disposer; duplicate names throw
}
```

`defineTool(options)` (`dsh-tools/lib/index.js:836`, options interface `lib/types/schema.d.ts:178 DefineToolOptions`):

| Field | Type | Notes |
|---|---|---|
| `name` | string | unique; model-facing |
| `description` | string | sent to the model |
| `parameters` | `ParameterSchemaSpec` | author DSL (below), compiled to strict JSON Schema |
| `output.schema` | `ValueSchemaSpec` | **mandatory** — `register()` hard-fails without `output { schema, render, presentationMeta? }` (`dsh-tools/lib/index.js:2765`); enforced against every successful return value |
| `output.render(args, value)` | → `ContentBlock[]` | pure projection to model-facing content (e.g. `[{type:'text', text}]`) |
| `output.presentationMeta?(args, value)` | → `JsonValue` | tool-private replay payload, logged on `tool/result.meta` |
| `execute(args, exec)` | → `Promise<value>` | returns the **canonical JSON value** (must satisfy `output.schema`), not content blocks |
| `timeoutMs?` | number | cooperative timeout, enforced by dsh-tool-call-timeout-policy via signal |
| `isConcurrencySafe?(args)` | → boolean | only exact `true` opts into parallel dispatch |
| `finalizeContent?(exec, result)` | → `ContentBlock[] \| undefined` | last-mile content transform, must be total |
| `presentCall?(args)` / `presentResult?(args, result)` | → `ToolCallView` / `ToolResultView` | pure UI card descriptors, replay-safe |

**Parameter DSL** (`schema.d.ts`): `{ [key]: ValueSchemaSpec & { required?: true } }`. Value specs: `{type:'string'|'number'|'integer'|'boolean'|'null', enum?, description?…}`, `{type:'array', items, required?}`, `{type:'object', properties, additionalProperties: boolean}` (openness is **mandatory** on every object), `{type:'json'}`, `{oneOf: [a, b, …]}`. Per-property `required: true` marks requiredness. Invalid model args are auto-rejected with `ToolArgsError` before `execute` runs.

### Execution context `exec` (`ToolRunContext`, `lib/types/index.d.ts:300`)

`exec` = frozen call identity + cancellation:
- `exec.name`, `exec.arguments` (deep-frozen parsed args), `exec.callId`, `exec.rootCallId`, `exec.token`
- `exec.agent` — the calling `Agent` (undefined for agentless calls; check before using, cf. dsh-tool-todo: `if (!exec.agent) throw …`)
- `exec.signal` — **AbortSignal; async work must observe/forward it**
- `exec.deferContext(userMessage)` — attach a user-role context message the loop appends after this tool's result
- `exec.concludeTurn()` — mark a successful result as turn-terminal
- **There is no `ctx`/`session`/`toolCall` on `exec`** — reach the session as `exec.agent.session`; reach services via the `apply` closure's `ctx` (cf. ask-user calling `ctx.userQuestions.ask(...)`)

`ToolRuntime`'s own `static inject = ["systemPrompt"]` (it registers prompt sections for code mode). Registration disposal is automatic: `register()` runs as a cordis effect owned by the *calling plugin's* fiber (cordis traceable service proxy), so tools unregister + emit `tools/change` on plugin unload/HMR — the in-repo tool plugins never capture the disposer. Durable `tool/call` / `tool/result` session events are appended by **dsh-agent-loop**, not by the registry.

### Result path

`execute` returns the canonical value → validated against `output.schema` (`ToolOutputError` on violation) → `output.render(args, value)` produces the model-facing `content` → logged as durable `tool/result` session event (`{turn, step, message: ToolResultMessage, error?, meta?}`; **the canonical `value` itself is deliberately NOT logged**). Errors thrown from `execute` become `{isError:true, error:{message, info:{name, code}}, content:[{type:'text', text:'Error: …'}]}` results.

### Tool pipeline events (cordis, all scope-filtered by agent)

Declared in `dsh-tools/lib/types/index.d.ts:24–94`:

- **`tools/pre-execute`** (waterfall) `(exec, next) => PreToolDecision` — allow / `{kind:'deny', reason}` / `{kind:'ask', reason?}` before dispatch. `ask` routes into `ctx.approval`.
- **`tools/execute`** (waterfall) `(exec, next) => ToolExecutionResult` — around-dispatch; wrappers may only replace `exec.signal` (registry fuses caller cancellation back). Used by dsh-tool-call-timeout-policy.
- **`tools/post-execute`** (waterfall) `(exec, result, next) => PostToolDecision` — accept (optionally replacing `content` or `value`, attaching `additionalContexts`) or `{kind:'block', feedback}` (turns corrective feedback into an error result).
- **`tools/result`** (emit) `(exec, result)` — observe the frozen final outcome.
- **`tools/change`** (emit) — registry/restriction changed (unfiltered).
- **`tools/code-dispatch-log`** (waterfall) — reshape the durable log copy of a `run_code` sub-dispatch.

### Other `ctx.tools` methods

- `register(definition) → () => void`; `restrict({allow?, deny?}) → disposer` (per-scope visibility mask); **`guard((exec) => string | undefined) → disposer`** — monotonic guard after pre-execute; a returned string denies, no guard can force-allow.
- `get(name, scope?)`, `schemas(scope?)`, `executionMode(exec)`, `execute(execInput)` (programmatic dispatch), `presentAs(mode)` (code-mode presentation, scoped only).
- Config: `{ mode?: 'native'|'code'|'both', maxParallelSubCalls?: number }`.

### Reference patterns

- Minimal: `dsh-tool-todo/lib/index.js:97` — `ctx.tools.register(defineTool({…}))`; also registers a session projection under `ctx.inject(['sessionProjections'], …)`.
- Blocking on a human: `dsh-tool-ask-user/lib/index.js` — `inject = ['tools','userQuestions']`; `execute` awaits `ctx.userQuestions.ask({questions, agent: exec.agent, signal: exec.signal})` and maps the answer into the output value.
- Multi-tool: `dsh-tool-goal/lib/index.js:258–295` — several `ctx.tools.register(defineTool(...))` plus a `ctx.systemPrompt.section({...})`.

---

## 2. Agents & lifecycle — `@deepseek-ai/dsh-agent`, `dsh-agent-loop`

**Service names: `agents`** (`AgentRegistry`, `dsh-agent/lib/index.js:415,425`) and **`agentLoop`** (`AgentLoop`, factory/driver, `dsh-agent-loop/lib/index.js:1002`).

### `ctx.agents` (`dsh-agent/lib/types/index.d.ts:209`)

- `create(options: CreateAgentOptions) → Promise<AgentHandle {agent, dispose()}>`
  - options: `{ sessionId, meta?: {cwd?, parentSession?, seedLength?, origin?: 'subagent', delegationDepth?, agentPreset?}, seed?: SessionEvent[], agentOptions?: {provider?, model?, maxTokens?}, signal?, setup? }`
  - `setup(agentCtx)` runs **before publication**: everything registered there (scoped tools, prompt sections, listeners) exists before `session/created`/`agent/created`.
- `resume(options)`, `get(id: SessionId) → Agent | undefined`, `list() → Agent[]`, `roots() → Agent[]`, `register(agent)`, `isOwnedBy(id, owner)`, `setFactory(factory)` (loop-owned), `currentInitiator()/requireInitiator()/withInitiator()`.

### Agent object shape (`dsh-agent/lib/types/runtime-types.d.ts:60`)

```ts
agent.id        // SessionId (shared with session)
agent.options   // { provider?, model?, maxTokens? }
agent.session   // Session — the durable log
agent.inbox     // pending input projection
agent.status    // 'idle' | 'running'
agent.ctx       // agent-scoped cordis context (register scoped tools/listeners here)
agent.cancel(cause, options?)
agent.whenIdle(): Promise<void>
agent.runMaintenance(task)
agent.send(message, target, wakeup) / followup(message) / steer(message) / inject(message)
```

There is **no `agent.events` emitter** — all observation is via cordis events (`ctx.on`). `session.events` is the immutable log **array**, not an emitter.

### Live cordis events (`dsh-agent/lib/types/runtime-types.d.ts:134–323`; all scope-filtered)

| Event | Mode | Payload (plus `agent`) |
|---|---|---|
| `agent/created` | emit | — (sync listener failure vetoes publication) |
| `agent/disposed` | emit | — |
| `agent/status` | emit | `{status: 'idle'\|'running'}` |
| `agent/session-start` | emit | `{source: 'startup'\|'resume'\|'clear'\|'compact'}` — first startup hook; use `agent.inject()` to seed context |
| `agent/inbox/inserted` / `agent/inbox/claimed` / `agent/inbox/discarded` | emit | `{message(, turn)}` |
| **`agent/pre-step`** | **waterfall** | `{messages, turn, step, signal}` → return `{kind:'reject'}` or `{kind:'enter', messages}` (replace step input) |
| **`agent/request`** | **waterfall** | `{turn, step, signal}` → `await next()` yields the frozen `LlmCallConfig`; return a replacement — **the before-model-request seam** |
| **`agent/request-error`** | **waterfall** | `{turn, step, provider, failure, retryPolicy, signal}` → `{kind:'retry'}` or `next()` |
| **`agent/turn-stopping`** | **serial** | `{turn, signal}` — object to a turn close by calling `agent.steer(...)` |
| `agent/error` | emit | `{turn, step, error}` |

There are **no APIs named `addInterceptor`/`use`/`beforeToolCall`** (grep-verified). Interception = waterfall/serial listeners above plus the `tools/*` waterfalls (§1) and `system-prompt/assemble` (§4).

### Durable session events (the log vocabulary)

`SessionEventMap` (`dsh-session/lib/types/types.d.ts:223`): `turn/start {turn}`, `turn/end {turn, reason}` (reason: `completed | aborted{cause} | blocked | error{error} | max-tokens | interrupted`), `step/start`, `step/end`, `user/message`, `assistant/chunk {turn,step,chunk}`, `assistant/message {turn,step,message,usage?,interrupted?}`, `tool/call {turn,step,callId,name,arguments(raw JSON string)}`, `tool/result {turn,step,message,error?,meta?}`, `request/header`, `request/context`, `todo/write`, `session/end-seed`. Full 48-entry catalog (this build): `dsh-session/lib/types/known-event-types.js` (adds `goal/change`, `approval/*`, `compaction/*`, `command/run|done`, `hook/*`, `plan/mode`, `sandbox/mode`, `permission/preset`, `subagent/descriptor`, `team/*`, `tool-workflow/*`, `llm/retry*`, `session/title*`, `feedback/record`, `schedule/change`, `agent-preset/selected`, `agent/inbox/spliced`, `web/deepseek-search-llm-request`). No `model/*` event types exist.

### Subagents — `ctx.subagents` (`SubagentRuntime`, `@deepseek-ai/dsh-subagent`)

- One-shot: `await ctx.subagents.start(providerName, { prompt: ContentBlock[], parent: agent, signal, label?, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }) → SubagentRun { id, localAgent, result: Promise<SubagentResult>, dispose() }`; `result` does not reject on child failure — check `stopReason` (`completed|aborted|error|max-tokens|refusal`); always `dispose()`.
- Continuable/background: `startContinuable(spec) → {childId, messageId}`, `followup(parent, childId, content, opts)`, `interrupt(id, authority)`, `reportFrom(child, content, opts)`, `listChildren/listDescendants`, `drainContinuableChildren`.
- Provider registry: `registerProvider(provider)`, events `subagent/provider-added`, `subagent/provider-removed`, `subagent/start(info)`, `subagent/end(info)` (scoped to the delegating parent). In-process provider name: `"spawn"` (fork: `"fork"`). Reference: `dsh-tool-subagent/lib/index.js`.

---

## 3. Session & persistence — `dsh-session`, `dsh-session-persistence(-jsonl)`, `dsh-session-projection`

### `ctx.sessions` (`SessionStore`, `dsh-session/lib/index.js:1584`; types `lib/types/index.d.ts:290`)

`create(id?, options?)`, `prepare(id?, options?)`, `enter/announce`, `get(id)`, `list()`, `flush(session) → Promise<boolean>` (durability checkpoint), `fork(source, boundary?, childId?)`.

Cordis events (`lib/types/index.d.ts:32–76`, scope-filtered):
- `session/created(session)`, `session/disposed(session)`
- **`session/event(session, event)`** — post-commit firehose for every appended durable event (listener failures contained)
- `session/flush(session)` — awaited durability barrier for persistence plugins

### `Session` object

`id`, `header: SessionHeader {version, id, createdAt, cwd?, parentSession?, seedLength?, origin?, delegationDepth?, agentPreset?}`, `events: readonly SessionEvent[]` (immutable snapshot), `seq`, `firstLiveSeq`, `surface`, `requestHeader()`, `requestContext()`, `deriveMessages()`, and:

```ts
session.append(type: string, data: JsonValue, opts? /* surface events only */): SessionEvent
```

- Data must be **losslessly JSON-serializable** (no BigInt/function/Date/Map/undefined/cycles) — validated at append.
- Event envelope: `{ type, seq, time /* epoch ms */, data, ignorable?: true, sourceEventSeqs? / surfaceOp? /* surface events only */ }`.
- **⚠ CRITICAL CAVEAT (verified)**: `Session.append` gives **no way to set `ignorable: true`** (`dsh-session/lib/index.js:1444–1463`), and `dsh-session-persistence` **refuses to read any stored log containing an event type outside the build's `KNOWN_SESSION_EVENT_TYPES` catalog unless that event carries `ignorable: true`** (`dsh-session-persistence/lib/index.js:1117–1122`, enforced on `readFrom`, `load`, `prepare` — lines 958/979/994/1291). The catalog note says: "Downstream (out-of-repo) plugin events are outside this list by construction; a registration surface for them is deferred." ⇒ **A third-party plugin must NOT append custom event types to session logs — it would brick the log for every future read.** In-repo plugins get away with it because their types (`goal/change`, `todo/write`) are baked into the catalog. For plugin-private durable state, use §7 (storage domains) instead. Appending **existing catalog types** (e.g. `todo/write`) is safe.
- TS-side, in-repo packages extend the vocabulary by declaration-merging `SessionEventMap` (e.g. `dsh-goal/lib/types/domain.d.ts:46`).

### `ctx.sessionPersistence` (`SessionPersistence` abstract service, `dsh-session-persistence/lib/index.js:1349`; types `lib/types/index.d.ts:60`)

Read-mostly surface for plugins (exactly what dsh-token-stats uses):

- `listSnapshots(signal?) → Promise<SessionPersistenceSnapshot[]>` — one `{ header: SessionHeader, revision }` per materialized session; **revision is an opaque change token** — unchanged logs keep the same revision (cache key).
- `readFrom(id, fromSeq, signal?) → Promise<{ meta: SessionHeader, events: SessionEvent[] }>` — detached physical suffix read, no recovery; reflects the durable prefix only; safe on live sessions; `fromSeq` beyond the end returns empty.
- `list(signal?) → Promise<SessionHeader[]>` — cheap header-only listing.
- `inspect(id, signal?) → Promise<{meta, events}>` (in-memory recovery, no commit), `load(id)` (commits crash-recovery; rejects for a live session with an open turn), `prepare(id, signal?)` (resume machinery).
- Write side: `create(meta)`, `append(id, events)` — these are the **backend's** write path driven by the harness, not a plugin API for custom events.
- `locate(meta) → {path} | undefined`, `readRaw(id, signal?)` (verbatim artifact, if `supportsRawArtifacts`).

JSONL backend (`dsh-session-persistence-jsonl`): one artifact per session at `<root>/<project-dir-slug>/<sessionId>.jsonl` (or `.jsonl.zstd`); project dir derived from session `cwd`, `_no-cwd` otherwise.

### Derived state: `ctx.sessionProjections` (`SessionProjectionRegistry`, `dsh-session-projection/lib/index.js:38`; types `lib/types/index.d.ts`)

Framework-driven fold over committed session events. Register (typically under `ctx.inject(['sessionProjections'], …)` so headless assemblies still load):

```js
ctx.inject(['sessionProjections'], (pctx) => {
  pctx.sessionProjections.register({
    key: 'myKey',                    // string key
    stateSchema: zodSchema,          // validates persisted checkpoints
    init: () => initialState,        // SYNC, plain JSON
    apply: (state, event) => nextState,  // SYNC pure fold; return same reference when uninterested
    wire: { viewSchema, view: (state) => clientValue },  // omit for host-only units
    stateVersion: 1,                 // bump to invalidate persisted caches
  });
});
```

Also: `onChanged(listener)`, `stateOf(session, key)`, `snapshot(session) → {asOfSeq, values}`. Registrations sharing a key are reference-counted. Canonical example: the `todos` projection in `dsh-tool-todo/lib/index.js:80–96`. Persisted caching: `dsh-session-projection-cache`.

### `ctx.sessionQuery` — `SessionQueryEngine` (`dsh-session-query`)

Optional seam (backend `dsh-session-query-sqlite`). Concrete reads over the live-preferred corpus (live `ctx.sessions` merged with persisted logs): `listSessions`, `filterSessions`, `readSession`, `readSurface`, `listEvents`, `filterEvents`, `readTitle*`, `traceSession`, `traceEvent`, `readEvent(window)`; abstract full-text `searchSessions(request, exec?)` / `searchEvents` with cursor pagination. Notes: the persistence coordinator's write-behind batches appends (~200 ms) — the durability barrier is `await ctx.sessions.flush(session)`; persisted projection checkpoints live in the `session_projcache` storage domain (`dsh-session-projection-cache`, service `sessionProjectionCache`).

---

## 4. systemPrompt / instructions — `@deepseek-ai/dsh-system-prompt`

**Service name: `systemPrompt`** (`SystemPrompt`, `dsh-system-prompt/lib/index.js:152,164`; types `lib/types/index.d.ts`). **There is no `addInstruction`/`registerInstruction` API** — persistent instructions are prompt sections.

### API (all return effect disposers)

```js
ctx.systemPrompt.section({ name, order, text, complete? });
//   name: unique string; duplicate in one layer throws
//   order: ascending; convention: -100 harness identity, 0 persona (PERSONA_SECTION='deployment:persona'), 100–199 tool guidance
//   text: string | ((context: AssembleContext) => string) — may reference {{variable}}s (strict interpolation)
//   complete: true = this section IS the whole system prompt (two effective completes fail assembly)
ctx.systemPrompt.context({ name, order, text });   // dynamic runtime-context snapshot (user-role), same shape minus `complete`
ctx.systemPrompt.suppressRuntimeContext();          // drop all dynamic runtime-context contributions
ctx.systemPrompt.tools((context) => ({ schemas, knownNames? }));  // tool-schema provider
ctx.systemPrompt.variable('my_var', (context) => string | undefined);  // name: /^[a-z][a-z0-9_]*$/
await ctx.systemPrompt.assemble({ scope?, signal? });  // -> { sections, contexts, tools, variables }
```

Events: `system-prompt/change` (emit, unfiltered) and **`system-prompt/assemble`** (waterfall) `(assembly, context, next) => assembly` — "the returned value is authoritative"; expert seam to rewrite the whole assembled prompt per request.

### Patterns / caveats

- **Per-agent shadowing**: a scoped section registered via `agent.ctx` (or `agents.create` `setup`) shadows the global section of the same name. Error text points at this: `…(for a per-agent override, register through that agent's \`agent.ctx\` instead)`.
- Canonical consumers: `dsh-persona` (registers `deployment:persona`, order 0; `suppressRuntimeContext()` when `includeRuntimeContext:false`), `dsh-tool-goal/lib/index.js:253` (`section({name:'tool:goal', order:114, text})`), `dsh-sandbox-policy` (dynamic `context(...)` reading `context.agent?.session`).
- **`dsh-agent-instructions` is NOT an instruction registry** — it is the AGENTS.md/CLAUDE.md file loader. It discovers `$DSH_HOME/AGENTS.md` + project `.git`-root→cwd instruction files and injects them as **user-role messages** via `ctx.on('agent/pre-step', …)` (baseline) and `ctx.on('tools/result', …)` (fs-tool change touch-ins). `dsh-time-context` uses the same `agent/pre-step` hook. If you want instructions mid-conversation rather than in the system prompt, copy this pattern: hook `agent/pre-step` and append to `payload.messages` (or use `agent.inject()`).

---

## 5. Commands — `@deepseek-ai/dsh-commands`

**Service name: `commands`** (`CommandRuntime extends TypertRemoteService`, `dsh-commands/lib/index.js:246`; types `lib/types/index.d.ts`).

```js
export const inject = ['commands'];
export function apply(ctx) {
  ctx.commands.register({
    name: 'mycmd',                 // lowercase, no slash, /^[a-z][a-z0-9_-]*$/u
    description: 'What it does',   // non-empty
    input: { hint: '[<args>]', images: true },   // optional
    recordInput: true,             // default true; false = don't log rawInput in command/run
    handler: (invocation) => ({ kind: 'success', text: 'done' }),  // or Promise
  });   // -> disposer; duplicate name in one layer throws
}
```

- `CommandInvocation`: `{ commandId, agent /* the receiving Agent */, rawInput /* exact text after the command name */, attachments: ImageBlock[] (only if input.images), signal }`.
- `CommandResult`: `{kind:'success', text?, sourceEventSeq?}` | `{kind:'error', text}` — returned to the dispatching UI; `sourceEventSeq` points at an authoritative domain event for richer rendering.
- Registry also emits durable log-only events `command/run` / `command/done` around each invocation, and cordis `commands/change`.
- Other methods: `list(agent)`, `find(agent, name)`. Scoped (per-agent) commands: register through an agent-scoped context; they shadow globals.
- Reference: `dsh-command-goal/lib/index.js:173–183` (plain register; parses `rawInput`); `dsh-command-compact/lib/index.js:77–98` (registers inside a `ctx.effect(function* () …)` generator so in-flight operations drain before unregister).
- Parsing helper exported: `parseCommand(line)`.

---

## 6. Skills — `@deepseek-ai/dsh-skill`, `dsh-skill-filesystem`

**Service name: `skills`** (`SkillRegistry`, `dsh-skill/lib/index.js:119,132`; types `lib/types/index.d.ts`). Event: `skills/change`.

### Programmatic registration — YES

```js
ctx.skills.register({
  name: 'my-skill',            // kebab-case /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  description: '…',            // non-empty
  content: '# Markdown body…', // full instruction body
  source: 'custom',            // 'project-dsh'|'project-agents'|'runtime'|'user-dsh'|'user-agents'|'custom'|'bundled'|string
  whenToUse?, resourceBase?,   // resourceBase: {kind:'directory',path}|{kind:'url',url}|{kind:'opaque',description}
  invocation?,                 // default { modelInvocable: true, userInvocable: true }
  provider?,                   // default 'runtime'
});  // -> disposer. Same-name runtime entries: first-wins, duplicate gets a warning + no-op disposer.
```

### Provider registration (discovery sources)

```js
ctx.skills.registerProvider((control /* {signal, invalidate} */) => ({
  name: 'my-provider',         // 'runtime' is reserved
  list: (options) => Promise<SkillCandidate[] | { candidates, complete }>,  // candidates: SkillSummary + {rank, locator, path?, metadata?}
  get: (candidate, options) => Promise<SkillDefinition | undefined>,        // loads body
}));
```

Precedence within a layer: `rank` ascending (runtime = 250, bundled = 600), then provider registration order. Reference: `dsh-skill-badge/lib/index.js`.

Reads: `list(options?)`, `snapshot(options?)`, `get(name, options?)` (options `{cwd?, signal?, scope?}`).

### `dsh-skill-filesystem` (discovery from disk)

Discovers `<root>/<name>/SKILL.md` bundles and flat `<root>/<name>.md` files with YAML frontmatter (`name` + `description` required; optional `whenToUse`, `metadata`, `disable-model-invocation`, `user-invocable`). Roots (rank): `<projectRoot>/.dsh/skills` (100), `<projectRoot>/.agents/skills` (200), `config.customSkillDirs` (300), `$DSH_HOME/skills` (400, skips `.system`), `$DSH_AGENTS_HOME || ~/.agents/skills` (500), bundled dir (600). projectRoot = nearest ancestor with `.git`, else cwd. Watches via chokidar and invalidates the catalog on `fs/observed` events.

---

## 7. Storage — `@deepseek-ai/dsh-storage`, `dsh-storage-domain`, `dsh-storage-json`

**Service name: `storage`** (`Storage` hub, `dsh-storage/lib/index.js:104,109`). The hub is a **named backend registry + data-form mounts**; it does no IO itself.

- Backends: `ctx.storage.backend.register(name, backend)` — the JSON-file backend is `dsh-storage-json`, registered as `"json"` (`dsh-storage-json/lib/index.js:288`; it also does `ctx.provide(storageBackendServiceKey('json'), backend)` so domain providers can hard-depend on it).
- Data forms mount on the hub (`StorageForms` declaration merging); the first and currently only form is **`ctx.storage.domain`** (`DomainFacility`, mounted by `dsh-storage-domain`; also exposed as `ctx.storageDomain`).

### Plugin-private durable KV: the domain form

```js
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';  // zod schemas
const spec = defineDomain({
  name: 'my-plugin-data',        // must match UNIT_NAME_RE; doubles as backend unit name
  version: 1,                    // non-negative int; medium stamped with another version rejects at open
  global: { schema: zodObj, initial: {...} },   // optional singleton; schema must NOT accept null
  tables: { items: domainTable(zodRecordSchema) },
});
const domain = await ctx.storage.domain.open(spec);   // DomainFacility.open — single-open enforced ('already-open')
const table = domain.table('items');
table.get(key);  table.entries();  table.keys();  table.size;            // sync, from memory
await table.put(key, record);  await table.update(key, fn);  await table.delete(key);  // durable-first writes
domain.global.get()/set(v)…                                       // if declared
await domain.close();                                             // idempotent; drain queued writes
```

- Semantics (`dsh-storage-domain/lib/types/domain.js` JSDoc): reads are synchronous from authoritative in-memory state; every write queues on a per-domain chain, awaits backend durability **first**, then mutates memory, then emits **`domain/changed`** (cordis event). A rejected backend write leaves memory untouched.
- Config: the domain facility resolves its backend route (`backend` name; `backend-not-found` if absent) — default deployment uses the `json` backend.
- This is the recommended seam for plugin-private durable state (see the §3 warning against custom session events).

---

## 8. Connection (host↔client RPC) — `@deepseek-ai/dsh-client-connection`

**Service name: `connection`** (`HostConnectionService`, `dsh-client-connection/lib/index.js:206,215`; the ONLY provider — not dsh-host-webserver/dsh-web-app). Host-side shape: `ctx.connection.rpc` (`HostConnectionRpc`, `lib/types/rpc.d.ts`).

```js
export const inject = ['connection'];
export function apply(ctx) {
  ctx.connection.rpc.handle(
    '/my-channel',                 // must match /^\/[A-Za-z0-9._~-]+$/; '/api' is reserved
    async (endpoint, payload, signal) => {
      if (endpoint !== 'summary') return { ok: false, error: { code: 'bad-request', message: '…', details: {…} } };
      return { ok: true, value: {…} };
    },
    { authority: 'loopback' },     // REQUIRED: 'loopback' | 'trusted-host'
  );  // -> async disposer; fiber-scoped
}
```

- Handler signature: `(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>` where `RpcResult<T> = {ok:true, value:T} | {ok:false, error:{code, message, details}}` (`@deepseek-ai/dsh-host-apiproxy/api`, `dsh-host-apiproxy/lib/types/api/rpc.d.ts`). Error codes are a closed union (`'bad-request'`, `'cancelled'`, `'internal'`, …; `'internal'` has `details: {}`). **Return `{ok:false,…}` for business errors — a thrown handler error becomes an HTTP 500 "handler failure".**
- Wire: client POSTs `<channel>/<endpoint>` with `{type:'client-request', rpcId, method, payload}`; `method` must equal the endpoint path. Endpoints may be multi-segment; each segment matches `/^[A-Za-z0-9_$.-]+$/` (no `''`, `.`, `..`).
- `authority`: `'loopback'` = only localhost Host headers (127/8, `[::1]`); `'trusted-host'` also accepts the deployment's configured `trustedHosts`. The fence also rejects cross-site `sec-fetch-site` and Origin mismatches. Use `'loopback'` for local-only panels (dsh-token-stats pattern).
- `rpc.intercept('/api', matches, handler, options)` — claim endpoints on the shared `/api` channel before its fallback.
- **No host→client push API on `ctx.connection`.** Push rides two WebSocket downlinks (`/api/events.mux`, `/api/events.host`) owned by `dsh-host-apiproxy`'s ApiProxy events (frames `approval/requested`, `session/queue`, …). A plugin cannot push arbitrary events to clients through this seam; client bundles poll their RPC channels instead (dsh-token-stats client polls `/token-stats/summary`).

---

## 9. Authorization / permissions

### 9a. `ctx.authorization` ≠ tool permissions

`dsh-authorization` (`AuthorizationService`, inject name `authorization`) is a **credential-flow seam** (OAuth-style "open this page, paste that code"): `registerFlow({key: CredentialKey, label, methods, run(session)})`, `begin(request)`, `cancel(key)`, `list()`; event `authorization/settled`. Flows commit credentials through `ctx.credentials`. Nothing to do with tool-call approval.

### 9b. Tool-call approval — `ctx.approval` (`@deepseek-ai/dsh-user-approval`)

`ApprovalService`, inject name `approval`; config `{ policy: 'ask' | 'never' }` (default `'ask'`).

- Decision flow (`request(req)`): requires an open turn → appends audit pair `approval/asked` / `approval/decided` to the session log → session policy gate (`'never'` ⇒ deterministic `'rejected'`) → scoped waterfall **`approval/request`** `(req, next) => ApprovalOutcome` → answerers. Outcomes: `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` (fail-closed). `ApprovalRequest = { agent, toolName, callId?, reason?, signal? }`.
- The web answerer lives in `dsh-host-apiproxy` (pushes an answerable `approval/requested` frame down the mux). `ToolRuntime` maps `'ask'` pre-execute decisions into this service 1:1; no answerer ⇒ deny.
- Policy state is durable per session: `approval/policy` events; helpers `effectiveApprovalPolicy(events)`, `setApprovalPolicy(session, policy)`; `ctx.approval.setPolicy(agent, policy)`, `overrideOf(session)`.

### 9c. Can a plugin contribute permission rules or intercept tool calls?

**There is no permission-rule registration API.** The seams that exist (all verified):

1. **`ctx.tools.guard((exec) => string | undefined)`** — monotonic guard evaluated after `tools/pre-execute`; a returned string denies; guards can never force-allow (`dsh-tools/lib/types/index.d.ts:622`).
2. **`ctx.on('tools/pre-execute', (exec, next) => …)`** — return `{kind:'deny', reason}` or `{kind:'ask', reason}` (routes to approval); `next()` delegates. This is how a policy plugin decides per tool call.
3. **`ctx.on('tools/execute', …)`** — around-dispatch wrapper (timeout-policy pattern), **`ctx.on('tools/post-execute', …)`** — replace/block results.
4. **`ctx.on('approval/request', (req, next) => outcome)`** — become an answerer.
5. `ctx.permissionPresets` (`dsh-permission-presets`) bundles sandbox mode (`read-only|workspace-write|danger-full-access`) + approval policy into named presets (`workspace-write`, `danger-full-access`, derived `custom`); reconfigurable only via plugin config (`presets` table, `defaultPreset`), not at runtime. Durable via `permission/preset`, `sandbox/mode`, `approval/policy` session events; also registers the `/permission` command and a `permission` settings namespace.
6. `dsh-tool-call-timeout-policy` is NOT approval-related — it's the `tools/execute` wrapper enforcing per-tool `timeoutMs` (→ `TOOL_TIMEOUT`).

---

## 10. Web search/fetch — `@deepseek-ai/dsh-web`

**Service name: `web`** (`WebRuntime`, `dsh-web/lib/index.js:41,56`; types `lib/types/index.d.ts`).

```js
export const inject = ['web'];
export function apply(ctx, config) {
  ctx.web.registerSearchProvider({
    id: 'my-provider',
    available() { return true; },                 // cheap LOCAL probe, no network
    async search(request, signal) {               // request: { query, maxResults? }
      return { sources: [{ url, title?, snippet?, publishedAt? }], truncated: false, content? };
    },
  });  // -> disposer; duplicate id throws WebError 'WEB_DUPLICATE_PROVIDER'
}
```

- Symmetric `registerFetchProvider(provider)` (`WebFetchProvider`, for URL fetching).
- The seam itself caps `sources` at `maxResults` and sets `truncated` — providers should return `truncated: false`.
- **Provider selection** (execution-time, order-independent): configured id registered+available → it; configured but missing → `WEB_PROVIDER_CONFIGURED_MISSING`; configured but unavailable → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`; no config + exactly one usable → it; multiple → `WEB_PROVIDER_AMBIGUOUS`; none → `WEB_PROVIDER_UNAVAILABLE`. Selection config: the **`web` plugin's own config keys** `searchProvider` / `fetchProvider`, or env `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` — NOT a `web.searchProvider` settings key.
- `WebError(message, code, {cause})` — open-string codes; provider codes in the wild: `WEB_PROVIDER_ERROR`, `WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_ABORTED`.
- Reference: `dsh-web-search-bailian` (user plugin) and `dsh-web-search-deepseek` (in-repo; provider id `deepseek-official`).

---

## Cross-cutting cheat sheet

| Seam | inject name | Register API | Watch via |
|---|---|---|---|
| Model-facing tool | `tools` | `ctx.tools.register(defineTool({…}))` | `tools/result`, `tools/change` |
| Tool policy/intercept | `tools` | `ctx.on('tools/pre-execute'|'tools/execute'|'tools/post-execute', …)`, `ctx.tools.guard(fn)` | — |
| Persistent instructions | `systemPrompt` | `ctx.systemPrompt.section({name, order, text})` / `.context({…})` / `.variable(n, fn)` | `system-prompt/change` |
| Mid-conversation context | — | `ctx.on('agent/pre-step', …)` / `agent.inject(msg)` | — |
| Slash command | `commands` | `ctx.commands.register({name, description, handler, …})` | `commands/change` |
| Skill | `skills` | `ctx.skills.register({name, description, content, source, …})` / `.registerProvider(fn)` | `skills/change` |
| Plugin KV state | `storage` (+domain) | `ctx.storage.domain.open(defineDomain({…}))` | `domain/changed` |
| Host RPC | `connection` | `ctx.connection.rpc.handle(channel, handler, {authority})` | — |
| Credential flow | `authorization` | `ctx.authorization.registerFlow({…})` | `authorization/settled` |
| Tool approval | `approval` | answer `ctx.on('approval/request', …)`; policy via `setPolicy` | `approval/asked`/`decided` (log) |
| Web search/fetch | `web` | `ctx.web.registerSearchProvider(p)` / `registerFetchProvider(p)` | — |
| Derived session state | `sessionProjections` | `ctx.sessionProjections.register({key, stateSchema, init, apply, stateVersion, wire?})` | `onChanged`, `session/event` |
| Session logs (read) | `sessionPersistence` | — (read: `listSnapshots`, `readFrom`, `inspect`, `list`) | `session/event` |
| Agents | `agents` | `ctx.agents.create(options)` | `agent/created`, `agent/status`, `session/event` |
| Subagents | `subagents` | `ctx.subagents.start(provider, request)` / `startContinuable` | `subagent/start`, `subagent/end` |
| Model-request intercept | — | `ctx.on('agent/request', (p, next) => config)` | — |

**Hard negatives (verified, don't waste time):**
- No `addInterceptor`/`use`/`registerHook` APIs — cordis waterfall/serial events are the only interception mechanism.
- No plugin API to mark session events `ignorable`, and unknown non-ignorable event types brick log reads ⇒ **do not `session.append` custom event types from out-of-repo plugins** (use storage domains).
- No `agent.events`/`session.events` emitters (`session.events` is the log array).
- No `addInstruction` API — use `ctx.systemPrompt.section/context`.
- No permission-rule contribution API — use `tools/pre-execute` + `tools.guard`.
- No host→client push on `ctx.connection` — clients poll RPC channels.
- No `web.searchProvider` settings key — provider selection is plugin config `searchProvider`/`fetchProvider` or `$DSH_WEB_*_PROVIDER` env.
- No `model/*` session event types; model-call observation = `request/header`+`request/context` (durable) and `agent/request`/`agent/request-error` (live).
