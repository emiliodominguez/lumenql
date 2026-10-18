import { describe, expect, it } from "vitest";
import { Client as CoreClient } from "../core";
import { Client } from "../client";
import { incremental } from "../incremental";
import { persistedQueries } from "../persisted";
import { sse } from "../sse";
import type { ClientConfiguration, Plugin } from "../types";

const URL = "https://plugins.test/graphql";

describe("extend()", function () {
	it("works for a subclass whose constructor takes other arguments (2.0.0 returned a Client)", async function () {
		class ApiClient extends Client {
			constructor(endpoint: string, extra?: Partial<ClientConfiguration>) {
				super({ url: endpoint, ...extra });
			}
		}
		const calls: string[] = [];
		const api = new ApiClient(URL, {
			fetch: async function f(url: unknown) {
				calls.push(String(url));
				return Response.json({ data: { a: 1 } });
			} as typeof fetch,
		});
		const child = api.extend({ headers: { "x-a": "1" } });

		await child.gql({ query: "query A { a }" });
		expect(calls).toEqual([URL]);
	});
});

describe("plugin order", function () {
	it("an @defer subscription still advertises multipart/mixed with plugins [incremental(), sse()]", async function () {
		let accept: string | null = null;
		const client = new CoreClient({
			url: URL,
			plugins: [incremental(), sse()],
			fetch: async function f(_url: unknown, init?: RequestInit) {
				accept = new Headers(init?.headers).get("Accept");
				return Response.json({ data: { a: 1 } });
			} as typeof fetch,
		});

		for await (const _ of client.subscribe({ query: "query A { a ... @defer { b } }" })) break;

		expect(accept).toContain("text/event-stream");
		expect(accept).toContain("multipart/mixed");
	});
});

describe("persistedQueries()", function () {
	it("the fallback after PersistedQueryNotSupported keeps extensions added by an outer plugin", async function () {
		const bodies: Array<Record<string, unknown>> = [];
		const tracing: Plugin = {
			name: "tracing",
			send(payload, _context, next) {
				return next({ ...payload, extensions: { ...payload.extensions, trace: "t1" } });
			},
		};
		const client = new CoreClient({
			url: URL,
			plugins: [tracing, persistedQueries()],
			fetch: async function f(_url: unknown, init?: RequestInit) {
				const body = JSON.parse(String(init?.body));
				bodies.push(body);
				if (body.query === undefined) return Response.json({ errors: [{ message: "PersistedQueryNotSupported" }] });
				return Response.json({ data: { a: 1 } });
			} as typeof fetch,
		});

		await client.gql({ query: "query A { a }" });

		expect(bodies).toHaveLength(2);
		expect(bodies[1]?.extensions).toEqual({ trace: "t1" });
	});
});
