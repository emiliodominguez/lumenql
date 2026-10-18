import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { Client as CoreClient } from "./core";
import { incremental } from "./incremental";
import { logger } from "./logger";
import { optimistic } from "./optimistic";
import { persistedQueries } from "./persisted";
import { sse } from "./sse";
import type { ClientEvents, OperationPayload, Plugin, StreamState } from "./types";
import { upload } from "./upload";

const URL = "https://plugins.test/graphql";
const TODOS = "query Todos { todos }";

afterEach(function () {
	vi.restoreAllMocks();
});

/**
 * A fetch recording every call and answering with JSON.
 *
 * @param answer - Computes the response body from the request
 * @returns The fetch and its recorded requests
 */
function recordingFetch(answer: (init: RequestInit) => unknown = defaultAnswer) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchMock = vi.fn(async function record(url: string, init: RequestInit) {
		calls.push({ url, init });

		return Response.json(answer(init));
	}) as unknown as typeof fetch;

	return { fetchMock, calls };
}

/**
 * The default answer: `{ data: { todos: ["a"] } }`.
 *
 * @returns The body
 */
function defaultAnswer(): unknown {
	return { data: { todos: ["a"] } };
}

/**
 * Creates a filter for recorded events of a type.
 *
 * @param kind - The event type
 * @returns The filter
 */
function ofType(kind: keyof ClientEvents): (entry: [keyof ClientEvents, unknown]) => boolean {
	return function matches([type]: [keyof ClientEvents, unknown]): boolean {
		return type === kind;
	};
}

/**
 * Records every event of a client.
 *
 * @param client - The client
 * @returns The recorded events, as `[type, event]` pairs
 */
function record(client: CoreClient): Array<[keyof ClientEvents, unknown]> {
	const events: Array<[keyof ClientEvents, unknown]> = [];
	const types: Array<keyof ClientEvents> = [
		"operation",
		"result",
		"error",
		"done",
		"retry",
		"cache",
		"invalidate",
		"optimistic",
		"watch",
	];

	for (const type of types) {
		client.on(type, function push(event: unknown): void {
			events.push([type, event]);
		});
	}

	return events;
}

describe("lumenql/core", function () {
	it("ships no built-in plugin: files are not encoded, @defer is not advertised, SSE is not requested", async function () {
		const { fetchMock, calls } = recordingFetch();
		const client = new CoreClient({ url: URL, fetch: fetchMock });

		await client.gql({ query: "query Q { a ... @defer { b } }" });

		const headers = new Headers(calls[0]!.init.headers);

		expect(headers.get("Accept")).toBe("application/graphql-response+json, application/json;q=0.9");
		expect(typeof calls[0]!.init.body).toBe("string");
	});

	it("gains a feature by adding its plugin", async function () {
		const { fetchMock, calls } = recordingFetch();
		const client = new CoreClient({ url: URL, fetch: fetchMock, plugins: [upload(), incremental()] });

		await client.gql({ query: "mutation M($f: Upload!) { m(f: $f) }", variables: { f: new Blob(["x"]) } });
		await client.gql({ query: "query Q { a ... @defer { b } }" });

		expect(calls[0]!.init.body).toBeInstanceOf(FormData);
		expect(new Headers(calls[1]!.init.headers).get("Accept")).toContain("multipart/mixed");
	});

	it("streams over SSE only with the sse plugin", async function () {
		const stream = 'event: next\ndata: {"data":{"n":1}}\n\nevent: complete\ndata:\n\n';
		/**
		 * Answers every request with an SSE stream.
		 *
		 * @returns The response
		 */
		async function sseFetch(): Promise<Response> {
			return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
		}
		const received: unknown[] = [];

		for await (const data of new CoreClient({
			url: URL,
			fetch: sseFetch as typeof fetch,
			plugins: [sse()],
		}).subscribe({ query: "subscription S { n }" })) {
			received.push(data);
		}

		expect(received).toEqual([{ n: 1 }]);

		const bare = new CoreClient({ url: URL, fetch: sseFetch as typeof fetch });

		await expect(bare.subscribe({ query: "subscription S { n }" }).next()).rejects.toThrow("Invalid GraphQL response.");
	});

	it("sends persisted queries with the persistedQueries plugin", async function () {
		const { fetchMock, calls } = recordingFetch();
		const client = new CoreClient({ url: URL, fetch: fetchMock, plugins: [persistedQueries()] });

		await client.gql({ query: TODOS });

		const body = JSON.parse(String(calls[0]!.init.body)) as OperationPayload;

		expect(body.query).toBeUndefined();
		expect(body.extensions).toMatchObject({ persistedQuery: { version: 1 } });
	});
});

describe("plugin API", function () {
	it("runs send hooks like middleware, the first plugin outermost", async function () {
		const order: string[] = [];
		/**
		 * Creates a plugin tagging the payload's extensions.
		 *
		 * @param name - The plugin name
		 * @returns The plugin
		 */
		function tag(name: string): Plugin {
			return {
				name,
				async send(payload, _context, next) {
					order.push(`${name}:in`);

					const result = await next({ ...payload, extensions: { ...payload.extensions, [name]: true } });

					order.push(`${name}:out`);
					return result;
				},
			};
		}
		const { fetchMock, calls } = recordingFetch();
		const client = new CoreClient({ url: URL, fetch: fetchMock, plugins: [tag("a"), tag("b")] });

		await client.gql({ query: TODOS });

		expect(order).toEqual(["a:in", "b:in", "b:out", "a:out"]);
		expect(JSON.parse(String(calls[0]!.init.body)).extensions).toEqual({ a: true, b: true });
	});

	it("lets plugins adjust default headers before the client and call headers apply", async function () {
		const { fetchMock, calls } = recordingFetch();
		const client = new CoreClient({
			url: URL,
			fetch: fetchMock,
			headers: { "X-Client": "app" },
			plugins: [
				{
					name: "headers",
					headers(headers: Headers) {
						headers.set("X-Plugin", "yes");
						headers.set("X-Client", "plugin");
					},
				},
			],
		});

		await client.gql({ query: TODOS, headers: { "X-Call": "1" } });

		const headers = new Headers(calls[0]!.init.headers);

		expect([headers.get("X-Plugin"), headers.get("X-Client"), headers.get("X-Call")]).toEqual(["yes", "app", "1"]);
	});

	it("decodes and merges custom streamed formats (NDJSON)", async function () {
		const ndjson: Plugin = {
			name: "ndjson",
			decode(response: Response) {
				if (!response.headers.get("Content-Type")?.includes("ndjson")) return undefined;

				return (async function* lines() {
					for (const line of (await response.text()).split("\n")) if (line) yield line;
				})();
			},
			merge(state: StreamState, payload: unknown) {
				const { patch, more } = payload as { patch: Record<string, unknown>; more: boolean };

				state.data = { ...(state.data as object), ...patch };
				state.hasNext = more;
				return true;
			},
		};
		const client = new CoreClient({
			url: URL,
			plugins: [ndjson],
			fetch: async function stream() {
				return new Response('{"patch":{"a":1},"more":true}\n{"patch":{"b":2},"more":false}\n', {
					headers: { "Content-Type": "application/x-ndjson" },
				});
			} as typeof fetch,
		});

		await expect(client.gql({ query: TODOS })).resolves.toEqual({ a: 1, b: 2 });
	});

	it("keeps the first plugin of a name, so an explicit plugin replaces a built-in one", async function () {
		const encode = vi.fn(function encode() {
			return "custom-body";
		});
		const { fetchMock, calls } = recordingFetch();
		const client = new Client({ url: URL, fetch: fetchMock, plugins: [{ name: "upload", encode }] });

		await client.gql({ query: "mutation M($f: Upload!) { m(f: $f) }", variables: { f: new Blob(["x"]) } });

		expect(encode).toHaveBeenCalledTimes(1);
		expect(calls[0]!.init.body).toBe("custom-body");
	});

	it("sets plugins up once per client and tears them down on dispose()", function () {
		const teardown = vi.fn();
		const setup = vi.fn(function setUp() {
			return teardown;
		});
		const client = new CoreClient({ url: URL, plugins: [{ name: "lifecycle", setup }] });

		expect(setup).toHaveBeenCalledWith(client);

		client.dispose();
		client.dispose();

		expect(teardown).toHaveBeenCalledTimes(1);
	});

	it("derives clients of the same kind: extend() keeps built-ins without duplicating them, and follows options", async function () {
		const { fetchMock, calls } = recordingFetch();
		const full = new Client({ url: URL, fetch: fetchMock, persistedQueries: true });
		const derived = full.extend({ persistedQueries: false });
		const bare = new CoreClient({ url: URL, fetch: fetchMock }).extend({ headers: { "X-A": "1" } });

		expect(derived).toBeInstanceOf(Client);
		expect(bare).not.toBeInstanceOf(Client);

		await derived.gql({ query: TODOS });

		expect(JSON.parse(String(calls[0]!.init.body)).query).toBe(TODOS);
	});
});

describe("events", function () {
	it("emits nothing and builds nothing without listeners", async function () {
		const { fetchMock } = recordingFetch();
		const client = new CoreClient({ url: URL, fetch: fetchMock });

		await expect(client.gql({ query: TODOS })).resolves.toEqual({ todos: ["a"] });
	});

	it("reports operations, results by source, cache writes and invalidations", async function () {
		const { fetchMock } = recordingFetch();
		const client = new CoreClient({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const events = record(client);

		await Promise.all([client.gql({ query: TODOS }), client.gql({ query: TODOS })]);
		await client.gql({ query: TODOS });
		await client.invalidate([]);

		const results = events.filter(ofType("result"));

		expect(
			results.map(function source([, event]) {
				return (event as ClientEvents["result"]).source;
			}),
		).toEqual(["network", "dedupe", "cache"]);
		expect(events.filter(ofType("operation"))).toHaveLength(3);
		expect(events.find(ofType("cache"))?.[1]).toMatchObject({ data: { todos: ["a"] } });
		expect(events.find(ofType("invalidate"))?.[1]).toEqual({ prefix: [], removed: 1 });
	});

	it("reports failures, retries and their attempt numbers", async function () {
		let calls = 0;
		const client = new CoreClient({
			url: URL,
			retry: { attempts: 1, delay: 0 },
			fetch: async function flaky() {
				if (++calls === 1) return new Response("", { status: 503 });

				return Response.json({ errors: [{ message: "nope" }] });
			} as typeof fetch,
		});
		const events = record(client);

		await expect(client.gql({ query: TODOS })).rejects.toThrow("nope");

		const retry = events.find(ofType("retry"))?.[1] as ClientEvents["retry"];
		const error = events.find(ofType("error"))?.[1] as ClientEvents["error"];

		expect(retry.context.attempt).toBe(0);
		expect(retry.attempts).toBe(1);
		expect(error.id).toBe(retry.context.id);
	});

	it("reports optimistic layers and live queries", async function () {
		const { fetchMock } = recordingFetch(function answer(init) {
			return String(init.body).includes("mutation") ? { data: { add: true } } : { data: { todos: ["a"] } };
		});
		const client = new CoreClient({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const events = record(client);
		const ref = client.watch({ key: ["todos"], query: TODOS });
		const stop = ref.subscribe(function noop() {});

		await client.gql({
			query: "mutation Add { add }",
			optimistic: [
				optimistic<{ todos: string[] }, Record<string, never>>(
					{ key: ["todos"], query: TODOS },
					function add(current) {
						return { todos: [...(current?.todos ?? []), "b"] };
					},
				),
			],
		});
		stop();
		// Live queries deactivate on a deferred timer.
		await new Promise(function wait(resolve) {
			setTimeout(resolve, 10);
		});

		const phases = events.filter(ofType("optimistic")).map(function phase([, event]) {
			return (event as ClientEvents["optimistic"]).phase;
		});
		const watchers = events.filter(ofType("watch")).map(function count([, event]) {
			return (event as ClientEvents["watch"]).watchers;
		});

		expect(phases).toEqual(["apply", "commit"]);
		expect(watchers).toEqual([1, 0]);
	});

	it("reports each streamed result and the end of the stream", async function () {
		const client = new CoreClient({
			url: URL,
			plugins: [sse()],
			fetch: async function stream() {
				return new Response(
					'event: next\ndata: {"data":{"n":1}}\n\nevent: next\ndata: {"data":{"n":2}}\n\nevent: complete\ndata:\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			} as typeof fetch,
		});
		const events = record(client);

		for await (const _ of client.subscribe({ query: "subscription S { n }" })) void _;

		expect(
			events.map(function type([kind]) {
				return kind;
			}),
		).toEqual(["operation", "result", "result", "done"]);
		expect((events[0]![1] as ClientEvents["operation"]).context.stream).toBe(true);
	});

	it("never lets a throwing listener break an operation", async function () {
		const consoleError = vi.spyOn(console, "error").mockImplementation(function () {});
		const { fetchMock } = recordingFetch();
		const client = new CoreClient({ url: URL, fetch: fetchMock });
		const off = client.on("result", function boom() {
			throw new Error("listener");
		});

		await expect(client.gql({ query: TODOS })).resolves.toEqual({ todos: ["a"] });
		expect(consoleError).toHaveBeenCalledTimes(1);

		off();
		await client.gql({ query: TODOS });
		expect(consoleError).toHaveBeenCalledTimes(1);
	});
});

describe("logger()", function () {
	it("writes operation lines from the events", async function () {
		const lines: string[] = [];
		const { fetchMock } = recordingFetch();
		const client = new CoreClient({
			url: URL,
			fetch: fetchMock,
			cache: new MemoryCache(),
			plugins: [
				logger(function collect(line: string): void {
					lines.push(line);
				}),
			],
		});

		await client.gql({ query: TODOS });
		await client.gql({ query: TODOS });

		expect(lines[0]).toMatch(/^\[lumenql\] query Todos → ok in \d+ms$/);
		expect(lines[1]).toBe("[lumenql] query Todos → cache hit");
	});
});
