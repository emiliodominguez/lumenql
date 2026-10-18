import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client as CoreClient } from "../core";
import { Client } from "../client";
import { logger } from "../logger";
import { sse } from "../sse";

const URL = "https://events.test/graphql";

/**
 * Test helper.
 */
function json(data: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Test helper.
 */
function sseResponse(events: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const e of events) controller.enqueue(new TextEncoder().encode(e));
			// keep open
		},
	});
	return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

describe("events", function () {
	it("a subscription answered with a single JSON result emits done", async function () {
		const client = new CoreClient({
			url: URL,
			fetch: async function f() {
				return json({ data: { tick: 1 } });
			} as typeof fetch,
		});
		const seen: string[] = [];
		client.on("operation", function o() {
			seen.push("operation");
		});
		client.on("result", function r() {
			seen.push("result");
		});
		client.on("done", function d() {
			seen.push("done");
		});
		client.on("error", function e() {
			seen.push("error");
		});

		const results: unknown[] = [];
		for await (const value of client.subscribe({ query: "subscription Tick { tick }" })) results.push(value);

		expect(results).toEqual([{ tick: 1 }]);
		expect(seen).toEqual(["operation", "result", "done"]);
	});

	it("breaking out of a subscription emits done", async function () {
		const client = new CoreClient({
			url: URL,
			plugins: [sse()],
			fetch: async function f() {
				return sseResponse(['event: next\ndata: {"data":{"tick":1}}\n\n']);
			} as typeof fetch,
		});
		const seen: string[] = [];
		client.on("done", function d() {
			seen.push("done");
		});
		client.on("error", function e() {
			seen.push("error");
		});

		for await (const value of client.subscribe({ query: "subscription Tick { tick }" })) {
			expect(value).toEqual({ tick: 1 });
			break;
		}

		expect(seen).toEqual(["done"]);
	});

	it("logger does not leak start times for broken-out streams", async function () {
		const lines: string[] = [];
		const starts: Map<unknown, unknown>[] = [];
		const originalSet = Map.prototype.set;
		const client = new CoreClient({
			url: URL,
			plugins: [
				sse(),
				logger(function log(line: string) {
					lines.push(line);
				}),
			],
			fetch: async function f() {
				return sseResponse(['event: next\ndata: {"data":{"tick":1}}\n\n']);
			} as typeof fetch,
		});
		// Capture maps receiving numeric ids (the logger's `starts`).
		Map.prototype.set = function spy(this: Map<unknown, unknown>, key: unknown, value: unknown) {
			if (typeof key === "number" && typeof value === "number" && value > 1e12 && !starts.includes(this))
				starts.push(this);
			return originalSet.call(this, key, value);
		};
		try {
			for (let i = 0; i < 5; i++) {
				for await (const _ of client.subscribe({ query: "subscription Tick { tick }" })) break;
			}
		} finally {
			Map.prototype.set = originalSet;
		}
		expect(starts.length).toBeGreaterThan(0);
		expect(
			starts.reduce(function sum(n, m) {
				return n + m.size;
			}, 0),
		).toBe(0);
	});

	it("a failing cache read emits an error event after the operation event", async function () {
		const cache = new MemoryCache();
		cache.get = function broken() {
			return Promise.reject(new Error("storage down"));
		} as typeof cache.get;
		const client = new CoreClient({
			url: URL,
			cache,
			fetch: async function f() {
				return json({ data: { a: 1 } });
			} as typeof fetch,
		});
		const seen: string[] = [];
		client.on("operation", function o() {
			seen.push("operation");
		});
		client.on("result", function r() {
			seen.push("result");
		});
		client.on("error", function e() {
			seen.push("error");
		});

		await expect(client.gql({ query: "query A { a }" })).rejects.toThrow("storage down");
		expect(seen).toEqual(["operation", "error"]);
	});

	it("cache-and-network background refresh is logged like in 2.0.0 (debug)", async function () {
		const lines: string[] = [];
		const original = console.debug;
		console.debug = function capture(line: string) {
			lines.push(line);
		};
		try {
			const client = new Client({
				url: URL,
				debug: true,
				cache: new MemoryCache(),
				fetch: async function f() {
					return json({ data: { a: 1 } });
				} as typeof fetch,
			});
			await client.gql({ query: "query A { a }" });
			lines.length = 0;
			await client.gql({ query: "query A { a }", fetchPolicy: "cache-and-network" });
			await new Promise(function wait(r) {
				setTimeout(r, 20);
			});
		} finally {
			console.debug = original;
		}
		// 2.0.0 logged "cache hit" then "ok in Nms" for the background refresh.
		expect(
			lines.some(function ok(l) {
				return l.includes("cache hit");
			}),
		).toBe(true);
		expect(
			lines.some(function ok(l) {
				return l.includes("ok in");
			}),
		).toBe(true);
	});
});
