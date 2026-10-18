![lumenql: Your data. Precisely connected. Amber light rays and optical geometry on warm ivory paper.](https://raw.githubusercontent.com/emiliodominguez/lumenql/main/docs/assets/lumenql-banner.jpg)

[![CI](https://img.shields.io/github/actions/workflow/status/emiliodominguez/lumenql/ci.yml?branch=main&style=for-the-badge&label=CI&labelColor=161b22&logo=githubactions&logoColor=white)](https://github.com/emiliodominguez/lumenql/actions/workflows/ci.yml)
[![TypeScript: strict](https://img.shields.io/badge/TS-strict-3178c6?style=for-the-badge&labelColor=161b22&logo=typescript&logoColor=white)](./tsconfig.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/deps-0-2ea44f?style=for-the-badge&labelColor=161b22&logo=npm&logoColor=white)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-3da639?style=for-the-badge&labelColor=161b22&logo=opensourceinitiative&logoColor=white)](./LICENSE)

**lumenql** is a typed GraphQL client with zero runtime dependencies.

Caching, live queries, retries, subscriptions and streaming, with optional React hooks. Built on the Fetch API for browsers, Node.js, Deno, Bun and edge runtimes, with ESM and CommonJS builds.

**Transport**

- **Fetch-native.** Runs anywhere `fetch` exists: browsers, Node 20+, Deno, Bun and edge runtimes. Ships ESM and CJS, and works with GraphQL over HTTP and any spec-compliant server.
- **Middleware.** Composable wrappers over standard `Request` and `Response` objects, for auth refresh, tracing, logging or mocking.
- **Retries.** Exponential backoff with jitter that honors `Retry-After`. Only queries are retried by default.
- **Timeouts and `AbortSignal`.** Set them per client or per call, and they cover retries too.
- **Automatic Persisted Queries and GET.** Send small hashed requests that a CDN can cache. `minify()` shortens documents further.
- **File uploads.** Follows the GraphQL multipart request spec, and switches on automatically when variables contain a `File` or `Blob`.
- **`@defer` / `@stream`.** Incremental delivery over `multipart/mixed` or SSE, in both the current and the 2022 payload formats.
- **Subscriptions over SSE or WebSocket.** GraphQL over SSE built in, or a zero-dependency `graphql-transport-ws` transport (`/ws`, ~1.8 kB) with reconnects and keep-alive. Any other transport plugs in the same way.

**Data**

- **Document cache.** O(1) LRU with TTL (`MemoryCache`), persistent `StorageCache`, or any sync or async adapter you write.
- **Fetch policies.** `cache-first`, `cache-and-network` (stale-while-revalidate), `network-only`, `cache-only` and `no-cache`. Mutations are never cached by default.
- **Deduplication and race safety.** Identical in-flight queries share one request, and the last request for a cache key always wins.
- **Hierarchical invalidation.** `invalidate(["user"])` drops `["user", 1]`, `["user", 2, "posts"]` and so on. Mutations can do this declaratively with `invalidates`.
- **Live queries.** `client.watch()` refetches on invalidation, polling, focus and reconnect, and keeps showing stale data while it revalidates.
- **Optimistic updates.** The `optimistic` option updates the UI immediately and rolls back automatically on failure. `client.write()` pushes data to every component watching an entry.
- **SSR.** `extract()` and `restore()` move the cache from server to browser, and hooks render cached data on the server.

**Extensibility**

- **Lean core, opt-in features.** `lumenql/core` is the bare client (~9.4 kB); uploads, persisted queries, `@defer`, SSE, scalars and entities are plugins you add one by one. The `lumenql` entry preinstalls uploads, persisted queries, `@defer` and SSE, configured by the options below; `scalars()` and `entities()` are always opt-in.
- **Plugins.** One small interface with hooks for payloads, headers, bodies, streamed responses and results. Write your own in a few lines.
- **Events.** `client.on()` exposes operations, results, retries, cache writes, invalidations, optimistic layers and live queries for logging and telemetry. It costs nothing while nobody listens.
- **Devtools.** An in-page inspector (`lumenql/devtools`) with an operations timeline, the cache, live queries and the event log. Framework-agnostic and isolated from page styles.
- **Entities.** The `entities()` plugin keeps an updated entity (`__typename` + `id`) consistent across every cached query, without a normalized cache.

**DX**

- **React, Svelte, Vue and Solid.** React hooks (`useQuery`, `useSuspenseQuery`, `useMutation`, `useSubscription`), Svelte stores, Vue composables and Solid primitives over the same live queries.
- **Error policies and defaults.** Keep partial data next to GraphQL errors (`errorPolicy`), set defaults per operation type (`defaultOptions`), and refetch live queries by name after a mutation (`refetchQueries`).
- **Typed end to end.** Use the `graphql<TData, TVariables>` tag, generics, or zero-config GraphQL Code Generator documents.
- **`graphql` tag.** Compose fragments, with duplicated fragment definitions removed automatically.
- **Typed errors.** `ClientError` carries the status, the GraphQL `errors`, any partial `data` and the raw `Response`.

## Contents

[Install](#install) · [Quick start](#quick-start) · [Typed documents](#typed-documents) · [Caching](#caching) · [Live queries](#live-queries) · [React](#react) · [SSR](#ssr) · [Auth and headers](#auth-and-headers) · [Retries](#retries) · [Middleware](#middleware) · [GET and persisted queries](#get-requests-and-persisted-queries) · [File uploads](#file-uploads) · [@defer / @stream](#incremental-delivery-defer--stream) · [Subscriptions](#subscriptions-sse) · [WebSocket](#websocket-subscriptions) · [Abort and timeouts](#abort-and-timeouts) · [Errors](#error-handling) · [Error policies and defaults](#error-policies-defaults-and-refetching) · [Entities](#entities) · [Plugins and the lean core](#plugins-and-the-lean-core) · [Events](#events) · [Devtools](#devtools) · [API](#api) · [Size](#size)

## Install

```bash
yarn add lumenql
# or
npm i lumenql
```

## Quick start

```ts
import { Client, MemoryCache, graphql } from "lumenql";

const client = new Client({
  url: "https://rickandmortyapi.com/graphql",
  cache: new MemoryCache({ ttl: 5 * 60_000, maxSize: 200 }),
  timeout: 10_000,
});

const CHARACTER = graphql<{ character: { name: string } }, { id: string }>`
  query Character($id: ID!) {
    character(id: $id) {
      name
    }
  }
`;

const { character } = await client.gql({
  key: ["character", 1],
  query: CHARACTER,
  variables: { id: "1" },
});
```

## Typed documents

There are three ways to type a document, and you can mix them:

```ts
// 1. The graphql tag with type arguments (no codegen).
const USER = graphql<UserQuery, UserQueryVariables>`
  query User($id: ID!) {
    user(id: $id) {
      name
    }
  }
`;
await client.gql({ query: USER, variables: { id: "1" } }); // data and variables inferred and checked

// 2. Generics on a plain string.
await client.gql<UserQuery, UserQueryVariables>({ query: USER_STRING, variables: { id: "1" } });

// 3. GraphQL Code Generator: `client` preset with `documentMode: "string"`.
import { graphql as codegen } from "./gql";
await client.gql({
  query: codegen(`query User($id: ID!) { user(id: $id) { name } }`),
  variables: { id: "1" },
});
```

Required variables are enforced: if a typed document declares required variables, omitting `variables` is a compile error in `gql`, `watch`, `subscribe`, the hooks and `useMutation`'s `mutate`. Documents without variables, or with only optional ones, keep them optional.

The `graphql` tag composes fragments and removes duplicated fragment definitions, so shared dependencies only appear once:

```ts
const USER_FIELDS = graphql`
  fragment UserFields on User {
    id
    name
  }
`;
const FRIENDS = graphql`
  fragment Friends on User {
    friends {
      ...UserFields
    }
  }
  ${USER_FIELDS}
`;
const USER = graphql`
  query User {
    me {
      ...UserFields
      ...Friends
    }
  }
  ${USER_FIELDS}
  ${FRIENDS}
`;
```

## Caching

Caching is enabled once a `cache` is configured. Choose a strategy per call with `fetchPolicy`:

| Policy              | Reads cache | Network                            | Writes cache | Default for |
| ------------------- | ----------- | ---------------------------------- | ------------ | ----------- |
| `cache-first`       | Yes         | On a miss                          | Yes          | queries     |
| `cache-and-network` | Yes         | Always, in the background on a hit | Yes          |             |
| `network-only`      | No          | Always                             | Yes          |             |
| `cache-only`        | Yes         | Never (throws)                     | No           |             |
| `no-cache`          | No          | Always                             | No           | mutations   |

The cache key combines your `key`, the document, the `variables` (independent of key order) and the `operationName`. `key` is optional. Set it when you want to group entries for invalidation.

Results are **deeply frozen**: the same objects are shared by the cache, deduplicated callers and every live query showing them, so mutating one (`data.items.sort()`) throws instead of silently corrupting the others. Copy before changing (`[...data.items].sort()`), and return new objects from optimistic updates and `fetchMore` merges.

### Invalidation

```ts
await client.invalidate(["user", 1]); // that user only
await client.invalidate(["user"]); // every ["user", ...] entry
await client.invalidate(); // everything this client cached

// Declarative: runs only if the mutation succeeds.
await client.gql({
  query: UPDATE_USER,
  variables: { id: 1 },
  invalidates: [["user", 1], ["users"]],
});
```

Any watched query (live query or React hook) under an invalidated prefix refetches automatically.

### Optimistic updates

Pass `optimistic` updates to update the UI immediately. If the operation fails, every update is rolled back automatically:

```ts
import { optimistic } from "lumenql";

await client.gql({
  query: ADD_TODO,
  variables: { title },
  optimistic: [
    optimistic({ key: ["todos"], query: TODOS }, function addTodo(current) {
      return { todos: [...(current?.todos ?? []), { id: "temp", title }] }; // typed from TODOS
    }),
  ],
  invalidates: [["todos"]], // then reconcile with the server
});
```

- `optimistic(target, update)` infers types from the target's document. `current` is the cached data, or a live query's data when there's no cache.
- Updates are layers on top of the real data. Server responses and refetches arriving meanwhile rebase them, a failure removes only its own layer, and a success keeps it. Concurrent optimistic mutations never clobber each other. An entry left without data is dropped, and its watchers refetch.
- `useMutation(ADD_TODO, { optimistic: [...] })` works the same way.
- `read` and `write` are available for fully manual updates. `write` notifies every watcher of the entry.

### Persistent cache

`StorageCache` persists results in `localStorage`, `sessionStorage` or any Storage-like object. That gives instant cache-first renders after a reload and offline reads:

```ts
import { StorageCache } from "lumenql";

const client = new Client({
  url,
  cache: new StorageCache({ prefix: "app:", ttl: 24 * 60 * 60_000 }),
});
```

It is namespaced (use distinct, non-nested prefixes: `app:` and `admin:`, not `gql:` and `gql:admin:`), honors the TTL and drops corrupted entries. If storage is full or unavailable it falls back to a cache miss rather than throwing.

### Custom cache adapters

Implement `Cache`. Every method can be sync or async, so you can back it with IndexedDB, Redis or a KV store:

```ts
import type { Cache } from "lumenql";

const redisCache: Cache = {
  async get(key) {
    const raw = await redis.get(key);
    return raw === null ? undefined : JSON.parse(raw);
  },
  async set(key, value) {
    await redis.set(key, JSON.stringify(value), "EX", 60);
  },
  async delete(key) {
    await redis.del(key);
  },
  async clear() {
    await redis.flushdb();
  },
  async keys() {
    return redis.keys("*");
  },
};
```

The client runs cache operations one at a time per key, whatever order an async adapter completes them in. So every call must settle (a rejection is fine: a failed `set` or `delete` makes the key read as a miss until a later write succeeds), and an adapter must never wait on the client for the same key from inside a call, or that key deadlocks.

## Live queries

`client.watch()` returns an observable query that works with any framework:

```ts
const todos = client.watch({
  key: ["todos"],
  query: TODOS,
  pollInterval: 30_000,
  refetchOnFocus: true,
  refetchOnReconnect: true,
});

const unsubscribe = todos.subscribe(function render({ data, error, loading }) {
  // ...
});

await todos.refetch(); // never rejects; failures land in `error`
```

- **Lazy.** It fetches when the first listener subscribes and stops polling and listening when the last one leaves.
- **Stale-while-revalidate.** `data` stays visible during refetches and after errors.
- **Stays fresh.** It refetches on invalidation, polling, focus and reconnect. If it was invalidated while inactive, it catches up on the next subscribe.
- **In sync.** Other fetches of the same entry, `write()` and `restore()` update it.
- **Synchronous cache read.** With a sync cache, cached data is available immediately, with no loading flash.
- **Store contract.** `subscribe` emits the current state immediately, so a `QueryRef` _is_ a Svelte store.

### Pagination

`fetchMore` fetches the same document with extra variables and merges the page into the data. It writes the merged result to the query's cache entry, so every component reading that entry updates:

```ts
const feed = client.watch({ key: ["feed"], query: FEED, variables: { first: 20 } });

await feed.fetchMore({
  variables: { after: feed.getState().data?.feed.pageInfo.endCursor },
  merge(previous, next) {
    return { feed: { ...next.feed, edges: [...previous.feed.edges, ...next.feed.edges] } };
  },
});
```

`useQuery` and `useSuspenseQuery` return the same `fetchMore`.

### Svelte, Vue and Solid

```svelte
<script>
	import { query, mutation } from "lumenql/svelte";

	const todos = query(client, { key: ["todos"], query: TODOS });
	const addTodo = mutation(client, ADD_TODO, { invalidates: [["todos"]] });
	let title = "";

	function add() {
		addTodo.mutate({ title });
	}
</script>

{#if $todos.loading}Loading…{:else}{$todos.data.todos.length} todos{/if}
<button on:click={add} disabled={$addTodo.loading}>Add</button>
```

```ts
// Vue: app.use(lumenql(client)), then in a component
import { useQuery, useMutation } from "lumenql/vue";

const { data, loading, refetch } = useQuery(function options() {
  return { key: ["user", props.id], query: USER, variables: { id: props.id } };
});

// Solid: <ClientContext.Provider value={client}>, then
import { createQuery } from "lumenql/solid";

const user = createQuery(function options() {
  return { key: ["user", props.id], query: USER, variables: { id: props.id } };
});
// user().data, user().loading, user.refetch()
```

`lumenql/svelte` has no dependency (a live query is already a Svelte store). `lumenql/vue` and `lumenql/solid` use `vue` and `solid-js` as optional peer dependencies. Options given as a ref, getter or accessor switch the query when they change. In Vue, keep the client out of reactive proxies (it uses native private fields): `markRaw(client)` if you store it in reactive state.

## React

```tsx
import { GraphQLProvider, useMutation, useQuery } from "lumenql/react";

function App() {
  return (
    <GraphQLProvider client={client}>
      <Todos />
    </GraphQLProvider>
  );
}

function Todos() {
  const { data, loading, error, refetch } = useQuery({
    key: ["todos"],
    query: TODOS,
    refetchOnFocus: true,
  });
  const [addTodo, { loading: saving }] = useMutation(ADD_TODO, { invalidates: [["todos"]] });

  // `addTodo({ title })` → on success the list refetches and re-renders automatically
}
```

| Hook                               | Purpose                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `useQuery(options)`                | Live query built on `client.watch()`. Returns `refetch` and `fetchMore`, and supports `skip` and `keepPreviousData` (no empty flash when variables change). `useSyncExternalStore`-based, so it's tearing-free and SSR-safe.                     |
| `useSuspenseQuery(options)`        | Suspends until data is available and throws errors to the nearest error boundary. `data` is always defined.                                                                                                                                      |
| `useLazyQuery(document, options?)` | Returns `[execute, state]`. Nothing is fetched until `execute(variables)` runs, and from then on the result is live like `useQuery`. `execute` resolves with the data and rejects with the error (also in `error`). Supports `keepPreviousData`. |
| `useMutation(document, options?)`  | Returns `[mutate, { data, error, loading, reset }]`. `mutate` rejects on failure.                                                                                                                                                                |
| `useSubscription(options)`         | Streams SSE subscriptions or `@defer` queries while mounted. Supports `onData` and `skip`.                                                                                                                                                       |
| `useClient()`                      | The client from context.                                                                                                                                                                                                                         |

Components using the same entry share one request, and invalidations and `write()` re-render every consumer. React is an optional peer dependency (≥ 18).

## SSR

```ts
// Server: one client and cache per request
const client = baseClient.extend({ authToken: session.token, cache: new MemoryCache() });
await client.gql({ key: ["todos"], query: TODOS }); // or render with your framework's data loading
const snapshot = await client.extract();
// embed JSON.stringify(snapshot) in the HTML (escape "<" when inlining in a <script>)

// Browser
const client = new Client({ url, cache: new MemoryCache() });
await client.restore(window.__GRAPHQL_STATE__);
```

`useQuery` reads the restored cache synchronously, so the first render matches the server HTML without a loading state.

> **Never share a cache between users on the server.** Cache keys identify the operation, not the user or their headers, so a shared cache would serve one user's data to another, and `extract()` would put everyone's entries into the page. Create a cache per request, as above. `extend()` keeps the shared configuration (URL, middleware, retries) while you swap the auth and the cache.

## Auth and headers

```ts
const client = new Client({
  url: "/graphql",
  authToken: async function getToken() {
    return (await auth.getSession())?.accessToken; // evaluated per request; nullish skips the header
  },
  headers: { "X-Client": "web" }, // any HeadersLike (HeadersInit), or a (sync/async) function returning one
});

await client.gql({ query, headers: { "X-Request-Id": crypto.randomUUID() } }); // per-call headers

const userClient = client.extend({ authToken: session.token, cache: new MemoryCache() }); // per-user client
```

Precedence from lowest to highest: defaults, `authToken`, client `headers`, call `headers`.

## Retries

```ts
const client = new Client({ url, retry: 3 }); // or { attempts, delay, retryIf }

await client.gql({ query, retry: false }); // per-call override
```

By default, network failures and HTTP 408, 429 and 5xx are retried for **queries only**, since mutations aren't idempotent. Retries back off exponentially with jitter (about 1 s, 2 s, 4 s and so on, capped at 30 s) and honor `Retry-After`. The `isRetryable` predicate is exported so you can extend it:

```ts
import { isClientError, isRetryable } from "lumenql";

const client = new Client({
  url,
  retry: {
    attempts: 5,
    retryIf(error, context) {
      return isRetryable(error, context) || (isClientError(error) && error.status === 401);
    },
  },
});
```

## Middleware

Middleware wraps every request, retries included, using standard `Request` and `Response` objects:

```ts
import type { Middleware } from "lumenql";

const tracing: Middleware = async function tracing(request, next, context) {
  const headers = new Headers(request.headers);

  headers.set("traceparent", createTraceparent());

  const startedAt = performance.now();
  const response = await next(new Request(request, { headers }));

  metrics.timing(`graphql.${context.name}`, performance.now() - startedAt, {
    attempt: context.attempt,
  });

  return response;
};

const client = new Client({ url, middleware: [tracing] });
```

Calling `next()` with no argument forwards the current request. Returning a `Response` without calling `next` short-circuits the network, which works well for mocks and offline fallbacks.

## GET requests and persisted queries

```ts
const client = new Client({ url, method: "GET", persistedQueries: true });
```

- `method: "GET"` sends queries as search params without `Content-Type`, so CORS stays simple and responses are cacheable by HTTP caches and CDNs. Mutations and uploads always use `POST`.
- `persistedQueries` implements [Automatic Persisted Queries](https://www.apollographql.com/docs/apollo-server/performance/apq). The client sends a SHA-256 hash first and the full document only when the server asks for it. If the server doesn't support APQ, the client turns it off and falls back. Pass `{ hash }` to use precomputed hashes.
- `persistedQueries: { strict: true, hash }` enables trusted documents. The client only ever sends the hash and never the document text, and an unknown hash is an error instead of a fallback. Use it with servers that only execute an allow-list of registered operations, and pair it with a `hash` that looks up your build-time manifest.
- `minify(document)` strips comments, insignificant whitespace and commas, and leaves strings untouched, so URLs are shorter and hashes stable.

## File uploads

When the variables contain a `File` or `Blob`, at any depth or in lists, the request switches to the [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec):

```ts
await client.gql({ query: UPLOAD_AVATAR, variables: { userId, avatar: input.files[0] } });
```

Apollo Server's CSRF prevention requires a non-simple header for multipart requests. Add one with `headers: { "Apollo-Require-Preflight": "true" }`.

## Incremental delivery (`@defer` / `@stream`)

Documents containing `@defer` or `@stream` automatically advertise `multipart/mixed`:

```ts
// Resolves once every deferred fragment has arrived, fully merged.
const data = await client.gql({ query: PRODUCT_WITH_DEFERRED_REVIEWS });

// Or render progressively: each value is the merged result so far (new references on every patch).
for await (const partial of client.subscribe({ query: PRODUCT_WITH_DEFERRED_REVIEWS }))
  render(partial);
```

The client supports the current incremental format (`pending`/`id`/`subPath`/`completed`) and the 2022 format (`path`/`items`), delivered over `multipart/mixed` or SSE. If a deferred fragment fails, the client throws a `ClientError` that carries the partial data.

## Subscriptions (SSE)

```ts
for await (const { messageAdded } of client.subscribe({ query: ON_MESSAGE, variables: { room } })) {
  render(messageAdded);
}
```

This implements [GraphQL over SSE](https://github.com/enisdenjo/graphql-sse/blob/master/PROTOCOL.md) in "distinct connections" mode, which GraphQL Yoga, Hot Chocolate and `graphql-sse` all support. Breaking out of the loop or aborting `signal` closes the connection. Headers, auth and middleware apply as usual.

## WebSocket subscriptions

`/ws` is a zero-dependency implementation of the [`graphql-transport-ws`](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md) protocol, as used by the `graphql-ws` library and supported by Apollo Server, GraphQL Yoga, Hasura, Mercurius and Hot Chocolate. Plug it in as the `subscriptionTransport`, and `client.subscribe()` and `useSubscription()` use it for `subscription` operations:

```ts
import { Client } from "lumenql";
import { createWebSocketTransport } from "lumenql/ws";

const client = new Client({
  url: "https://api.example.com/graphql",
  subscriptionTransport: createWebSocketTransport({
    url: "wss://api.example.com/graphql",
    connectionParams: async function getParams() {
      return { authorization: `Bearer ${await getToken()}` }; // evaluated on every (re)connect
    },
    keepAlive: 15_000, // ping every 15s and reconnect if no pong arrives
  }),
});
```

- **One socket** carries every subscription. It opens lazily and closes when the last subscription ends (`lazyCloseTimeout`).
- **Reconnects** with exponential backoff (`retryAttempts`, `retryDelay`) and **resubscribes** active operations. Fatal close codes, such as 4401 or 4403 for auth, fail the subscriptions instead of retrying.
- **Server errors** surface as `ClientError`s with `status: 0` and no `response`.
- **Bounded:** a subscription whose consumer falls more than `maxBufferedResults` (default 1,000) results behind fails with a `RangeError`, and a server that drops every connection right after accepting it exhausts `retryAttempts` instead of being retried forever.
- **Custom runtimes:** pass `WebSocket` (for example the `ws` package) when there is no global `WebSocket`. Call `transport.dispose()` to shut it down.

Need another protocol (Phoenix, Ably, Pusher)? Implement `SubscriptionTransport`: a `subscribe(request, signal)` method that returns an `AsyncIterable` of GraphQL results.

## Abort and timeouts

```ts
const controller = new AbortController();

await client.gql({ query, signal: controller.signal, timeout: 5_000 });
```

Set `timeout: 0` to disable the client's default timeout for a single call. Non-finite values also mean no timeout. An abort rejects with the signal's reason, usually an `AbortError`. A timeout rejects with a `TimeoutError` `DOMException`. The timeout covers the whole operation, retries and backoff included.

## Error handling

```ts
import { isClientError } from "lumenql";

try {
  await client.gql({ query });
} catch (error) {
  if (isClientError(error)) {
    error.status; // HTTP status
    error.errors; // GraphQL errors ([] when the failure is HTTP-level)
    error.data; // partial data, if the server sent any
    error.response; // raw Response
  } else {
    // transport failure (offline, DNS, CORS) or abort/timeout
  }
}
```

Use `onError` to handle failures in one place, such as reporting them or signing out on 401. It's called once per failed operation, after retries, and never for operations the caller aborted:

```ts
const client = new Client({
  url,
  onError(error, { type, name }) {
    if (isClientError(error) && error.status === 401) auth.signOut();
    reporter.capture(error, { operation: `${type} ${name}` });
  },
});
```

The client throws a `ClientError` when the response contains GraphQL `errors`, when the status is not 2xx (errors in the body are still parsed), when the body is not valid JSON, or when `data` is missing. The library only writes to the console with `debug: true`, or through `console.error` when a live-query listener throws (with no `onError` set) or an event listener throws.

## Error policies, defaults and refetching

```ts
// Partial data next to GraphQL errors: `ignore` returns it, `all` fails but caches it (live queries show both)
const user = await client.gql({ query: USER, errorPolicy: "ignore" });

const client = new Client({
  url,
  cache: new MemoryCache(),
  defaultOptions: {
    query: { fetchPolicy: "cache-and-network" },
    mutation: { errorPolicy: "all" },
    watch: { refetchOnFocus: true, pollInterval: 60_000 },
  },
});

// After a mutation: refetch live queries by operation name, next to (or instead of) key invalidation
await client.gql({ query: ADD_TODO, variables, refetchQueries: ["Todos", "TodoCount"] });
```

Parse fields by name with the `scalars()` plugin. Without a schema, the client can't know types, so parsers are keyed by field name:

```ts
import { scalars } from "lumenql/scalars";

const client = new Client({ url, plugins: [scalars({ createdAt: parseDate, total: Number })] });
```

Results are cached as parsed and frozen with the rest of the result (class instances such as dates keep their own mutability). With `StorageCache`, return JSON-serializable values. The same goes for SSR: `restore()` of an `extract()` snapshot brings back the JSON values, not the parsed ones.

### Entities

`entities()` keeps entities consistent across cached results. When a mutation returns `{ __typename: "User", id: "1", name: "Ada Lovelace" }`, every cached query holding `User:1` gets the new `name`, and the live queries showing it re-render. There's no schema, no document parsing and no normalized store:

```ts
import { entities } from "lumenql/entities";

const client = new Client({ url, cache: new MemoryCache(), plugins: [entities()] });
```

Select `__typename` (and `id`) in your documents, or pass `identify(value)` for other identities. Only scalar fields present on both sides are copied. An entity added to or removed from a list still needs `invalidates` or `refetchQueries`.

## Plugins and the lean core

`lumenql` is batteries-included. `lumenql/core` is the same client with no built-in plugins, for apps that only pay for what they use:

```ts
import { Client, MemoryCache } from "lumenql/core";
import { persistedQueries } from "lumenql/persisted";
import { sse } from "lumenql/sse";

const client = new Client({ url, cache: new MemoryCache(), plugins: [persistedQueries(), sse()] });
```

| Plugin                    | Entry                     | Adds                                              |
| ------------------------- | ------------------------- | ------------------------------------------------- |
| `upload()`                | `lumenql/upload`          | File uploads (multipart request spec)             |
| `persistedQueries(opts?)` | `lumenql/persisted`       | Automatic Persisted Queries and trusted documents |
| `incremental()`           | `lumenql/incremental`     | `@defer` / `@stream` over `multipart/mixed`       |
| `sse()`                   | `lumenql/sse`             | Subscriptions and streams over Server-Sent Events |
| `scalars(parsers)`        | `lumenql/scalars`         | Field parsers (dates, money)                      |
| `entities(opts?)`         | `lumenql/entities`        | Entity propagation across cached results          |
| `logger(log?)`            | `lumenql`, `lumenql/core` | `debug` logging from client events                |
| `devtools(opts?)`         | `lumenql/devtools`        | The in-page inspector                             |

A plugin is an object with a `name` and any of these hooks. Plugins run in order; a second plugin with the same name is ignored, so passing your own `upload` plugin replaces the built-in one.

```ts
import type { Plugin } from "lumenql";

const tracing: Plugin = {
  name: "tracing",
  // Payload-level middleware (the first plugin is outermost)
  async send(payload, context, next) {
    const span = tracer.start(context.name);
    try {
      return await next({ ...payload, extensions: { ...payload.extensions, traceId: span.id } });
    } finally {
      span.end();
    }
  },
  // Every other hook is optional too:
  // headers(headers, context): adjust default headers (Accept...)
  // encode(payload): return a body to replace JSON (multipart, protobuf...), or undefined
  // bypass(variables): true to skip the cache and dedupe
  // decode(response, signal): turn a streamed response into JSON payloads, or undefined
  // merge(state, payload): merge a streamed payload, true when handled
  // result(data, context): transform network results before caching
  setup(client) {
    // Subscribe to events; the returned teardown runs on client.dispose()
    return client.on("error", function report({ error }) {
      tracer.error(error);
    });
  },
};
```

## Events

`client.on(type, listener)` returns an unsubscribe function. Events are only built while someone listens, and listeners run synchronously, so they can timestamp events themselves.

| Event        | When                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `operation`  | An operation started (`id`, `context`, `fetchPolicy`, `key`)                  |
| `result`     | A result arrived, with its `source`: `network`, `cache`, `dedupe` or `stream` |
| `error`      | An operation failed (after retries)                                           |
| `done`       | A stream ended                                                                |
| `retry`      | A failed attempt will be retried after `delay` ms                             |
| `cache`      | Real data landed in the cache (`derived` when computed by `updateEntry`)      |
| `invalidate` | An invalidation finished, with the number of removed entries                  |
| `optimistic` | Optimistic layers were applied to an entry, committed or rolled back          |
| `watch`      | A live query started or stopped watching an entry                             |

```ts
client.on("error", function report({ context, error }) {
  telemetry.capture(error, { operation: context.name, variables: context.variables });
});
```

## Devtools

One line:

```ts
import { devtools } from "lumenql/devtools";

const client = new Client({ url, plugins: [devtools()] });
```

A small launcher appears in the corner. Click it, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>. It never changes size: a ring spins around its dot while operations run (held briefly, so fast ones register without flicker), the dot turns red after a failure, and the number counts operations.

- **Operations:** every query, mutation and subscription, newest first. Each shows where its result came from (network, cache, deduped, stream) and how long it took (live while it runs). Click one to see its result, error, variables and document, run it again (the panel follows the new run), or copy them.
- **Cache:** what's cached, with live queries marked. Invalidate an entry in one click.
- **Log:** every client event.

The filter box searches the current tab. The panel remembers whether it was open and which tab was showing, follows the system color scheme, and only listens to events, so the client behaves the same with or without it. It works with any framework (or none): it renders in a shadow root under its own `<lumenql-devtools>` element, so page styles can't reach it and its styles can't leak out, and it works under a strict CSP. Every client using `devtools()` shows in one panel, so hot reloads and `extend()` don't stack panels.

In production builds (`NODE_ENV=production`) the plugin does nothing unless you pass `force: true`. Import it conditionally to keep it out of the bundle entirely. Options: `open`, `position`, `theme`, `shortcut`, `limit`, `container` and `force`. `mountDevtools(client, options)` mounts a panel without a plugin (always, so call it conditionally) and returns `open()`, `close()`, `attach(otherClient)` and `dispose()`.

Try it in `examples/devtools-playground` (`node examples/devtools-playground/build.mjs`).

## API

### `new Client(configuration)`

| Option                  | Type                                           | Default            | Description                                                                                                                                                          |
| ----------------------- | ---------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                   | `string`                                       | (required)         | GraphQL endpoint.                                                                                                                                                    |
| `authToken`             | `string \| () => MaybePromise<string \| null>` | none               | Sent as `Authorization: Bearer <token>`.                                                                                                                             |
| `headers`               | `HeadersResolver`                              | none               | Extra headers for every request.                                                                                                                                     |
| `cache`                 | `Cache`                                        | none (no caching)  | Result cache.                                                                                                                                                        |
| `fetch`                 | `typeof fetch`                                 | `globalThis.fetch` | Custom fetch (SSR, tests, a proxy agent). Called as `fetch(url, init)` (requests built by middleware too), so node-fetch, cross-fetch or an npm `undici` work as is. |
| `timeout`               | `number` (ms)                                  | none               | Default request timeout.                                                                                                                                             |
| `dedupe`                | `boolean`                                      | `true`             | Share in-flight identical queries.                                                                                                                                   |
| `retry`                 | `number \| RetryOptions`                       | none               | Retry policy. See [Retries](#retries).                                                                                                                               |
| `middleware`            | `Middleware[]`                                 | `[]`               | Request/response middleware.                                                                                                                                         |
| `method`                | `"POST" \| "GET"`                              | `"POST"`           | HTTP method for queries.                                                                                                                                             |
| `persistedQueries`      | `boolean \| { hash?, strict? }`                | `false`            | Automatic Persisted Queries (`lumenql` entry; with `lumenql/core`, add `persistedQueries()`).                                                                        |
| `subscriptionTransport` | `SubscriptionTransport`                        | SSE over `fetch`   | Transport for `subscription` operations.                                                                                                                             |
| `onError`               | `(error, context) => void`                     | none               | Called once per failed operation (after retries), e.g. to report errors or sign out on 401.                                                                          |
| `plugins`               | `Plugin[]`                                     | `[]`               | Extensions. See [Plugins](#plugins-and-the-lean-core).                                                                                                               |
| `defaultOptions`        | `{ query?, mutation?, watch? }`                | none               | Defaults per operation type: fetch and error policies, polling.                                                                                                      |
| `debug`                 | `boolean`                                      | `false`            | Log operations, timings and cache hits (`lumenql` entry; with `lumenql/core`, add `logger()`).                                                                       |

### Methods

| Method                                 | Description                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gql(options): Promise<TData>`         | Runs a query or mutation. Options below.                                                                                                                     |
| `watch(options): QueryRef`             | Live query: `getState()`, `subscribe(listener)`, `refetch()`, `fetchMore()`. Takes `pollInterval`, `refetchOnFocus`, `refetchOnReconnect` and `initialData`. |
| `subscribe(options)`                   | `AsyncGenerator` over SSE subscriptions or `@defer`/`@stream` results.                                                                                       |
| `invalidate(prefix?)`                  | Removes cached results under a key prefix and refetches watchers. Returns the number removed.                                                                |
| `read(target)` / `write(target, data)` | Reads or writes a cache entry; `write` notifies watchers.                                                                                                    |
| `updateEntry(key, update)`             | Updates a cached entry from its newest data, by serialized key (for plugins). Never recreates or supersedes anything.                                        |
| `extract()` / `restore(snapshot)`      | Serializes the cache or hydrates it (SSR).                                                                                                                   |
| `on(type, listener)`                   | Listens to [client events](#events). Returns an unsubscribe function.                                                                                        |
| `dispose()`                            | Runs plugin teardowns (e.g. removes the devtools).                                                                                                           |
| `extend(overrides): Client`            | Returns a derived client that shares the cache unless you override it. Give each user their own cache.                                                       |

### `gql` / `watch` options

| Option           | Type                                      | Description                                                       |
| ---------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `query`          | `string \| TypedDocumentString`           | The GraphQL document.                                             |
| `variables`      | `TVariables`                              | Operation variables (may contain files).                          |
| `operationName`  | `string`                                  | Selects the operation when the document has several.              |
| `key`            | `(string \| number \| boolean \| null)[]` | Hierarchical cache key for grouping and invalidation.             |
| `fetchPolicy`    | `FetchPolicy`                             | See [Caching](#caching).                                          |
| `invalidates`    | `CacheKey[]`                              | Cache prefixes to invalidate after success.                       |
| `refetchQueries` | `string[]`                                | Live queries to refetch by operation name after success (`gql`).  |
| `errorPolicy`    | `"none" \| "ignore" \| "all"`             | What GraphQL errors next to data mean. Defaults to `none`.        |
| `optimistic`     | `OptimisticUpdate[]`                      | Cache updates applied immediately and rolled back on failure.     |
| `headers`        | `HeadersLike`                             | Per-call headers. Calls with these are not deduplicated.          |
| `signal`         | `AbortSignal`                             | Per-call abort signal. Calls with one are not deduplicated.       |
| `timeout`        | `number` (ms)                             | Per-call timeout, overrides the client default. Not deduplicated. |
| `retry`          | `number \| RetryOptions \| false`         | Per-call retry policy. Calls with one are not deduplicated.       |

### Caches and helpers

- `new MemoryCache({ ttl?, maxSize? })`: O(1) LRU. `ttl` defaults to 60 s and accepts `Infinity`. `maxSize` defaults to 100.
- `new StorageCache({ storage?, prefix?, ttl? })`: Web Storage–backed. Defaults to `localStorage`, `"gql:"` and 24 h.
- `optimistic(target, update)`, `graphql` tag, `minify(document)`, `dedupeFragments(document)`, `isClientError(error)`, `isRetryable(error, context)`.

## Size

Sizes are minified + gzip, measured by `yarn size`. Budgets for the client, the plugins and the devtools are enforced by `yarn verify`:

| Import                                               | Size       |
| ---------------------------------------------------- | ---------- |
| `Client` + `MemoryCache` from `lumenql` (everything) | ~12 kB     |
| `Client` + `MemoryCache` from `lumenql/core`         | ~9.4 kB    |
| Each plugin                                          | 0.3–1.7 kB |
| `lumenql/react`                                      | ~1.8 kB    |
| `lumenql/svelte` / `vue` / `solid`                   | 0.5–0.9 kB |
| `lumenql/ws`                                         | ~1.8 kB    |
| `lumenql/devtools` (development only)                | ~7.4 kB    |

## Development

```bash
yarn install
yarn verify        # everything CI runs: format, typecheck, coverage, build, size, exports
yarn test          # unit, integration, React and type tests
yarn coverage      # tests with coverage thresholds
yarn typecheck
yarn build         # ESM + CJS + .d.ts via tsup
yarn size          # bundle sizes + budget
yarn bench         # hot-path micro-benchmarks (cache hits, live queries, reads)
yarn check:exports # validates package exports/types for every resolution mode
FUZZ_SEEDS=20000 yarn test src/fuzz.test.ts   # longer model-based fuzzing run (CI runs 1,000 seeds)
HFUZZ_SEEDS=10000 yarn test src/fuzz-hostile.test.ts   # hostile fuzzing: async, reordering, failing caches (CI runs 300)
yarn demo          # builds and runs examples/rick-and-morty.js
```

### Releasing

1. Add an `NPM_TOKEN` repository secret (an npm automation token).
2. Bump `version` in `package.json`, update the CHANGELOG and push.
3. Publish a GitHub release tagged `v<version>`.

The release workflow checks that the tag matches the package version, runs the full check suite, and publishes to npm with provenance.

## License

[MIT](./LICENSE) © Emilio Dominguez
