# DSH Plugin Reference — Session Persistence, Projections, Storage, Session Query

Compiled-JS + JSDoc reference for plugin authors. All paths are under the runtime's
`node_modules/@deepseek-ai/` (base abbreviated below as `…/@deepseek-ai/`).
Every package's `package.json` `"exports"` maps `"."` → `./lib/index.js` (runtime) +
`./lib/types/index.d.ts` (types/JSDoc), plus `./invariant`, and most also `./types` or
`./src/*`. Version of all packages cited: `0.1.1-rc.2`.

All services are Cordis services (`@deepseek-ai/cordis` `Service`); each inject name below
is confirmed both by the `declare module '@deepseek-ai/cordis' { interface Context { … } }`
merge and by the `super(ctx, "<name>")` call in the compiled `lib/index.js`.

---

## 1. `ctx.sessionPersistence` — durable session log seam

**Package:** `@deepseek-ai/dsh-session-persistence`
**Entry:** `lib/index.js`; public type surface: `lib/types/index.d.ts`

### 1.1 Inject name and class

- Inject name: **`ctx.sessionPersistence`** (Context merge at `lib/types/index.d.ts:38-42`;
  base class constructor `super(ctx, "sessionPersistence")` at `lib/index.js:1351`).
- Class: `abstract class SessionPersistence extends Service` (`lib/types/index.d.ts:60`).
- The shipped backend is `JsonlSessionPersistence extends SessionPersistence` in
  `@deepseek-ai/dsh-session-persistence-jsonl` (`lib/types/index.d.ts:52`), plugin name
  `session-persistence-jsonl`, `static inject = ["sessions"]` (it requires the live
  `ctx.sessions` store).

Module doc (`lib/types/index.d.ts:1-6`):

> "Durable session-persistence Service Definition (`ctx.sessionPersistence`). Backends store
> `SessionEvent`s as the event-sourced log and carry non-replayable `SessionHeader` metadata
> separately."

Class doc (`lib/types/index.d.ts:54-59`):

> "Durable append-only session storage. Implementations preserve contiguous,
> losslessly JSON-serializable events; `append` resolves only after
> durability, and `load` balances a complete interrupted tail without
> rewriting committed events."

### 1.2 Full method list (all signatures verbatim from `lib/types/index.d.ts`)

| Method | Signature |
|---|---|
| `locate` (abstract) | `locate(meta: SessionHeader): SessionLocation \| undefined` |
| `supportsRawArtifacts` (abstract) | `readonly supportsRawArtifacts: boolean` |
| `readRaw` (concrete; default throws) | `readRaw(_id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact \| undefined>` |
| `create` (abstract) | `create(meta: SessionHeader): Promise<void>` |
| `append` (abstract) | `append(id: SessionId, events: readonly SessionEvent[]): Promise<void>` |
| `prepare` | `prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>` |
| `load` (abstract) | `load(id: SessionId): Promise<SessionInspection>` |
| `inspect` (abstract) | `inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>` |
| `readFrom` (abstract) | `readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>` |
| `list` (abstract) | `list(signal?: AbortSignal): Promise<SessionHeader[]>` |
| `listSnapshots` (abstract) | `listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>` |

Key contract quotes:

- **`append`** (`lib/types/index.d.ts:99-107`):
  > "Durably persist a batch of events. Honors the append-only and contiguous-
  > seq contracts: the first event's `seq` MUST equal the stored next-seq
  > (after `load` has durably closed any interrupted turn). Rejects non-JSON-
  > serializable `event.data` with an error naming the offending event type."

- **`create`** (`lib/types/index.d.ts:91-98`):
  > "Register a new session's metadata. A backend MAY defer the physical write
  > until the first `append` (lazy materialization), in which case a
  > created-but-never-appended session is absent from `list` — abandoned sessions
  > leave nothing behind."

- **`readFrom`** (`lib/types/index.d.ts:149-170`) — the read-model/tail primitive:
  > "Read the stored events from `fromSeq` onward — the read-from-seq primitive for
  > read models that resume from a watermark (e.g. a persisted projection cache folding
  > only the tail past its checkpoint). Unlike `inspect`, it is a detached physical suffix
  > read: no preparation cache, torn-tail truncation, synthetic closers, or
  > coordinator-state publication. Only events from the valid contiguous stored prefix
  > are returned… `fromSeq` at or beyond the stored prefix returns an empty event list
  > (never an error)."

- **`load`** (`lib/types/index.d.ts:120-132`): returns "the header and a log ending on a
  balanced `turn/end`"; commits crash recovery (synthetic closers for a complete
  interrupted turn, torn-tail discard). Unknown versions/corruption reject.

- **`inspect`** (`lib/types/index.d.ts:133-148`): like `load` but non-committing —
  "Inspect an immutable logical session without committing recovery or publishing it."

- **`list` / `listSnapshots`**: "Lightweight listing from metadata, without a full-log parse"
  returning "one header per materialized session".

- **`prepare`**: reserves the exact unpublished `Session` used by resume; returns a
  `SessionPreparation` (`@deepseek-ai/dsh-session` `lib/types/preparation.d.ts:17`) —
  `{ readonly session: Session }` implementing `Disposable`.

### 1.3 Return shapes

**`SessionPersistenceSnapshot`** (`lib/types/index.d.ts:13-19`):
> "Lightweight immutable source identity returned without loading a full log."
```ts
interface SessionPersistenceSnapshot {
  header: SessionHeader;                 // "Detached metadata for one materialized session."
  revision: SessionPersistenceRevision;  // "Opaque source-qualified token that changes
                                         //  whenever this stored log changes."
}
```

**`SessionPersistenceRevision`** (`lib/types/revision.d.ts:3-13`): a branded string
(`Branded<'SessionPersistenceRevision'>`); "Backend-owned token that identifies both one
storage source and one revision of a persisted session log." Revision semantics
(`lib/types/index.d.ts:178-187`):
> "Repeated observations of an unchanged log return the same revision. A successful
> mutating `load` repair changes the next listed revision. Revisions also distinguish
> independently backed stores so backend-local counters cannot compare equal across
> different persistence sources."

**`SessionInspection`** (`lib/types/index.d.ts:20-26`):
```ts
interface SessionInspection {
  readonly meta: SessionHeader;              // validated immutable session metadata
  readonly events: readonly SessionEvent[];  // validated contiguous logical event log
}
```

**`SessionRawArtifact`** (`lib/types/index.d.ts:27-35`):
```ts
interface SessionRawArtifact {
  readonly meta: SessionHeader;  // header parsed from the artifact's own first line
  readonly filename: string;     // base filename on disk, no encoding suffix
  readonly content: string;      // full text, decoded from the physical encoding
}
```

**`SessionLocation`** (`lib/types/index.d.ts:43-53`): `{ readonly kind: string; readonly path: string }`
— "an absolute target path and can name an artifact that has not materialized yet…
treat it as a location hint, never as an authorization token."

### 1.4 SessionHeader fields (`@deepseek-ai/dsh-session`, `lib/types/types.d.ts:37-78`)

> "Immutable validated storage metadata, kept outside the conversation event log."

```ts
interface SessionHeader {
  readonly version: number;             // SESSION_FORMAT_VERSION, currently 0; other versions rejected on load
  readonly id: SessionId;               // branded string
  readonly createdAt: number;           // epoch ms, non-negative safe integer
  readonly cwd?: string;                // absolute working directory at creation
  readonly parentSession?: SessionId;   // fork lineage
  readonly seedLength?: number;         // how many leading events came through a seed
  readonly origin?: 'subagent';         // presentation classification
  readonly delegationDepth?: number;    // absent = 0 (top level); persisted recursion budget
  readonly agentPreset?: string;        // preset id the agent was composed from
}
```

### 1.5 SessionEvent envelope (`@deepseek-ai/dsh-session`, `lib/types/types.d.ts:412-457`)

> "One immutable entry in the session log. A proper discriminated union over `type`…"

```ts
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  type: T;                        // key of the merge-extensible SessionEventMap
  seq: number;                    // "Monotonic sequence number within the session" (= log index; contiguous)
  time: number;                   // "Unix epoch milliseconds"
  data: SessionEventMap[T];       // per-type payload; must be lossless JSON
  ignorable?: true;               // reader may skip unknown types ONLY when this is set
  // only on 'user/message' | 'assistant/message' | 'tool/result' (SurfaceEventType):
  sourceEventSeqs?: number[];
  surfaceOp?: SurfaceOp;          // 'append' | { op: 'replace'; start: number; end: number }
}
```

`ignorable` contract (`types.d.ts:433-443`):
> "Marks an event a reader may safely skip when it does not recognize `type`. Absent means
> required: a reader meeting an unrecognized type without this marker MUST refuse to
> reconstruct the session instead of silently dropping the event…"

Built-in `SessionEventMap` keys (`types.d.ts:223-359`): `turn/start`, `turn/end`,
`step/start`, `step/end`, `user/message`, `assistant/chunk`, `assistant/message`,
`tool/call`, `tool/result`, `todo/write`, `request/header`, `request/context`,
`session/end-seed`. First-party plugins merge more (`approval/*`, `goal/change`,
`compaction/*`, `session/title`, `subagent/descriptor`, … — see the generated catalog
`KNOWN_SESSION_EVENT_TYPES` in `dsh-session/lib/types/known-event-types.js`).

---

## 2. How a plugin appends its own durable events

### 2.1 The write seam is `Session.append`, not `ctx.sessionPersistence`

`Session` (`@deepseek-ai/dsh-session`, `lib/types/index.d.ts:106`) is the live
event-sourced session. Its append (`lib/types/index.d.ts:212`):

```ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
): SessionEvent<T>
```

JSDoc (`lib/types/index.d.ts:177-211`):
> "Append one typed event to the log and synchronously notify observers… The hot path
> never blocks on I/O — persistence plugins buffer asynchronously… `@param data` — The
> event payload; must be JSON-serializable… `@returns` the logged event — its assigned
> `seq`/`time` plus the SNAPSHOT of `data` that entered the log…"
> Throws on non-lossless-JSON data (BigInt, functions, symbols, undefined, -0,
> non-finite numbers, circular refs, sparse arrays, Map/Set/Date/class instances).

Obtain the live `Session` via the store **`ctx.sessions`** (`SessionStore` service,
`dsh-session/lib/types/index.d.ts:290`): `ctx.sessions.get(id)`, `ctx.sessions.list()`,
`ctx.sessions.create(id?, options?)`, or the `session/created` event
(`ctx.on('session/created', session => …)`).

A plugin declares its own event types by TypeScript declaration-merging into
`SessionEventMap` (`types.d.ts:217-222`):
> "The merge-extensible, append-only source of truth for an agent interaction."

```ts
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'my-plugin/state': { /* whole post-change state, plain JSON */ };
  }
}
```

Custom types are **log-only**: `surfaceOp`/`sourceEventSeqs` are compile-time forbidden
outside the three fixed `SurfaceEventType` keys (`types.d.ts:398-411`, `444-456`).

### 2.2 How appended events become durable

The persistence coordinator (`PersistenceCoordinator`,
`dsh-session-persistence/lib/types/coordinator.d.ts:189`) installs the write path
(`lib/index.js:1132-1162`):

```js
ctx.on("session/created", (session) => { this.initFor(session); });
ctx.on("session/event",  (session, event) => { this.initFor(session).writes.enqueue(event); });
ctx.on("session/flush",  (session) => this.flush(session));
ctx.on("session/disposed", (session) => { this.retire(session); });
```

So every committed `session.append` is buffered by a per-session write-behind
(`SessionWriteBehind`, `lib/types/write-behind.d.ts:19`; batching window default
`DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200`, `coordinator.d.ts:15`) and reaches the backend
via the internal `PersistenceBackend.appendBatch(meta, events, isMaterialized)`
(`coordinator.d.ts:142-148`: "Returns once the batch is durable").
Durability checkpoints: the awaited `session/flush` event; the sanctioned caller entry
point is **`ctx.sessions.flush(session): Promise<boolean>`**
(`dsh-session/lib/types/index.d.ts:372-385` — "THE flush entry point… callers… must come
through here rather than dispatch a raw `ctx.parallel('session/flush', …)`").
Final drain happens on `session/disposed`.

### 2.3 Direct `ctx.sessionPersistence.append(id, events)` — exists but is NOT a plugin seam

The abstract `append` on the service is the receiver of the coordinator's write path
(see the contiguous-next-seq contract quoted in §1.2). Nothing in the packages documents
or sanctions a plugin calling it directly, and doing so on a live session would race the
coordinator's own write-behind for the same id (per-id serialization is internal).
There is **no API to append to a persisted, non-live session** — `load`/`inspect` return
immutable views; `prepare` exists only to hand the session to resume.

### 2.4 ⚠ Hard limitation: custom event types currently brick reload

The read path enforces a known-type catalog (`dsh-session-persistence/lib/index.js:1117-1122`):

```js
if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue;
throw this.unsupported(meta, `session "${meta.id}" contains event type "${event.type}"
  (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to
  interpret the log — it was likely written by a newer harness`);
```

`KNOWN_SESSION_EVENT_TYPES` (`dsh-session/lib/types/known-event-types.d.ts:7-18`) is
generated from the first-party repo only:
> "Downstream (out-of-repo) plugin events are outside this list by construction; a
> registration surface for them is deferred until such a consumer exists."

And **`Session.append` offers no way to set `ignorable: true`** — the compiled
implementation (`dsh-session/lib/index.js:1444-1464`) builds the envelope as exactly
`{ type, seq, time, data, ...surfaceMetadata }`; `ignorable` is only *validated* on
stored/seed events, never written by the live append path.

**Consequence (stated, not speculated):** a third-party plugin can merge and append a
custom type and it will be persisted, but any later `load`/`inspect`/`prepare`/`readFrom`
of that log by a build whose catalog lacks the type throws
`SessionFormatUnsupportedError` and the session cannot resume. Until the deferred
registration surface exists, the supported durable homes for plugin-private state are
projections over existing events (§3) and the storage domain (§4).

Also heed the `session/end-seed` warning (`types.d.ts:336-358`):
> "`Session`'s constructor is the only legitimate writer… a plugin appending one would
> silently classify every live bracket before it as seed history."

### 2.5 JSONL on-disk format (`@deepseek-ai/dsh-session-persistence-jsonl`)

Plugin config (`lib/types/index.d.ts:16-40`): `root` (required, no default — "a default
of `process.cwd()` would scatter session files"), `packChunks` (default true),
`compression` (`'zstd'` default = checksummed Zstandard frames, or `'none'`),
`preparedSessionCacheSize`, `writeBatchMaxDelayMs`.

- One append-only file per session: `<root>/<projectKey(cwd)>/<encodeSegment(id)>/…` with
  suffix `.jsonl.zstd` or `.jsonl` (`lib/types/format.d.ts:12-18, 61-95`). Sessions group
  under human-readable project directories; `undefined` cwd → `_no-cwd`.
- **First record** is the header line: `{ type: 'session', version, id, createdAt, cwd?,
  parentSession?, seedLength?, origin?, delegationDepth, agentPreset? }`
  (`format.d.ts:19-35`, `HeaderLine`).
- **Each following line** is one `StorageRecord` (`dsh-session/lib/types/chunk-rows.d.ts:69`):
  either a verbatim `SessionEvent` JSON or — with `packChunks` on — a packed chunk row:
  `{ type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks', seq0, time0, data }`
  packing runs of consecutive `assistant/chunk` deltas losslessly
  (`chunk-rows.d.ts:1-67`; "~60% smaller logs measured on a real session",
  `dsh-session-persistence-jsonl/lib/types/index.d.ts:26-33`). "Storage rows are a
  durable-encoding vocabulary, NOT session events." Reading is layout-blind either way.
- A final record without a newline (or a torn zstd frame) is treated as a torn tail and
  truncated on load repair; `readRaw` returns the verbatim artifact text (decompressed),
  preserving "chunk packing, key order, line breaks"
  (`dsh-session-persistence-jsonl/lib/types/index.d.ts:87-100`).

---

## 3. `dsh-session-projection` — plugin projections over session events

**Package:** `@deepseek-ai/dsh-session-projection`
**Entry:** `lib/index.js`; types `lib/types/index.d.ts` (+ pure-type outlet `./types`).

### 3.1 Yes — plugins register their own fold projections

Service: **`ctx.sessionProjections`**, class `SessionProjectionRegistry extends Service`
(`lib/types/index.d.ts:127`; `super(ctx, "sessionProjections")` at `lib/index.js:46`).

Module doc (`lib/types/index.d.ts:1-18`):
> "…the `ctx.sessionProjections` registry that DRIVES every registered unit forward
> eagerly over committed session events. Domain host plugins contribute pure folds and
> optional client views; the framework owns the subscription, the per-session watermark
> cache, and change notification… Whole-value event rule (load-bearing): a state-carrying
> log event MUST carry the complete post-change state, never a bare delta…"

### 3.2 Registration pattern

1. Declaration-merge your keys into the two type tables
   (`lib/types/types.d.ts:16-24`, both deliberately empty, merge-extensible):
   - `SessionProjectionStateMap` — host fold-state table; "Values must be plain JSON so
     the projection cache can persist them."
   - `SessionProjectionMap` — client-visible wire values (subset of the state keys).
2. Register under injection: "Domain plugins register under
   `ctx.inject(['sessionProjections'], …)` so headless assemblies without the registry
   stay unaffected" (`lib/types/index.d.ts:110-126`).
3. Registration is a fiber effect — disposing the fiber (or the returned disposer)
   unregisters; "Registrants sharing a key share one unit and are counted".

```ts
// overloads at lib/types/index.d.ts:143-152
register<K extends keyof SessionProjectionMap, S extends SessionProjectionStateMap[K]>(
  definition: Omit<ProjectionDefinition<K, S>, 'wire'> & { wire: NonNullable<...> }
): () => void;                                   // client-visible unit
register<K extends Exclude<keyof SessionProjectionStateMap, keyof SessionProjectionMap>, S…>(
  definition: Omit<ProjectionDefinition<K, S>, 'wire'>
): () => void;                                   // host-only unit
```

### 3.3 `ProjectionDefinition` (the fold/reduce unit) — `lib/types/index.d.ts:37-74`

```ts
interface ProjectionDefinition<K, S> {
  key: K;                       // the projection key this unit owns
  stateSchema: ZodType<S>;      // "Validates persisted state before it seeds a fold."
  init(): S;                    // "State for the empty log."
  apply(state: S, event: SessionEvent): S;
  // "Pure transition: previous state + one committed event → next state. A unit
  //  uninterested in an event MUST return the same state reference — an unchanged
  //  reference (Object.is) produces zero downstream work."
  wire?: {                      // omit for host-only units
    viewSchema: ZodType<SessionProjectionMap[K]>;
    view(state: S): SessionProjectionMap[K];   // "State → wire payload"
  };
  stateVersion: number;         // cache-invalidation version; bump on any state/semantics change
}
```

> "All functions MUST be synchronous (an async unit would tear the carriers' consistency
> cut), and `state` MUST be plain JSON (the persisted-cache precondition)."

The registry subscribes `session/event` once (`lib/index.js:47`) and eagerly drives every
committed event through every unit's `apply`. Cells build lazily: "a unit registered
after events flowed… folds `init` over the in-memory log on first touch."

### 3.4 Read face

- `stateOf(session, key)` — "Read one unit's current host state… The returned value is
  live; callers must not mutate it." (`lib/types/index.d.ts:160-167`)
- `snapshot(session): ProjectionSnapshot` — "One consistent cut over every registered
  client-visible unit for one session… Fully synchronous." Shape:
  `{ asOfSeq: number /* -1 for empty log */, values: Partial<SessionProjectionMap> }`
  (`lib/types/index.d.ts:82-91, 168-176`).
- `onChanged(listener): () => void` — change feed; listener
  `(session, key, value, seq) => void` called "once per client-visible unit whose state
  reference changed, per committed event" (`lib/types/index.d.ts:75-80, 153-159`).
- `checkpoint(session): ProjectionCheckpoint` — one `{ ver, seq, val }` row per
  registered key; `val` is a detached structured clone (`lib/types/index.d.ts:177-191`).
- `restoreFloor(checkpoint): number | undefined` and
  `restore(checkpoint, events, baseSeq): { snapshot, checkpoint }` — the cold-read recipe:
  cached row + `sessionPersistence.readFrom(id, floor)` tail replay + `view`
  (`lib/types/index.d.ts:192-245`).
- `viewCheckpoint(checkpoint): Partial<SessionProjectionMap>` — the zero-I/O rung.

### 3.5 `ctx.sessionProjectionCache` (`@deepseek-ai/dsh-session-projection-cache`)

`SessionProjectionCache extends Service` (`lib/types/index.d.ts:47`),
`static inject = ["storageDomain", "sessionProjections", "sessionPersistence", "sessions"]`
(`lib/index.js:93-98`). Config: `{ writeEveryEvents: number; writeIntervalMs: number }`
(both required; mandatory writes at `turn/end` and session disposal always fire).

> "Persisted projection cache (`ctx.sessionProjectionCache`): durable checkpoints of every
> client-visible or explicitly persisted projection unit's state, one record per session
> on the domain data form (`session_projcache` domain — the shipped json backend lands it
> beside `workspace.json`). The cache is a fold shortcut, never an authority…"

Registered plugin units are checkpointed automatically — `checkpoint()` iterates all
registrations (`dsh-session-projection/lib/index.js:148-159`). Stored row:
`{ identity: { createdAt, cwd? }, rows: Record<key, { ver, seq, val }> }`
(`lib/types/spec.d.ts:41-59`). Reads: `cachedSnapshot(meta)` (zero-I/O listing),
`coldSnapshot(id, signal?)` (cache + `readFrom` tail + registry `restore` + fail-soft
write-back), `write(session)` (force a durable checkpoint now)
(`lib/types/index.d.ts:66-101`).

---

## 4. Storage seam — plugin-private durable KV

### 4.1 Hub: `ctx.storage` (`@deepseek-ai/dsh-storage`)

**Entry:** `lib/index.js`; types `lib/types/index.d.ts`.
Service name: **`ctx.storage`** (class `Storage extends Service`,
`super(ctx, "storage")` at `lib/index.js:109`; Context merge `lib/types/index.d.ts:23-27`).

> "Storage hub (`ctx.storage`): a named backend registry plus mounted data-form
> facilities. The hub itself performs no IO — backends own media, data forms (the domain
> layer first) own semantics."

API (`lib/types/index.d.ts:39-62`):
- `ctx.storage.backend: BackendRegistry` — `register(name, backend): () => void`,
  `get(name): StorageBackend` (throws `StorageError` code `backend-not-found`),
  `names(): string[]` (`lib/types/registry.d.ts:11-33`).
- `ctx.storage.mount(form, facility): () => void`, `ctx.storage.form(form)`,
  `ctx.storage.domain` (getter; present once the domain plugin is loaded).
- `storageBackendServiceKey(name)` → `"storage.backend.<name>"` — the lifecycle-only
  inject key a backend plugin provides (`lib/index.js:97-99`), used so "activation cannot
  race backend registration".

Backend contract (`lib/types/backend.d.ts`): `StorageBackend { kv?: KvFacet; close(): Promise<void> }`;
`KvFacet.open(descriptor: KvUnitDescriptor): Promise<KvUnit>`;
`KvUnit`: `loadAll()`, `putRecord(table, key, value)`, `deleteRecord(table, key)`,
`setGlobal(value)`, `close()` — all durable-on-resolve; "The unit does NOT serialize
concurrent writes — write ordering is the caller's responsibility (the domain layer runs
one write chain per unit)". Unit/table names must match
`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` (`lib/index.js:80`).

### 4.2 Data form: `ctx.storage.domain` / `ctx.storageDomain` (`@deepseek-ai/dsh-storage-domain`)

**Entry:** `lib/index.js`; plugin `name = "storage-domain"`, `inject = ["storage"]`.
Config: `{ backend: string; routes?: Record<string, string> }` — default backend name plus
per-domain overrides; "Which backend serves which domain is decided here, not globally on
the hub" (`lib/types/index.d.ts:34-46`).

The same `DomainFacility` is reachable two ways (`lib/index.js:419, 425`):
`ctx.storage.domain` (mounted form) and **`ctx.storageDomain`** (provided service;
Context merge at `lib/types/index.d.ts:25-29`).

Facility API (`lib/types/index.d.ts:52-96`):
- `open<S extends DomainSpec>(spec: S): Promise<Domain<S>>` — validates every stored
  record against the spec's zod schemas at open; enforces single-open per name; "the
  CALLER owns the returned handle and closes it via `Domain.close()` (typically as its
  own `ctx.effect` disposer)".
- `get(name): DomainImpl | undefined` (diagnostics), `closeAll(): Promise<void>`.

**Declare a plugin-private domain** (`lib/types/spec.d.ts`):
```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
const spec = defineDomain({
  name: 'my_plugin',            // must match /^[a-z][a-z0-9_]*$/; doubles as the unit name
  version: 0,                   // medium stamped with a different version rejects at open
  tables: {
    items: domainTable<string, MyRecord>(myRecordZodSchema),
  },
  // optional global singleton: global: { schema, initial }  (schema must not accept null)
});
```
`defineDomain` fails loud at module load on bad names/versions; a nullable global schema
throws (`spec.d.ts:54-65`).

**Runtime handles** (`lib/types/domain.d.ts`):
```ts
interface Domain<S> {
  readonly name: string;
  readonly global: DomainGlobalHandleOf<S>;                    // never if undeclared
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S,N>, TableValueOf<S,N>>;
  close(): Promise<void>;
}
interface KvTable<K extends string, V> {
  get(key: K): V | undefined;               // synchronous, from authoritative memory
  entries(): IterableIterator<[K, V]>;      // snapshot iterators
  keys(): IterableIterator<K>;
  readonly size: number;
  put(key: K, value: V): Promise<void>;     // durable upsert, resolves after durability
  delete(key: K): Promise<boolean>;         // false when already absent (no write)
  update(key: K, fn: (current: V) => V): Promise<V>;  // atomic RMW on the write chain
}
interface DomainGlobal<G> { get(): G; set(value: G): Promise<void>; }
```

Semantics (`domain.d.ts:1-10`): "Reads are synchronous from memory; every write queues on
the chain, awaits backend durability FIRST, then mutates memory, then emits
`domain/changed` — a rejected backend write leaves memory untouched."
Change event (`lib/types/events.d.ts:31-43`): Cordis event **`domain/changed`** with
`{ domain, table /* '' for global */, key /* '' for global */, operation: 'put' | 'deleted',
value? }` — "emitted once per write strictly after the backend acknowledged durability."

**Namespacing:** per-plugin isolation is by **domain name** (one domain = one backend
unit = one file on the json backend). Pick a unique `UNIT_NAME_RE`-conforming name; the
hub offers no further automatic per-plugin namespacing.

### 4.3 JSON backend (`@deepseek-ai/dsh-storage-json`) — where files live

Plugin `name = "storage-json"`, registers backend **`json`** on the hub
(`lib/types/index.d.ts:1-43`). Config `{ root: string }` — required, no default.
Layout: **one `<root>/<unit-name>.json` file per unit** (`lib/index.js:262`:
`join(this.root, \`${descriptor.name}.json\`)`). E.g. a domain named `my_plugin` lands at
`<root>/my_plugin.json`. The projection cache's `session_projcache` domain lands at
`<root>/session_projcache.json`, "beside `workspace.json`".

On-disk shape (`lib/types/format.d.ts:1-27`): "the file is always the current net state,
kept human-readable (pretty-printed, stable key order from insertion)" — a JSON document
`{ …, version, global: null | value, tables: { <table>: { <key>: record } } }` with a
trailing newline. Writes are atomic whole-file rewrites: same-dir temp file → fsync →
`rename()` → directory fsync on POSIX (`lib/index.js:8-40`; "a unit file has exactly one
writer per process and last-write-wins is correct").

---

## 5. `dsh-session-query` — brief

**Package:** `@deepseek-ai/dsh-session-query` — "Combined session query service contract
with concrete reads, traces, and filters."
Service: **`ctx.sessionQuery`**, `abstract class SessionQueryEngine extends Service`
(`lib/types/index.d.ts:31`; `super(ctx, "sessionQuery")`, `static inject = ["sessions"]`).
Exact reads/filters/traces are concrete on the abstract base; full-text search/ranking/
cursors are abstract, implemented by a backend (e.g. `@deepseek-ai/dsh-session-query-sqlite`).

Concrete reads (`lib/types/index.d.ts:50-138`):
- `listSessions(signal?)` / `filterSessions(filters, signal?)` → `SessionRecord[]`
  (`{ header, live, persisted }`), newest-first.
- `readSession(sessionId)` → `SessionLogSnapshot` `{ session: SessionHeader, events: SessionEvent[] }`.
- `readSurface(sessionId)` → `{ session, capturedThroughSeq, events: SurfaceEvent[] }`.
- `listEvents(sessionId)` → `SessionEventRecord[]` `{ sessionId, seq, type, time, surface: 'current'|'shadowed'|'log-only' }`.
- `filterEvents(sessionId, filters)` → `SessionEventSearchDocument[]` (adds extracted `text`).
- `readTitle` / `readTitleSnapshot` / `readTitleSnapshots` (folded `SessionTitleSnapshot`s).
- `traceSession(sessionId)` → `SessionLineageTrace` (ancestors/descendants trees).
- `traceEvent({ sessionId, seq })` → replacement chain + `sourceEventSeqs`/`derivedEventSeqs`.
- `readEvent({ sessionId, seq, before?, after? })` → `SessionEventWindow` (bounded raw-log context).

Abstract full-text: `searchSessions(request, exec?)` → `SessionSearchPage<SessionSearchHit>`;
`searchEvents(request, exec?)` → `SessionEventSearchPage`. Requests carry `query`,
ANDed filter clauses, `limit`, opaque `SessionSearchCursor`. Filters
(`lib/types/types.d.ts:160-200`): session — `id`, `cwd`, `created-at` range, `parent`,
`availability`; event — `seq`/`time` ranges, `type`, `surface`, literal case-insensitive
`text`. Errors: `SessionQueryError` with a closed `SessionQueryErrorCode` taxonomy
(`lib/types/config.d.ts:15-20`); config: `{ readWindowMax? = 50, persistedInspectConcurrency? = 4 }`.

"Live-preferred" means reads merge live `ctx.sessions` state with the persisted corpus,
preferring the live session when both exist.

---

## Quick seam summary

| Need | Use | Not |
|---|---|---|
| Live session event append | `session.append(type, data)` on a `Session` from `ctx.sessions` | `ctx.sessionPersistence.append` (internal write path; contiguous-next-seq contract) |
| Durability barrier | `await ctx.sessions.flush(session)` | raw `ctx.parallel('session/flush', …)` |
| Read persisted logs / tail from watermark | `ctx.sessionPersistence.readFrom(id, fromSeq)` / `inspect` / `load` / `listSnapshots` | parsing files directly |
| Derived per-session state | `ctx.sessionProjections.register({ key, stateSchema, init, apply, wire?, stateVersion })` under `ctx.inject(['sessionProjections'], …)` | own `session/event` bookkeeping |
| Durable plugin-private KV | `ctx.storageDomain.open(defineDomain({ name, version, tables, global? }))` | touching `ctx.storage.backend` units directly |
| Custom durable event types | **not safely available** — unknown non-ignorable types are refused on load; no `ignorable` flag on `Session.append`; registration surface "deferred" | |
