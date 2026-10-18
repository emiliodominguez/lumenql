# Design: plugin core, opt-in features and devtools

Status: implemented in 2.1.0 (no breaking change to the `lumenql` entry).

## Goals

1. **Lighter.** A bare client (`lumenql/core`) that ships only what every app needs. Everything else is an opt-in
   module the bundler can drop.
2. **More customizable.** One documented extension point (plugins) instead of features hard-wired in `Client`.
3. **Observable.** A zero-cost event bus that devtools, logging and telemetry plug into.
4. **No breakage.** `import { Client } from "lumenql"` keeps every 2.x behavior: it is the core client with every
   built-in plugin preinstalled and driven by the existing options (`persistedQueries`, uploads, `@defer`, SSE,
   `debug` logging).

## Entries

| Entry                                                                           | Contents                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lumenql`                                                                       | Batteries included: core + uploads + persisted queries + incremental delivery + SSE + logger (`debug`). |
| `lumenql/core`                                                                  | Bare `Client`: fetch, dedupe, cache, live queries, optimistic layers, retries, middleware, bus, logger. |
| `lumenql/upload`                                                                | `upload()`: GraphQL multipart request spec.                                                             |
| `lumenql/persisted`                                                             | `persistedQueries(options?)`: Automatic Persisted Queries and trusted documents.                        |
| `lumenql/incremental`                                                           | `incremental()`: `@defer` / `@stream` over `multipart/mixed`.                                           |
| `lumenql/sse`                                                                   | `sse()`: subscriptions and streams over Server-Sent Events.                                             |
| `lumenql/scalars`                                                               | `scalars(parsers)`: field parsers by name (dates, money), through the `result` hook.                    |
| `lumenql/entities`                                                              | `entities(options?)`: propagates updated entities (`__typename` + `id`) across cached results.          |
| `lumenql/devtools`                                                              | `devtools(options?)` plugin and `mountDevtools(client, options?)`: an in-page inspector fed by the bus. |
| `lumenql/react`, `lumenql/ws`, `lumenql/svelte`, `lumenql/vue`, `lumenql/solid` | Bindings and transports.                                                                                |

## Plugin API

```ts
interface Plugin {
  /** Unique name (devtools, ordering, deduplication: the first plugin with a name wins). */
  name: string;
  /** Runs once per client. The returned function runs on `client.dispose()`. */
  setup?(client: Client): void | (() => void);
  /** Wraps sending one payload (persisted queries: hash first, fall back to the document). */
  send?<T>(
    payload: OperationPayload,
    context: OperationContext,
    next: (payload: OperationPayload) => Promise<T>,
  ): Promise<T>;
  /** Adjusts the default request headers (e.g. `Accept`), before the client and per-call headers apply. */
  headers?(headers: Headers, context: OperationContext): void;
  /** Encodes a payload as a request body (uploads). `undefined` lets the next plugin, then JSON, handle it. */
  encode?(payload: OperationPayload): BodyInit | undefined;
  /** Whether variables must bypass the cache and deduplication (files have no stable identity). */
  bypass?(variables: unknown): boolean;
  /** Decodes a streamed response into raw JSON chunks (SSE, multipart). `undefined` when not handled. */
  decode?(response: Response, signal: AbortSignal): AsyncIterable<string> | undefined;
  /** Transforms a network result before it is cached and returned (scalars). */
  result?(data: unknown, context: OperationContext): unknown;
  /** Merges a streamed payload (`@defer` / `@stream`). Without it, each payload's `data` replaces the result. */
  merge?(state: StreamState, payload: unknown): boolean;
}
```

Hooks run in plugin order; `send` hooks nest like middleware (the first plugin is outermost). Plugins never see
the cache internals: they act on payloads, bodies and responses, and observe the rest through events.

## Event bus

`client.on(type, listener)` returns an unsubscribe function. With no listener registered, emitting costs one
property check: event objects are only built when someone listens.

| Event        | Payload                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| `operation`  | `{ id, context, fetchPolicy, key }` when an operation starts                          |
| `result`     | `{ id, context, source: "network" \| "cache" \| "dedupe" \| "stream", data }`         |
| `error`      | `{ id, context, error }` (after retries)                                              |
| `done`       | `{ id, context }` when a stream ends without error                                    |
| `retry`      | `{ context, error, delay, attempts }` (`context.id`, `context.attempt`)               |
| `cache`      | `{ key, data, derived }` when real data lands in the cache (`derived`: `updateEntry`) |
| `invalidate` | `{ prefix, removed }`                                                                 |
| `optimistic` | `{ key, phase: "apply" \| "commit" \| "rollback" }`                                   |
| `watch`      | `{ key, watchers }` when a live query starts or stops watching an entry               |

Every `operation` ends with a `result` (not for streams), `error` or `done`. Listeners run synchronously, so
they timestamp events themselves (no `duration` field).

## Size targets (min + gzip)

- `lumenql/core` (`Client` + `MemoryCache`): ≤ 9.5 kB (2.0.0 shipped 10.5 kB for the same import).
- `lumenql` (everything): ≤ 12.25 kB (2.0.0: 10.5 kB; the plugin seams and the event bus cost about 0.9 kB).
- Each plugin: ≤ 1.75 kB.
- `lumenql/devtools`: ≤ 7.5 kB (development only).

## Customization added alongside

- `errorPolicy: "none" | "all" | "ignore"` per call, and per operation type through `defaultOptions`.
- `scalars(parsers)`: no schema, so parsers are keyed by field name, applied through the `result` hook.
- `defaultOptions: { query, mutation, watch }`.
- `refetchQueries: string[]` (operation names) after a mutation, next to `invalidates`.

## Non-goals

- A full normalized cache with a GraphQL parser: `entities()` covers propagation of updated entities without
  parsing documents, which is the 80% case, at a fraction of the size.
