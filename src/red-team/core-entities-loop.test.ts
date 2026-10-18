import { expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { entities } from "../entities";

const Q = "query Q { q }";

/**
 * Test helper.
 */
async function run(list: Array<[string, unknown]>): Promise<number> {
	const client = new Client({ url: "https://x/graphql", cache: new MemoryCache(), plugins: [entities()] });
	let writes = 0;
	client.on("cache", function count() {
		writes++;
		// Guard: without it the propagation loop runs on microtasks forever and starves timers (the test hangs).
		if (writes === 1000) client.dispose();
	});
	for (const [key, data] of list) await client.write({ key: [key], query: Q }, data);
	await new Promise(function later(resolve) {
		setTimeout(resolve, 50);
	});
	return writes;
}

it('reduced fuzz case (id 1 vs "1") converges', async function () {
	const writes = await run([
		[
			"k1",
			{
				q: [
					{
						__typename: "User",
						id: "2",
						friends: [{ __typename: "User", id: "2", friend: { __typename: "User", id: "1" } }],
					},
				],
			},
		],
		["k2", { q: [{ __typename: "User", id: 1 }] }],
		["k0", { q: [{ __typename: "User", id: "1" }] }],
		["k3", { q: [{ __typename: "User", id: "2", friends: [{ __typename: "User", id: 1 }] }] }],
	]);
	expect(writes).toBeLessThan(30);
});

it("same shape with conflicting names (stale vs fresh responses) converges", async function () {
	const writes = await run([
		[
			"k1",
			{
				q: [
					{
						__typename: "User",
						id: "2",
						friends: [{ __typename: "User", id: "2", friend: { __typename: "User", id: "1", name: "a" } }],
					},
				],
			},
		],
		["k2", { q: [{ __typename: "User", id: "1", name: "b" }] }],
		["k0", { q: [{ __typename: "User", id: "1", name: "c" }] }],
		["k3", { q: [{ __typename: "User", id: "2", friends: [{ __typename: "User", id: "1", name: "d" }] }] }],
	]);
	expect(writes).toBeLessThan(30);
});

it("three entries, conflicting names, written back to back", async function () {
	const writes = await run([
		["k1", { q: { __typename: "User", id: "1", name: "a" } }],
		["k2", { q: { __typename: "User", id: "1", name: "b" } }],
		["k3", { q: { __typename: "User", id: "1", name: "c" } }],
	]);
	expect(writes).toBeLessThan(30);
});

it("a list and a detail answered back to back with different names converge", async function () {
	const writes = await run([
		[
			"users",
			{
				users: [
					{ __typename: "User", id: "1", name: "a" },
					{ __typename: "User", id: "2", name: "x" },
				],
			},
		],
		[
			"user1",
			{
				user: {
					__typename: "User",
					id: "1",
					name: "b",
					team: { __typename: "Team", id: "t", lead: { __typename: "User", id: "2", name: "y" } },
				},
			},
		],
		[
			"user2",
			{
				user: {
					__typename: "User",
					id: "2",
					name: "z",
					team: { __typename: "Team", id: "t", members: [{ __typename: "User", id: "1", name: "c" }] },
				},
			},
		],
	]);
	expect(writes).toBeLessThan(30);
});

it("five flat entries with different values converge", async function () {
	const writes = await run(
		["a", "b", "c", "d", "e"].map(function entry(name, index) {
			return [`k${index}`, { u: { __typename: "User", id: "1", name } }] as [string, unknown];
		}),
	);
	expect(writes).toBeLessThan(60);
});
