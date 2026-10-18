import { describe, expect, it } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { entities } from "./entities";

const URL = "https://entities.test/graphql";
const USERS = "query Users { users { __typename id name tags } }";
const USER = "query User { user { __typename id name email team { __typename id name } } }";
const RENAME = "mutation Rename { rename { __typename id name } }";

type Users = { users: Array<{ __typename: string; id: string; name: string; tags: string[] }> };
type User = {
	user: {
		__typename: string;
		id: string;
		name: string;
		email: string;
		team: { __typename: string; id: string; name: string };
	};
};

/**
 * A server holding one user, renamed by the `Rename` mutation.
 *
 * @returns The fetch
 */
function server(): typeof fetch {
	let name = "Ada";

	return async function respond(_url: unknown, init?: RequestInit): Promise<Response> {
		const query = String(JSON.parse(String(init?.body)).query);

		if (query.includes("Rename")) {
			name = "Ada Lovelace";
			return Response.json({ data: { rename: { __typename: "User", id: "1", name } } });
		}

		if (query.includes("Users")) {
			return Response.json({ data: { users: [{ __typename: "User", id: "1", name, tags: ["admin"] }] } });
		}

		return Response.json({
			data: {
				user: {
					__typename: "User",
					id: "1",
					name,
					email: "ada@x.dev",
					team: { __typename: "Team", id: "t", name: "Core" },
				},
			},
		});
	} as typeof fetch;
}

/**
 * Lets lanes and events settle.
 */
async function settle(): Promise<void> {
	await new Promise(function wait(resolve) {
		setTimeout(resolve, 10);
	});
}

describe("entities()", function () {
	it("propagates a mutation's entity into every cached result holding it, and live queries update", async function () {
		const client = new Client({ url: URL, fetch: server(), cache: new MemoryCache(), plugins: [entities()] });
		const list = client.watch<Users>({ key: ["users"], query: USERS });
		const stop = list.subscribe(function noop() {});

		await client.gql({ key: ["user", 1], query: USER });
		await settle();
		await client.gql({ query: RENAME });
		await settle();

		expect(list.getState().data?.users[0]).toEqual({
			__typename: "User",
			id: "1",
			name: "Ada Lovelace",
			tags: ["admin"],
		});
		expect(await client.read<User>({ key: ["user", 1], query: USER })).toMatchObject({
			user: { name: "Ada Lovelace", email: "ada@x.dev", team: { name: "Core" } },
		});
		stop();
	});

	it("propagates between cached query results, and stops once they agree", async function () {
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch: server(), cache, plugins: [entities()] });
		let writes = 0;

		client.on("cache", function count() {
			writes++;
		});
		await client.gql({ key: ["users"], query: USERS });
		await client.write<User>(
			{ key: ["user", 1], query: USER },
			{
				user: {
					__typename: "User",
					id: "1",
					name: "Renamed",
					email: "a@x.dev",
					team: { __typename: "Team", id: "t", name: "Core" },
				},
			},
		);
		await settle();

		expect((await client.read<Users>({ key: ["users"], query: USERS }))?.users[0]?.name).toBe("Renamed");
		// The user write, then the propagated list: no ping-pong.
		expect(writes).toBe(3);
	});

	it("never rewrites nested objects from another selection, and ignores objects without identity", async function () {
		const client = new Client({ url: URL, fetch: server(), cache: new MemoryCache(), plugins: [entities()] });

		await client.gql({ key: ["user", 1], query: USER });
		await client.write({ query: "query Other { team { id name } }" }, { team: { id: "t", name: "Platform" } });
		await settle();

		expect((await client.read<User>({ key: ["user", 1], query: USER }))?.user.team.name).toBe("Core");
	});

	it("supports custom identities", async function () {
		const client = new Client({
			url: URL,
			fetch: server(),
			cache: new MemoryCache(),
			plugins: [
				entities({
					identify: function bySku(value) {
						return typeof value.sku === "string" ? `Product:${value.sku}` : undefined;
					},
				}),
			],
		});

		await client.write(
			{ key: ["a"], query: "query A { product { sku price } }" },
			{ product: { sku: "p1", price: 10 } },
		);
		await client.write(
			{ key: ["b"], query: "query B { cart { items { sku price } } }" },
			{ cart: { items: [{ sku: "p1", price: 10 }] } },
		);
		await client.write(
			{ key: ["a"], query: "query A { product { sku price } }" },
			{ product: { sku: "p1", price: 12 } },
		);
		await settle();

		expect(await client.read({ key: ["b"], query: "query B { cart { items { sku price } } }" })).toEqual({
			cart: { items: [{ sku: "p1", price: 12 }] },
		});
	});
});
