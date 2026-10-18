import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestClient, settle } from "../adapters/adapters.helpers";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { logger } from "../logger";
import { subscription } from "../svelte";
import type { Plugin } from "../types";

const URL = "https://review.test/graphql";

/**
 * Waits.
 *
 * @param ms - Milliseconds
 * @returns Resolves after the delay
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

afterEach(function () {
	vi.restoreAllMocks();
});

describe("fresh-context review", function () {
	it("never lets a live query's refetch trigger refetchQueries (it would refetch itself forever)", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function respond() {
			// Safety valve: a loop would otherwise starve the test.
			if (fetchMock.mock.calls.length > 20) return new Promise<Response>(function never() {});

			return Response.json({ data: { todos: ["a"] } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		// Options shared with `gql` type-check (no excess property check on variables).
		const options = { key: ["todos"], query: "query Todos { todos }", refetchQueries: ["Todos"] };
		const ref = client.watch(options);
		const stop = ref.subscribe(function listen() {});

		await wait(100);
		await ref.fetchMore({ variables: {}, merge: (current) => current });
		await wait(100);
		stop();

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("runs every plugin teardown even when one throws", async function () {
		const error = vi.spyOn(console, "error").mockImplementation(function silence() {});
		const lines: string[] = [];
		const bad: Plugin = {
			name: "bad",
			setup() {
				return function teardown() {
					throw new Error("boom");
				};
			},
		};
		const client = new Client({
			url: URL,
			fetch: async function respond() {
				return Response.json({ data: { a: 1 } });
			} as typeof fetch,
			plugins: [bad, logger(lines.push.bind(lines))],
		});

		client.dispose();
		await client.gql({ query: "query A { a }" });

		expect(lines).toEqual([]);
		expect(error).toHaveBeenCalledWith(expect.stringContaining("teardown"), expect.any(Error));
	});

	it("logs the real duration of a cache-and-network background refresh", async function () {
		const lines: string[] = [];
		const client = new Client({
			url: URL,
			cache: new MemoryCache(),
			plugins: [logger(lines.push.bind(lines))],
			fetch: async function respond() {
				await wait(50);

				return Response.json({ data: { a: 1 } });
			} as typeof fetch,
		});

		await client.gql({ query: "query A { a }" });
		lines.length = 0;
		await client.gql({ query: "query A { a }", fetchPolicy: "cache-and-network" });
		await wait(100);

		expect(lines[0]).toContain("cache hit");
		expect(Number(/ok in (\d+)ms/.exec(lines[1] ?? "")?.[1])).toBeGreaterThanOrEqual(40);
	});

	it("opens one stream for a Svelte store however its subscribers are registered", async function () {
		const { client, calls } = createTestClient();
		const store = subscription(client, { query: "subscription Ticks { tick }" });
		const run = vi.fn();
		const first = store.subscribe(run);
		const second = store.subscribe(run);

		await settle();
		expect(calls.Ticks).toBe(1);

		// Each subscription is its own: the stream stays open until both leave.
		first();
		expect(run).toHaveBeenCalled();
		second();
	});
});
