import { describe, expect, it } from "vitest";
import { mutation, query, subscription, type SubscriptionState } from "../svelte/index";
import type { QueryState } from "../types";
import { ADD, TICKS, TODOS, type Todos, createTestClient, settle } from "./adapters.helpers";

describe("lumenql/svelte", function () {
	it("query() is a store that fetches while subscribed", async function () {
		const { client } = createTestClient();
		const todos = query<Todos>(client, { key: ["todos"], query: TODOS });
		const values: Array<QueryState<Todos>> = [];
		const stop = todos.subscribe(function push(value) {
			values.push(value);
		});

		await settle();
		stop();

		expect(values[0]).toMatchObject({ loading: true });
		expect(values.at(-1)).toMatchObject({ data: { todos: ["write docs"] }, loading: false });
	});

	it("mutation() tracks the latest call and rejects on failure", async function () {
		const { client } = createTestClient();
		const add = mutation<{ add: string }, { title: string }>(client, ADD);
		let state: QueryState<{ add: string }> | undefined;
		const stop = add.subscribe(function push(value) {
			state = value;
		});

		await expect(add.mutate({ title: "a" })).resolves.toEqual({ add: "a" });
		expect(state).toEqual({ data: { add: "a" }, error: undefined, loading: false });

		await expect(add.mutate({ title: "" })).rejects.toThrow("title required");
		expect(state?.error).toBeInstanceOf(Error);

		add.reset();
		expect(state).toEqual({ data: undefined, error: undefined, loading: false });
		stop();
	});

	it("subscription() opens with the first subscriber and closes with the last", async function () {
		const { client, calls } = createTestClient();
		const ticks = subscription<{ tick: number }>(client, { query: TICKS });
		let state: SubscriptionState<{ tick: number }> | undefined;

		expect(calls.Ticks).toBeUndefined();

		const stop = ticks.subscribe(function push(value) {
			state = value;
		});

		await settle();
		stop();

		expect(calls.Ticks).toBe(1);
		expect(state).toMatchObject({ data: { tick: 3 }, active: false });
	});
});
