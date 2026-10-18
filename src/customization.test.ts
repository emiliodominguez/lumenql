import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { isClientError } from "./errors";
import { scalars } from "./scalars";

const URL = "https://custom.test/graphql";
const USER = "query User { user { id name } }";
const PARTIAL = { data: { user: { id: "1", name: null } }, errors: [{ message: "name failed", path: ["user", "name"] }] };

/**
 * A fetch answering every call with the same JSON body, counting calls.
 *
 * @param body - The JSON body
 * @returns The fetch mock
 */
function answer(body: unknown) {
	return vi.fn<typeof fetch>(async function respond() {
		return Response.json(body);
	});
}

/**
 * Waits for pending promises and 0ms timers.
 */
async function tick(): Promise<void> {
	await new Promise(function wait(resolve) {
		setTimeout(resolve, 5);
	});
}

describe("errorPolicy", function () {
	it("none (default): fails on GraphQL errors and caches nothing", async function () {
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch: answer(PARTIAL), cache });

		await expect(client.gql({ query: USER })).rejects.toThrow("name failed");
		expect(await client.read({ query: USER })).toBeUndefined();
	});

	it("ignore: returns and caches the partial data", async function () {
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch: answer(PARTIAL), cache });

		await expect(client.gql({ query: USER, errorPolicy: "ignore" })).resolves.toEqual(PARTIAL.data);
		expect(await client.read({ query: USER })).toEqual(PARTIAL.data);
	});

	it("ignore never hides an error without data", async function () {
		const client = new Client({ url: URL, fetch: answer({ errors: [{ message: "boom" }] }) });

		await expect(client.gql({ query: USER, errorPolicy: "ignore" })).rejects.toThrow("boom");
	});

	it("all: fails with the errors, caches the partial data, and live queries show both", async function () {
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch: answer(PARTIAL), cache, onError: function ignore() {} });
		const error = await client.gql({ query: USER, errorPolicy: "all" }).catch(function capture(caught: unknown) {
			return caught;
		});

		expect(isClientError(error) && error.data).toEqual(PARTIAL.data);
		expect(await client.read({ query: USER })).toEqual(PARTIAL.data);

		await client.invalidate([]);

		const ref = client.watch({ query: USER, errorPolicy: "all" });
		const stop = ref.subscribe(function noop() {});

		await tick();

		expect(ref.getState().data).toEqual(PARTIAL.data);
		expect(isClientError(ref.getState().error)).toBe(true);
		stop();
	});
});

describe("defaultOptions", function () {
	it("applies per operation type, under each call's own options", async function () {
		const fetchMock = answer({ data: { user: { id: "1", name: "a" } } });
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			cache: new MemoryCache(),
			defaultOptions: { query: { fetchPolicy: "network-only" } },
		});

		await client.gql({ query: USER });
		await client.gql({ query: USER });
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await client.gql({ query: USER, fetchPolicy: "cache-first" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("gives live queries their own defaults on top of the query ones", async function () {
		const client = new Client({
			url: URL,
			fetch: answer(PARTIAL),
			cache: new MemoryCache(),
			onError: function ignore() {},
			defaultOptions: { query: { errorPolicy: "none" }, watch: { errorPolicy: "ignore" } },
		});
		const ref = client.watch({ query: USER });
		const stop = ref.subscribe(function noop() {});

		await tick();

		expect(ref.getState()).toMatchObject({ data: PARTIAL.data, error: undefined });
		await expect(client.gql({ query: USER, fetchPolicy: "network-only" })).rejects.toThrow("name failed");
		stop();
	});

	it("applies mutation defaults to mutations only", async function () {
		const client = new Client({
			url: URL,
			fetch: answer(PARTIAL),
			defaultOptions: { mutation: { errorPolicy: "ignore" } },
		});

		await expect(client.gql({ query: "mutation Save { user { id name } }" })).resolves.toEqual(PARTIAL.data);
		await expect(client.gql({ query: USER })).rejects.toThrow("name failed");
	});
});

describe("refetchQueries", function () {
	it("refetches the live queries of the named operations after a successful operation", async function () {
		let version = 0;
		const client = new Client({
			url: URL,
			cache: new MemoryCache(),
			fetch: async function server(_url: unknown, init?: RequestInit) {
				const body = String(init?.body);

				if (body.includes("mutation")) return Response.json({ data: { save: ++version } });

				return Response.json({ data: { user: { id: "1", name: `v${version}` } } });
			} as typeof fetch,
		});
		const ref = client.watch({ key: ["users", 1], query: USER });
		const other = client.watch({ key: ["other"], query: "query Other { user { id name } }" });
		const stops = [ref.subscribe(function noop() {}), other.subscribe(function noop() {})];

		await tick();
		await client.gql({ query: "mutation Save { save }", refetchQueries: ["User"] });
		await tick();

		expect(ref.getState().data).toEqual({ user: { id: "1", name: "v1" } });
		expect(other.getState().data).toEqual({ user: { id: "1", name: "v0" } });

		for (const stop of stops) stop();
	});
});

describe("scalars()", function () {
	it("parses fields by name, in lists and nested objects, and caches the parsed result", async function () {
		const cache = new MemoryCache();
		const client = new Client({
			url: URL,
			cache,
			plugins: [
				scalars({
					createdAt: function toDate(value: unknown): Date {
						return new Date(String(value));
					},
				}),
			],
			fetch: answer({
				data: {
					posts: [
						{ id: "1", createdAt: "2026-01-01T00:00:00.000Z", tags: [{ createdAt: null }] },
						{ id: "2", createdAt: ["2026-01-02T00:00:00.000Z"] },
					],
				},
			}),
		});
		const data = await client.gql<{
			posts: Array<{ createdAt: Date | Date[]; tags?: Array<{ createdAt: null }> }>;
		}>({ query: "query Posts { posts { id createdAt } }" });

		expect(data.posts[0]!.createdAt).toBeInstanceOf(Date);
		expect(data.posts[0]!.tags![0]!.createdAt).toBeNull();
		expect((data.posts[1]!.createdAt as Date[])[0]).toBeInstanceOf(Date);
		expect(Object.isFrozen(data.posts[0])).toBe(true);
		expect(await client.read({ query: "query Posts { posts { id createdAt } }" })).toBe(data);
	});

	it("keeps a __proto__ field as data", async function () {
		const client = new Client({
			url: URL,
			plugins: [scalars({ when: Number })],
			fetch: async function hostile() {
				return new Response('{"data":{"item":{"__proto__":{"polluted":true},"when":"1"}}}', {
					headers: { "Content-Type": "application/json" },
				});
			} as typeof fetch,
		});
		const data = await client.gql<{ item: Record<string, unknown> }>({ query: "query Item { item { when } }" });

		expect(Object.getPrototypeOf(data.item)).toBe(Object.prototype);
		expect(data.item.when).toBe(1);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});
