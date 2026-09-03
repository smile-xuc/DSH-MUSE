# DSH runtime — host-side plugin interception seams

Explored: `/Users/bruce/Library/Application Support/ai.deepseek.harness/runtime/node_modules/@deepseek-ai/` (compiled ESM, JSDoc preserved). All mechanisms below were read in source and cross-checked against the official hook catalog embedded in `dsh-tool-cordis/lib/index.js` (`EVENT_API`, lines 3731-4340) and real consumer plugins.

**Cordis basics that everything uses** (`cordis/lib/index.js`):
- `ctx.on(name, listener, options?) → disposer` (L371). Waterfall listeners receive `(...args, next)`; **a listener that returns without calling `next()` vetoes/short-circuits the rest of the chain** (waterfall impl L317-325; `next()` is *nullary* — the same argument references flow downstream, you cannot substitute arguments through `next`).
- `ctx.waterfall(thisArg, name, ...args, next)`, `ctx.emit(...)` (fire-and-forget), `ctx.serial` (awaited, bail-able), `ctx.parallel` (awaited all).
- Scope filtering (`dsh-scope/lib/index.js`, `scopeTarget`, L327-338): events are dispatched on a *carrier* keyed to an agent/session scope; **an untagged (global, plain host plugin) listener receives every scope's events** ("event admission extends UP the chain", L233-238). So one host plugin sees all agents. Per-agent registration uses `agent.ctx` (`ReactLoopAgent` builds `this.ctx = this.scope.ctx.extend({ agent: this })`, dsh-agent-loop L376-378).

---

## 1. Tool call interception — `dsh-tools` (`ctx.tools`, class `ToolRuntime`)

File: `dsh-tools/lib/index.js`. `super(ctx, "tools")` (L2592), `static inject = ["systemPrompt"]`.

### The execution pipeline (model tool_call → result)
`ToolRuntime.execute(exec)` (L2999) runs stages in this exact order:

1. **`createExecution`** (L3014): snapshots + deep-freezes `exec.arguments` (L3044-3048), mints `token` (correlation symbol), `rootCallId`, collects `deferContext`/`concludeTurn` channels. Mode-collapse check for code-mode.
2. **PRE-EXECUTE GATE — `ctx.waterfall(scopeTarget(this, exec.agent), "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }))`** (L3105). Decision type (`dsh-tools/lib/types/index.d.ts:418-426`):
   ```ts
   type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
   ```
   - `{kind:'deny'}` → call never dispatches; becomes an `isError` result with text `Error: <reason>` (L3116-3128). **This is the veto seam.**
   - `{kind:'ask'}` → routed to the approval service (see §2).
3. **GUARDS — `ctx.tools.guard(guard)`** (L2805-2810): `guard(exec) => string | undefined`, synchronous, monotonic (any guard's returned string denies; no guard can force-allow). Global via plain ctx, per-agent via `agent.ctx`. Runs after pre-execute (L3116). Prior art: `dsh-subagent-in-process-driver/lib/index.js:84`.
4. **AROUND-DISPATCH — `ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec))`** (L3202). Signature `(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>)`. Wrappers may replace `exec.signal` (registry re-fuses the caller signal so cancellation can't be detached, L3160-3190), and may **skip the body entirely** by not calling `next()` and returning an authored result, which is normalized through the tool's output contract by `normalizeDispatchResult` (L3436-3452) — i.e. a wrapper can return a cached `{ value }` (idempotency replay!) or a synthetic error. Prior art: `dsh-tool-call-timeout-policy/lib/index.js:116-141` (wraps signal with a deadline, swaps the result on timeout).
5. Tool body runs (`tool.execute(exec.arguments, exec)`), output is snapshot-validated against the declared schema (`createSuccessResult`, L3404).
6. **POST-EXECUTE — `ctx.waterfall(carrier, "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }))`** (L3367). Decision type (`types/index.d.ts:431-445`):
   ```ts
   type PostToolDecision =
     | { kind: 'accept'; content?: ContentBlock[]; additionalContexts?: UserMessage[] }
     | { kind: 'accept'; value: JsonValue; additionalContexts?: UserMessage[] }   // replace the value
     | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] } // turn success into isError with corrective feedback
   ```
   Prior art: `dsh-repeat-tool-reminder/lib/index.js:303-316` (observes calls, attaches `additionalContexts`).
7. Definition-owned `finalizeContent`, materialization (deep-freeze), then **final observation — `ctx.emit("tools/result", exec, result)`** (L3273-3291): exec is `Object.freeze`d first; observer-only, failures contained. Prior art: `dsh-agent-instructions/lib/index.js:1289`.

### What does NOT exist here
- **No argument rewriting**: `arguments` is deep-frozen before policy (`createExecution`, L3044); the `PreToolDecision` JSDoc states "Input rewriting is excluded because arguments are already logged and presented" (`types/index.d.ts:415-416`). A guardrail can veto, ask, or wrap — not mutate args. (Workaround: deny + `additionalContexts` instruction, or `tools/execute` wrapper that answers from its own logic.)
- **No "register a global wrapper around tool definitions" API** other than the three event seams + `guard()`.
- Session-log event strings around execution: the agent loop (not the registry) appends **`"tool/call"`** `{turn, step, callId, name, arguments}` (dsh-agent-loop L292-300; `arguments` is the raw JSON string) and **`"tool/result"`** `{turn, step, message, error?, meta?}` with `{surfaceOp:"append", sourceEventSeqs:[callSeq]}` (L302-318). Under Code Mode the registry also appends **`"tool/code-dispatch-start"` / `"tool/code-dispatch"`** (dsh-tools L1242-1250, 1264-1270), with a log-copy redaction waterfall **`"tools/code-dispatch-log"`**.

Also on `ctx.tools`: `register(definition)`, `restrict({allow?, deny?})` (scoped visibility mask, L2779), `presentAs(mode)` (code/native, L2692), `executionMode(exec)`, `get(name, scope)`, `schemas(scope)`, event `"tools/change"`.

---

## 2. Permission / approval system

### The pieces
- **`dsh-user-approval` → `ctx.approval`, class `ApprovalService`** (`dsh-user-approval/lib/index.js:85`). Config `{ policy: "ask" | "never" }`. Session-level override folded from `"approval/policy"` events (`effectiveApprovalPolicy`, L49; `setApprovalPolicy(session, policy)`, L76).
  - `approval.request(req)` (L144) where `req = { agent, toolName, callId?, reason?, signal? }` → `Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">`. Requires an open turn (audit pair `"approval/asked"` / `"approval/decided"` must be turn-enclosed, L146-159). Fail-closed everywhere.
  - The actual answering is delegated to a waterfall: **`ctx.waterfall(scopeTarget(this, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))`** (L189). Any plugin may register an *answerer* via `ctx.on("approval/request", (req, next) => outcomeOrNext)`.
- **`dsh-permission-presets` → `ctx.permissionPresets`** (`dsh-permission-presets/lib/index.js:88`): bundles the two independent knobs — sandbox mode (`"sandbox/mode"` events, via `dsh-sandbox-policy`) and approval policy — into named presets (`workspace-write` = sandbox workspace-write + approval ask; `danger-full-access` = sandbox danger-full-access + approval never, L95-108). Registers a `/permission` command (L165-189) and a `permissions` session projection for the UI select (L152-164). **A plugin cannot add "rules" here — presets are a static config table** (`Config.presets` dict, L89-110); there is no subject/action/resource rule engine in the runtime.
- **`dsh-authorization` → `ctx.authorization`**: OAuth-style credential flows (`registerFlow`), NOT tool permissions. Irrelevant for guardrails except as prior art for human-in-the-loop UI flows.

### How `ask` reaches the web UI
`dsh-host-apiproxy/lib/index.js:1903` registers `ctx.on("approval/request", (req, next) => {...})`: it correlates the in-flight request with the durable `"approval/asked"` session event by `callId`, pushes an **`approval/requested`** frame (`{sessionId, approvalId, toolName, callId?, reason?}`, schema at `dsh-host-apiproxy/lib/types/api/events.schema.js:37`) over the client mux, and parks the promise until the client POSTs to `/api/respond` → broadcasts **`approval/resolved`** `{outcome}` and resolves the waterfall (L1903-1961). The client side lives in `dsh-client-connection/lib/client.js` (L5596+, 8075+).

### Raising an approval programmatically from a plugin
Two ways, both first-class:
1. In a `tools/pre-execute` listener, return `{ kind: "ask", reason }` — the registry calls `approval.request` for you (`serviceAsk`, dsh-tools L3303-3354; degrades to deny when no approval service/agent).
2. Call `ctx.get("approval")?.request({ agent, toolName, callId, reason, signal })` directly from anywhere with an open turn — prior art: `approveEscalation` used by `dsh-tool-bash` (L238-253) for `sandbox_permissions` escalation, defined in `dsh-sandbox/lib/index.js`.

Related human-in-the-loop seam: **`ctx.userQuestions.ask({questions, agent, signal})`** (`dsh-user-questions/lib/index.js:56`) — the `ask_user_question` tool (`dsh-tool-ask-user`) consumes it; the web provider is registered at `dsh-host-apiproxy/lib/index.js:1861` (`question/requested` frames). Only runtime-root agents may ask (throws `DELEGATED_CALLER` for owned subagents, L63).

---

## 3. Agent loop hooks — `dsh-agent-loop` + `dsh-agent`

`dsh-agent-loop/lib/index.js`: `ReactLoopAgent` (L335) drives turns/steps; `AgentLoop` service (`ctx.agentLoop`, L975) is the factory. `dsh-agent/lib/index.js`: `AgentRegistry` (`ctx.agents`, L415) + `agentEvents` dispatcher (L335-366).

All dispatched agent-scoped on carrier `scopeTarget(agent, agent)` — global plugin listeners see all agents (payload always includes `agent`):

| Event | Mode | Signature / payload | Power |
|---|---|---|---|
| **`agent/pre-step`** | waterfall | `({agent, messages, turn, step, signal}, next) => PreStepDecision` (dsh-agent-loop L501-513) | **Reject a proposed step (`{kind:'reject'}` → turn ends as `blocked`) or replace/add the messages entering the step (`{kind:'enter', messages}`)**. THE per-turn context-injection + step-veto seam. Prior art: `dsh-agent-instructions` L1271-1288 (splices a message into `decision.messages`), `dsh-repeat-tool-reminder` L317. |
| **`agent/request`** | waterfall | `({agent, turn, step, signal}, next) => LlmCallConfig` (dsh-agent-loop L708-712) | Replace provider/model/reasoningEffort/maxTokens per step. **Cannot touch messages/tools/system** ("this waterfall cannot mutate messages"). Prior art: `installModelSelection` in dsh-agent L287-298. |
| **`agent/request-error`** | waterfall | `({agent, turn, step, provider, failure, retryPolicy, signal}, next) => {kind:'retry'} | undefined` (L653-663) | Recover failed LLM steps. Prior art: `dsh-llm-retry/lib/index.js:153`. |
| **`agent/turn-stopping`** | serial | `({agent, turn, signal}) => void` (L565) | Awaited before turn close; a listener can `agent.steer(...)` to keep the turn alive. |
| `agent/session-start` | emit | `{agent, source}` (dsh-agent-loop L1188) | "Use `agent.inject()` to seed model-facing context." |
| `agent/status`, `agent/error`, `agent/inbox/inserted|discarded|claimed`, `agent/created`, `agent/disposed` | emit | notifications | lifecycle observation. |
| `agent-loop/config-start-failed` | emit | `{sessionId, error}` | startup failure notification. |

Agent imperative APIs for injecting messages into the live loop (ReactLoopAgent L390-404):
- `agent.followup(input)` — queue for next turn + wake
- `agent.steer(input)` — queue into the current turn (next-step) + wake
- `agent.inject(input)` — queue next-step, no wake
- `agent.cancel(cause)`, `agent.whenIdle()`, `agent.session`, `agent.ctx`, `agent.status`

Messages are built with `createUserMessage({ content: [{type:"text", text}], source: { kind: "plugin", plugin: "<name>", form?: "notice"|..., summary? } })` (dsh-llm L176) — the `{kind:"plugin"}` source is load-bearing (keeps it from rendering as a user prompt; used by repeat-tool-reminder L185-188, user-approval L111-125).

---

## 4. Model request interception — `dsh-llm` (`ctx.llm`, class `LlmRuntime`)

File: `dsh-llm/lib/index.js` (1658 lines). `super(ctx, "llm")` (L1142). The ONLY call API is `stream(options) → AsyncIterable<StreamChunk>` (L1636) and `prepareCall(config)` (L1496).

**The one seam: `ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`** (L1639-1641). Listener: `ctx.on("llm/stream", (options, next) => AsyncIterable<StreamChunk>)`.
- Receives the **full request** `GenerateOptions` `{provider, model, reasoningEffort?, messages, system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?}`.
- Observe the whole response by wrapping: `const s = next(); return myTransformingIterable(s)`. Chunks: `block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`.
- Can **short-circuit** (return own chunks without `next()` → cache/mock/veto).
- **CANNOT rewrite the outgoing request**: loop-built requests are `deepFreeze`d + marked (`markAgentLoopRequest(deepFreeze({...}))`, dsh-agent-loop L752; `isAgentLoopRequest`, dsh-llm L78-89); mutation throws, `next()` can't carry a replacement (cordis nullary `next`), and a global+prepend invariant listener (`dsh-agent-loop/lib/invariant.js:15-33`) fails any request whose `messages` diverge from `session.deriveMessages()`.
- Prior-art listeners: `dsh-agent-loop/lib/invariant.js` (validation), `dsh-session-checkpoint-policy/lib/index.js:61`, `dsh-session-title` L202.
- Use `options.purpose` (`'compaction'|'session-title'`) to skip auxiliary calls; `isAgentLoopRequest(options)` to identify loop calls.

**The sanctioned way to change what the model sees is the session log, not the wire** — compaction prior art: `dsh-compaction` (`ctx.compaction`, `CompactionEngine`) + `dsh-compaction-basic` hook `agent/pre-step` and rewrite history via surface `replace` ops (e.g. `dsh-compaction-tool-result-pruner` re-appends `"tool/result"` with `surfaceOp:{op:"replace",start,end}`); the next request is rebuilt from the log. Session requests are "a pure function of the session log".

Message model: `Message {id, role:'system'|'user'|'assistant', content: ContentBlock[], source}`; tool call = `{type:'tool-call', id: CallId, name, arguments: string}` (raw JSON string); tool result = user-role message with `{type:'tool-result', toolCallId, content, isError?}` via `createToolResultMessage` (L202). `BlockAssembler` finish kinds: `stop | tool-calls | max-tokens | aborted | error`.

---

## 5. System prompt / context injection — `dsh-system-prompt` (`ctx.systemPrompt`)

File: `dsh-system-prompt/lib/index.js` (293 lines). `super(ctx, "systemPrompt")` (L164). All registrations are scope-aware (global via plugin ctx, per-agent via `agent.ctx`; scoped shadows global by name) and effect-owned (disposer, HMR-safe):

- **`section({name, order, text | text(context), complete?})`** (L186) — durable prompt section. Prior art: dsh-tool-bash L254-258 (`{name:"tool:bash", order:105, text:"Check the [exit code: N] marker…"}`), dsh-tool-goal L253.
- **`context({name, order, text | text(context)})`** (L196) — *dynamic runtime context*: re-evaluated every step; joined into the "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." user message by `RuntimeContextProjection` (dsh-agent-loop L26-83), which diffs and only appends on change. Prior art: `dsh-user-approval` L92-102 (`approval:policy`, order 115).
- **`variable(name, provider)`** (L227) — `{{var}}` interpolation. Prior art: agent-loop registers `provider`, `model`, `cwd` (L1024-1026).
- **`tools(provider)`** (L216) — extra tool-schema provider.
- **`suppressRuntimeContext()`** (L206).
- **`assemble(context)` → waterfall `"system-prompt/assemble"`** (L283): expert transform over the full `{sections, contexts, tools, variables}` assembly before every step. (Caveat: a `complete:true` section is restored afterwards.)
- Change notification: `"system-prompt/change"` emit.

**Ephemeral per-turn context** channels:
- `exec.deferContext(userMessage)` — on `ToolRunContext` (`dsh-tools/lib/types/index.d.ts:283-299`): defers a plugin-sourced message to ride the tool result; the loop splices result `additionalContexts` into the next-step inbox (dsh-agent-loop L685). `PostToolDecision.additionalContexts` does the same from post-execute listeners.
- `boundContextSummary(summary)` (dsh-llm L149) — bounds a notice summary to 120 chars; used by dsh-tool-goal L363.
- `agent.inject/steer/followup` (§3) and the `agent/pre-step` waterfall (replace `decision.messages`).

`dsh-agent-instructions` (the AGENTS.md loader) is the full prior-art plugin for durable instructions: baseline via prompt sections + per-step reconciliation through `agent/pre-step` and change detection via `tools/result` + `session/event`.

---

## 6. Session event subscription — `dsh-session` (`ctx.sessions`, class `SessionStore`)

File: `dsh-session/lib/index.js` (1890 lines). `super(ctx, "sessions")` (L1588).

- **`session.append(type, data, {surfaceOp?, sourceEventSeqs?}?) → event`** (L1444): validates lossless-JSON, deep-freezes, assigns `seq = log.length`, and **synchronously (post-commit, failure-contained) emits `"session/event"`** on the session's scope carrier (L1469-1476).
- **Live subscription: `ctx.on("session/event", (session, event) => void)`** — one global listener sees every session's every event (events flow up the scope chain). Companion lifecycle: `"session/created"`, `"session/disposed"`, `"session/flush"` (awaited durability checkpoint, only dispatched via `ctx.sessions.flush(session)`).
- Enumeration: `ctx.sessions.list()`, `ctx.sessions.get(id)`; `ctx.agents.list()/get(id)/roots()` (agent id === session id). New agents also announced via `"agent/created"`.
- **Late-joiner gap**: constructor-seeded/resumed events never hit the firehose — replay `session.events` (up to `session.firstLiveSeq`) on adoption. Canonical adoption pattern in `dsh-session-telemetry/lib/index.js:64-100` (subscribe all four events + sweep `ctx.sessions.list()` + replay).
- **Event vocabulary** (verified by grep of every `append("…")` in the runtime): `turn/start`, `turn/end` `{reason:{kind: completed|blocked|aborted|error|interrupted|max-tokens}}`, `step/start`, `step/end`, `user/message` (data IS the frozen Message), `assistant/chunk`, `assistant/message` `{usage?}`, **`tool/call`** `{turn,step,callId,name,arguments(JSON string)}`, **`tool/result`** `{turn,step,message,error?,meta?}` (join to the call via `message.source.callId` or `sourceEventSeqs[0]`), `tool/code-dispatch(-start)`, `request/header`, `request/context`, `approval/asked|decided|policy`, `permission/preset`, `sandbox/mode`, `plan/mode`, `goal/change`, `agent/inbox/spliced`, `agent-preset/selected`, `subagent/descriptor`, `session/end-seed`, `session/title*`, `llm/retry(-started)`, `todo/write`, `compaction/start|end|summary|prune`, `command/run|done`, `feedback/record`, `schedule/change`, `tool-workflow/*`. No `model/request|response` events (model I/O = `request/*` + `assistant/*`).
- **Ledger-grade fold API**: `ctx.sessionProjections` (`dsh-session-projection/lib/index.js:38`) — `register({key, stateSchema, init(), apply(state, event), stateVersion, wire?})` (L51-86), `onChanged(listener)` (L93), `stateOf(session, key)`, `snapshot(session)`. It is itself driven by `session/event` (L47-49) with lazy cold-fold over `session.events` — a ready-made per-session fold + change feed. Prior art: permission-presets registers the `permissions` unit.
- Read-back: `ctx.sessionQuery` (`dsh-session-query/lib/index.js:786`): `listSessions`, `readSession`, `listEvents`, `filterEvents`, `readSurface`, `traceSession`, `traceEvent`, `readEvent`.
- Web UI channel: `dsh-host-apiproxy` mux streams `{type:"session/event", sessionId, event, view?}` frames (L3571-3590) built from the same firehose.
- No per-session EventEmitter; no cross-process bus; no `hook/*` or `team/*` producers in this install (vocabulary stubs only).

---

## Feasibility verdict for Guardrails / EffectLedger

All four requirements have first-class, documented, in-use seams. A host-side cordis plugin (`{ name, inject: ["tools"], apply(ctx) }`, optionally `["approval", "agents", "sessions", "systemPrompt", "sessionProjections"]`) can do everything without forking the runtime:

### (a) Veto / wrap ANY tool call
- **Veto:** `ctx.on("tools/pre-execute", (exec, next) => rule(exec) ? {kind:"deny", reason} : next())` — deny becomes a model-visible `isError` result; or the simpler synchronous `ctx.tools.guard((exec) => reason | undefined)`. `exec` carries `{name, arguments (parsed, deep-frozen), agent, callId, rootCallId, signal, parent}`.
- **Wrap/replace execution:** `ctx.on("tools/execute", async (exec, next) => { … })` — time it (timeout-policy pattern), swap `exec.signal`, or **return a cached `{ value }` without calling `next()`** for idempotency replay; non-`next()` results are re-validated against the tool's output schema by the registry.
- **Verify/rewrite results:** `ctx.on("tools/post-execute", (exec, result, next) => …)` — accept unchanged, replace `content` or `value`, or `{kind:"block", feedback}` to convert a bad result into a corrective error; attach `additionalContexts` for model-facing follow-up.
- Caveat: **no argument mutation** (frozen by design); deny + instruct instead.

### (b) Pause for human approval mid-turn and resume
- In `tools/pre-execute` return `{kind:"ask", reason}` → the registry suspends the call inside `serviceAsk`, `ctx.approval.request()` appends the durable `"approval/asked"` audit event, the `"approval/request"` waterfall reaches the web answerer in `dsh-host-apiproxy` (which pushes `approval/requested` to the UI and waits), and the pipeline resumes with allow/deny (`"approval/decided"`). The model turn is never torn down — the gate is just an awaited promise with cancellation via `exec.signal`.
- Custom UX: register your own `ctx.on("approval/request", (req, next) => …)` answerer (programmatic auto-approvals), or call `ctx.approval.request({agent, toolName, callId, reason, signal})` directly from any in-turn code (bash escalation pattern). For richer Q&A use `ctx.userQuestions.ask({questions, agent, signal})` (root agents only).

### (c) Observe every tool call + result for a ledger
- Richest: `ctx.on("tools/result", (exec, result) => …)` — final frozen outcome, keyed by `exec.agent`, plus `tools/execute` entry-side for timing/attempts.
- Durable: `ctx.on("session/event", …)` filtering `"tool/call"`/`"tool/result"` (join via `callId`/`sourceEventSeqs[0]`), following the telemetry adoption pattern (`session/created` + sweep `ctx.sessions.list()` + replay `session.events` — seed history is not re-published).
- Cleanest fold: register a `ctx.sessionProjections.register({key:"effect-ledger", init, apply, stateSchema, stateVersion, wire})` unit — eager per-event fold + `onChanged` feed + free web-visible view, exactly how `permissions` ships. Persist to the log itself via `agent.session.append("ledger/effect", {...})` (custom event types are legal — `snapshotJsonValue`-valid data only) for crash-safe replay, or mirror to `session-telemetry` (redact via the `"session-telemetry/record"` waterfall).
- Idempotency keys: nothing built in — mint them from `exec.callId` (model-minted per call) / `exec.rootCallId` / registry `exec.token`, or your own rule hash over `(name, canonicalize(arguments))` (repeat-tool-reminder's `canonicalize` pattern, L207-220).

### (d) Inject guardrail context per turn
- Durable policy text: `ctx.systemPrompt.section({name:"guardrails:policy", order: <n>, text})` (optionally per-agent via `agent.ctx.systemPrompt.section(...)`).
- Per-step dynamic state (ledger position, pending approvals): `ctx.systemPrompt.context({name:"guardrails:state", order: 116, text: ({agent}) => render(agent)})` — re-rendered every step, diff-committed as a "Current runtime context" user message.
- Surgical per-turn messages: `ctx.on("agent/pre-step", ({agent, messages}, next) => …)` and return `{kind:"enter", messages: [...decision.messages, createUserMessage({content, source:{kind:"plugin", plugin:"guardrails", form:"notice", summary: boundContextSummary(...)})}]}` (agent-instructions pattern); or `exec.deferContext(...)` / `additionalContexts` from tool pipeline stages. Whole-assembly rewrite: the `"system-prompt/assemble"` waterfall.

### Residual gaps (explicit)
1. No arg rewriting, no request-body rewriting of loop-built LLM calls (frozen + invariant-policed) — context changes go through the session log/prompt seams.
2. No RBAC rule engine — `permissionPresets` is a static two-knob table; guardrail rules are entirely yours to implement over `exec` fields.
3. `tools/result` and `session/event` are observation-only (post-commit, failures contained) — enforcement must happen at pre/execute/post-execute.
4. Approvals require an open turn and an agent (agentless/host-internal executions degrade `ask`→deny).
5. All seams are single-process cordis; no cross-process interception bus.
