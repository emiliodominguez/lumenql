import { expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { entities } from "../entities";
import type { Cache } from "../types";

/**
 * Waits.
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

/** A cache whose calls take a few milliseconds (IndexedDB, AsyncStorage...). */
function slowCache(): Cache {
	const inner = new MemoryCache();
	return {
		async get(key: string) {
			await wait(3);
			return inner.get(key);
		},
		async set(key: string, value: unknown) {
			await wait(3);
			return inner.set(key, value);
		},
		async delete(key: string) {
			await wait(3);
			return inner.delete(key);
		},
		async keys() {
			await wait(3);
			return inner.keys();
		},
	} as unknown as Cache;
}

const Q = "query Q { user { __typename id name } }";

it("propagation never writes back an entry invalidated while it was propagating", async function () {
	const client = new Client({
		url: "https://x/graphql",
		cache: slowCache(),
		plugins: [entities()],
		fetch: async function f() {
			return Response.json({ data: { rename: { __typename: "User", id: "1", name: "New" } } });
		} as typeof fetch,
	});

	for (const key of ["a", "b", "c"]) {
		await client.write({ key: [key], query: Q }, { user: { __typename: "User", id: "1", name: "Old" } });
	}
	await wait(30);

	await client.gql({ query: "mutation Rename { rename { __typename id name } }" });
	// The app knows "c" is outdated and invalidates it right away.
	await client.invalidate(["c"]);
	await wait(100);

	expect(await client.read({ key: ["c"], query: Q })).toBeUndefined();
});
