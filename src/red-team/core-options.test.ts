import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { scalars } from "../scalars";
import { isClientError } from "../errors";

const URL = "https://options.test/graphql";
const USER = "query User { user { name createdAt } }";
const PARTIAL = {
	data: { user: { name: "Ada", createdAt: "2026-01-01T00:00:00.000Z" } },
	errors: [{ message: "email failed", path: ["user", "email"] }],
};

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
function partialServer(counter: { calls: number }): typeof fetch {
	return async function respond(): Promise<Response> {
		counter.calls++;
		await wait(10);
		return Response.json(PARTIAL);
	} as typeof fetch;
}

describe("errorPolicy and deduplication", function () {
	it("a caller with errorPolicy ignore joining an errorPolicy none request still gets its partial data", async function () {
		const counter = { calls: 0 };
		const client = new Client({ url: URL, fetch: partialServer(counter), cache: new MemoryCache() });

		const strict = client.gql({ query: USER, fetchPolicy: "network-only" });
		const lenient = client.gql({ query: USER, fetchPolicy: "network-only", errorPolicy: "ignore" });

		await expect(strict).rejects.toThrow("email failed");
		await expect(lenient).resolves.toEqual(PARTIAL.data);
	});

	it("a caller with errorPolicy none joining an errorPolicy ignore request still fails", async function () {
		const counter = { calls: 0 };
		const client = new Client({ url: URL, fetch: partialServer(counter), cache: new MemoryCache() });

		const lenient = client.gql({ query: USER, fetchPolicy: "network-only", errorPolicy: "ignore" });
		const strict = client.gql({ query: USER, fetchPolicy: "network-only" });

		await expect(lenient).resolves.toEqual(PARTIAL.data);
		await expect(strict).rejects.toThrow("email failed");
	});
});

describe("errorPolicy all with a result hook", function () {
	it("ClientError.data is the transformed data, like the cached partial data", async function () {
		const counter = { calls: 0 };
		const client = new Client({
			url: URL,
			fetch: partialServer(counter),
			cache: new MemoryCache(),
			plugins: [
				scalars({
					createdAt: function toDate(value) {
						return new Date(String(value));
					},
				}),
			],
		});

		const error = await client.gql({ query: USER, errorPolicy: "all" }).catch(function capture(caught: unknown) {
			return caught;
		});
		const cached = await client.read<{ user: { createdAt: unknown } }>({ query: USER });

		expect(cached?.user.createdAt).toBeInstanceOf(Date);
		expect(isClientError(error) && (error.data as { user: { createdAt: unknown } }).user.createdAt).toBeInstanceOf(Date);
	});
});
