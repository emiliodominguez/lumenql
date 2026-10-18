import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { entities } from "../entities";
import { optimistic } from "../optimistic";

const URL = "https://entities.test/graphql";
const USERS = "query Users { users { __typename id name } }";
type Users = { users: Array<{ __typename: string; id: string; name: string }> };

/**
 * Waits.
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

/**
 * Server: a list of users; `Rename` renames user 1, `Add` adds a user and renames user 1.
 */
function server(options: { listDelay?: number } = {}) {
	const state = { users: [{ __typename: "User", id: "1", name: "Ada" }] };
	const fetchFn = async function respond(_url: unknown, init?: RequestInit): Promise<Response> {
		const body = JSON.parse(String(init?.body));
		const query = String(body.query);

		if (query.includes("mutation Add")) {
			state.users = [
				{ __typename: "User", id: "1", name: "Ada L." },
				{ __typename: "User", id: "2", name: "Grace" },
			];
			return Response.json({ data: { add: { __typename: "User", id: "1", name: "Ada L." } } });
		}

		if (query.includes("mutation Noop")) return Response.json({ data: { noop: true } });

		if (query.includes("mutation Rename")) {
			state.users = state.users.map(function rename(u) {
				return u.id === "1" ? { ...u, name: body.variables.name } : u;
			});
			return Response.json({ data: { rename: { __typename: "User", id: "1", name: body.variables.name } } });
		}

		const snapshot = { users: state.users };
		if (options.listDelay) await wait(options.listDelay);
		return Response.json({ data: snapshot });
	} as typeof fetch;

	return { fetch: fetchFn, state };
}

describe("entities() attacks", function () {
	it("propagation does not supersede a refetchQueries refetch already in flight", async function () {
		const { fetch } = server({ listDelay: 30 });
		const client = new Client({ url: URL, fetch, cache: new MemoryCache(), plugins: [entities()] });
		const log: string[] = [];
		client.on("error", function e(ev) {
			log.push("error " + String(ev.error));
		});
		const list = client.watch<Users>({ key: ["users"], query: USERS });
		const stop = list.subscribe(function noop() {});

		await wait(200);
		if (!list.getState().data) throw new Error(log.join("\n") + JSON.stringify(list.getState()));
		expect(list.getState().data?.users).toHaveLength(1);

		// The documented combo: entities() for fields, refetchQueries for list membership.
		await client.gql({ query: "mutation Add { add { __typename id name } }", refetchQueries: ["Users"] });
		await wait(200);

		expect(
			list.getState().data?.users.map(function id(u) {
				return u.id;
			}),
		).toEqual(["1", "2"]);
		expect((await client.read<Users>({ key: ["users"], query: USERS }))?.users).toHaveLength(2);
		stop();
	});

	it("a mutation through an extend()ed client propagates into results cached by the parent", async function () {
		const { fetch } = server();
		const client = new Client({ url: URL, fetch, cache: new MemoryCache(), plugins: [entities()] });

		await client.gql({ key: ["users"], query: USERS });
		const child = client.extend({ headers: { "x-tenant": "a" } });
		await child.gql({
			query: "mutation Rename($name: String) { rename { __typename id name } }",
			variables: { name: "Countess" },
		});
		await wait(20);

		expect((await client.read<Users>({ key: ["users"], query: USERS }))?.users[0]?.name).toBe("Countess");
	});

	it("propagation never overwrites newer data another client sharing the cache stored", async function () {
		const { fetch, state } = server();
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch, cache, plugins: [entities()] });
		const other = new Client({ url: URL, fetch, cache });

		await client.gql({ key: ["users"], query: USERS });
		// The server list grows; another client sharing the cache refreshes the entry.
		state.users = [...state.users, { __typename: "User", id: "2", name: "Grace" }];
		await other.gql({ key: ["users"], query: USERS, fetchPolicy: "network-only" });
		expect((await client.read<Users>({ key: ["users"], query: USERS }))?.users).toHaveLength(2);

		// A rename through the entities client.
		await client.gql({
			query: "mutation Rename($name: String) { rename { __typename id name } }",
			variables: { name: "Countess" },
		});
		await wait(20);

		const users = (await client.read<Users>({ key: ["users"], query: USERS }))?.users;
		expect(
			users?.map(function id(u) {
				return u.id;
			}),
		).toEqual(["1", "2"]);
		expect(users?.[0]?.name).toBe("Countess");
	});

	it("propagation never resurrects an entry invalidated through another client", async function () {
		const { fetch } = server();
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch, cache, plugins: [entities()] });
		const other = client.extend({});

		await client.gql({ key: ["users"], query: USERS });
		await other.invalidate(["users"]);
		expect(await client.read({ key: ["users"], query: USERS })).toBeUndefined();

		await client.gql({
			query: "mutation Rename($name: String) { rename { __typename id name } }",
			variables: { name: "Countess" },
		});
		await wait(20);

		// Invalidated data must not come back: the next cache-first query must hit the network.
		expect(await client.read({ key: ["users"], query: USERS })).toBeUndefined();
	});

	it("propagation keeps the committed effect of an optimistic mutation", async function () {
		const { fetch } = server();
		const client = new Client({ url: URL, fetch, cache: new MemoryCache(), plugins: [entities()] });
		const target = { key: ["users"], query: USERS };

		await client.gql<Users>(target);
		// Optimistically add Grace; the mutation succeeds without invalidation: its layer becomes real data.
		await client.gql({
			query: "mutation Noop { noop }",
			optimistic: [
				optimistic<Users, Record<string, never>>(target, function addGrace(current) {
					return { users: [...(current?.users ?? []), { __typename: "User", id: "2", name: "Grace" }] };
				}),
			],
		});
		await wait(20);
		expect((await client.read<Users>(target))?.users).toHaveLength(2);

		await client.gql({
			query: "mutation Rename($name: String) { rename { __typename id name } }",
			variables: { name: "Countess" },
		});
		await wait(20);

		const users = (await client.read<Users>(target))?.users;
		expect(users?.[0]?.name).toBe("Countess");
		expect(users).toHaveLength(2);
	});

	it("holders index stays bounded when one entity appears in many entries", async function () {
		const sizes: Set<unknown>[] = [];
		const originalAdd = Set.prototype.add;
		const client = new Client({
			url: URL,
			cache: new MemoryCache({ maxSize: 10_000 }),
			plugins: [entities({ limit: 10 })],
		});

		Set.prototype.add = function spy(this: Set<unknown>, value: unknown) {
			if (typeof value === "string" && value.includes("page-") && !sizes.includes(this)) sizes.push(this);
			return originalAdd.call(this, value);
		};
		try {
			for (let i = 0; i < 300; i++) {
				await client.write(
					{ key: [`page-${i}`], query: USERS },
					{ users: [{ __typename: "User", id: "1", name: "Ada" }] },
				);
			}
			await wait(20);
		} finally {
			Set.prototype.add = originalAdd;
		}

		const biggest = Math.max(
			...sizes.map(function size(s) {
				return s.size;
			}),
		);
		// Only 10 entries are tracked: the per-entity holder set should not keep 300 keys.
		expect(biggest).toBeLessThanOrEqual(100);
	});
});
