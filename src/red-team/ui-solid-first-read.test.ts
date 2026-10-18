import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { createQuery } from "../solid/index";

const TODOS = "query Todos { todos }";

describe("solid browser build: the first synchronous read (what the first render sees)", function () {
	it("createQuery renders the data already in the cache (not an idle, not-loading empty state)", async function () {
		const client = new Client({
			url: "https://ssr.test/graphql",
			cache: new MemoryCache(),
			fetch: async function server() {
				return Response.json({ data: { todos: ["from network"] } });
			} as typeof fetch,
		});

		// e.g. prefetched or restored from a snapshot before rendering
		await client.write({ key: ["todos"], query: TODOS }, { todos: ["cached"] });

		const state = createRoot(function root(dispose) {
			const todos = createQuery<{ todos: string[] }>(function options() {
				return { key: ["todos"], query: TODOS };
			}, client);
			const snapshot = todos();

			dispose();
			return snapshot;
		});

		expect(state).toEqual({ data: { todos: ["cached"] }, error: undefined, loading: false });
	});

	it("an uncached createQuery is reported as loading on its first read, not as idle", function () {
		const client = new Client({
			url: "https://ssr.test/graphql",
			fetch: async function server() {
				return Response.json({ data: { todos: [] } });
			} as typeof fetch,
		});
		const state = createRoot(function root(dispose) {
			const todos = createQuery<{ todos: string[] }>(function options() {
				return { key: ["todos"], query: TODOS };
			}, client);
			const snapshot = todos();

			dispose();
			return snapshot;
		});

		expect(state.loading).toBe(true);
	});
});
