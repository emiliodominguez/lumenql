import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { entities } from "../entities";
import { scalars } from "../scalars";

/**
 * Waits.
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

/**
 * Test helper.
 */
function toDate(value: unknown): Date {
	return new Date(String(value));
}

describe("scalars() with entities()", function () {
	it("a parsed field (Date) propagates like the raw string would", async function () {
		let updatedAt = "2026-01-01T00:00:00.000Z";
		const client = new Client({
			url: "https://x/graphql",
			cache: new MemoryCache(),
			plugins: [scalars({ updatedAt: toDate }), entities()],
			fetch: async function f(_url: unknown, init?: RequestInit) {
				const query = String(JSON.parse(String(init?.body)).query);
				if (query.includes("mutation")) {
					updatedAt = "2026-06-01T00:00:00.000Z";
					return Response.json({ data: { touch: { __typename: "Doc", id: "1", updatedAt } } });
				}
				return Response.json({ data: { docs: [{ __typename: "Doc", id: "1", updatedAt }] } });
			} as typeof fetch,
		});
		const DOCS = "query Docs { docs { __typename id updatedAt } }";

		await client.gql({ query: DOCS });
		await client.gql({ query: "mutation Touch { touch { __typename id updatedAt } }" });
		await wait(20);

		const docs = await client.read<{ docs: Array<{ updatedAt: Date }> }>({ query: DOCS });
		expect(docs?.docs[0]?.updatedAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
	});
});

describe("scalars() parsers returning class instances", function () {
	it("instances that memoize lazily (like Luxon's DateTime) keep working", async function () {
		"use strict";
		class Moment {
			readonly iso: string;
			cachedWeek: number | null = null;
			constructor(iso: string) {
				this.iso = iso;
			}
			get week(): number {
				// Lazy memoization, as Luxon does for week data.
				if (this.cachedWeek === null) this.cachedWeek = Math.ceil(new Date(this.iso).getUTCDate() / 7);
				return this.cachedWeek;
			}
		}
		const client = new Client({
			url: "https://x/graphql",
			plugins: [
				scalars({
					at: function parse(value) {
						return new Moment(String(value));
					},
				}),
			],
			fetch: async function f() {
				return Response.json({ data: { event: { at: "2026-01-15T00:00:00.000Z" } } });
			} as typeof fetch,
		});

		const data = await client.gql<{ event: { at: Moment } }>({ query: "query E { event { at } }" });
		expect(function read() {
			return data.event.at.week;
		}).not.toThrow();
	});
});
