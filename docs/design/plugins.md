# Design: plugin core, opt-in features and devtools

Status: accepted, in progress (2.x minor releases, no breaking change to the `lumenql` entry).

## Goals

1. **Lighter.** A bare client (`lumenql/core`) that ships only what every app needs. Everything else is an opt-in
   module the bundler can drop.
2. **More customizable.** One documented extension point (plugins) instead of features hard-wired in `Client`.
3. **Observable.** A zero-cost event bus that devtools, logging and telemetry plug into.
4. **No breakage.** `import { Client } from "lumenql"` keeps every 2.x behavior: it is the core client with every
   built-in plugin preinstalled and driven by the existing options (`persistedQueries`, uploads, `@defer`, SSE).

## Entries

| Entry                                                                           | Contents                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `lumenql`                                                                       | Batteries included: core + uploads + persisted queries + incremental delivery + SSE.            |
| `lumenql/core`                                                                  | Bare `Client`: fetch, dedupe, cache, live queries, optimistic layers, retries, middleware, bus. |
| `lumenql/upload`                                                                | `upload()`: GraphQL multipart request spec.                                                     |
| `lumenql/persisted`                                                             | `persistedQueries(options?)`: Automatic Persisted Queries and trusted documents.                |
| `lumenql/incremental`                                                           | `incremental()`: `@defer` / `@stream` over `multipart/mixed`.                                   |
| `lumenql/sse`                                                                   | `sse()`: subscriptions and streams over Server-Sent Events.                                     |
| `lumenql/entities`                                                              | `entities()`: propagates updated entities (`__typename` + `id`) across cached results.          |
| `lumenql/devtools`                                                              | `devtools(client)`: an in-page inspector fed by the event bus.                                  |
| `lumenql/react`, `lumenql/ws`, `lumenql/svelte`, `lumenql/vue`, `lumenql/solid` | Bindings and transports.                                                                        |

## Plugin API

```ts
interface Plugin {
  /** Unique name (devtools, ordering, deduplication of the same plugin). */
  name: string;
  /** Runs once per client. The returned function runs on `client.dispose()`. */
  setup?(client: Client): void | (() => void);
  /** Wraps sending one payload (persisted queries: hash first, fall back to the document). */
  send?<T>(
    payload: Payload,
    context: OperationContext,
    next: (payload: Payload) => Promise<T>,
  ): Promise<T>;
  /** Encodes a payload as a request body (uploads). `undefined` lets the next plugin, then JSON, handle it. */
  encode?(payload: Payload): BodyInit | undefined;
  /** Whether variables must bypass the cache and deduplication (files have no stable identity). */
  bypass?(variables: unknown): boolean;
  /** Decodes a streamed response into raw JSON chunks (SSE, multipart). `undefined` when not handled. */
  decode?(response: Response, signal: AbortSignal): AsyncIterable<string> | undefined;
  /** Merges incremental payloads (`@defer` / `@stream`). Without it, each payload replaces the result. */
  merge?: IncrementalMerge;
}
```

Hooks run in plugin order; `send` hooks nest like middleware (the first plugin is outermost). Plugins never see
the cache internals: they act on payloads, bodies and responses, and observe the rest through events.

## Event bus

`client.on(type, listener)` returns an unsubscribe function. With no listener registered, emitting costs one
property check: event objects are only built when someone listens.

| Event        | Payload                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `operation`  | `{ id, context, fetchPolicy, key }` when an operation starts                |
| `result`     | `{ id, context, source: "network" \| "cache" \| "dedupe", data, duration }` |
| `error`      | `{ id, context, error, duration }`                                          |
| `retry`      | `{ context, error, delay, attempts }` (`context.id`, `context.attempt`)     |
| `cache`      | `{ key, data }` when data lands in the cache (network result, write, merge) |
| `invalidate` | `{ prefix, removed }`                                                       |
| `optimistic` | `{ key, phase: "apply" \| "commit" \| "rollback" }`                         |

## Size targets (min + gzip)

- `lumenql/core` (`Client` + `MemoryCache`): ≤ 9.5 kB (2.0.0 shipped 10.5 kB for the same import).
- `lumenql` (everything): ≤ 12.25 kB (2.0.0: 10.5 kB; the plugin seams and the event bus cost about 0.9 kB).
- Each plugin: ≤ 1.75 kB.

## Customization added alongside

- `errorPolicy: "none" | "all" | "ignore"` per call and client-wide.
- `scalars`: parsers applied to results by `__typename` field paths is out of scope (no schema); instead
  `transform(data, context)` per client for result post-processing (dates, money), memoized per result.
- `defaultOptions: { query, mutation, watch }`.
- `refetchQueries: string[]` (operation names) after a mutation, next to `invalidates`.

## Non-goals

- A full normalized cache with a GraphQL parser: `entities()` covers propagation of updated entities without
  parsing documents, which is the 80% case, at a fraction of the size.
