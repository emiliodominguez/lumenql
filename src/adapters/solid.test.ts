import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMutation, createQuery, createSubscription } from "../solid/index";
import { ADD, TICKS, TODOS, type Todos, createTestClient, settle } from "./adapters.helpers";

describe("lumenql/solid", function () {
	it("createQuery follows its options and stops with its owner", async function () {
		const { client, calls } = createTestClient();
		const [done, setDone] = createSignal(false);
		let todos: ReturnType<typeof createQuery<Todos, { done: boolean }>> | undefined;
		const dispose = createRoot(function root(dispose) {
			todos = createQuery<Todos, { done: boolean }>(function options() {
				return { key: ["todos", done()], query: TODOS, variables: { done: done() } };
			}, client);

			return dispose;
		});

		await settle();
		expect(todos!().data).toEqual({ todos: ["write docs"] });

		setDone(true);
		await settle();
		expect(todos!().data).toEqual({ todos: ["shipped"] });

		dispose();
		await client.invalidate([]);
		await settle();
		expect(calls.Todos).toBe(2);
	});

	it("createMutation and createSubscription expose their state", async function () {
		const { client } = createTestClient();
		let mutation: ReturnType<typeof createMutation<{ add: string }, { title: string }>> | undefined;
		let ticks: ReturnType<typeof createSubscription<{ tick: number }>> | undefined;
		const dispose = createRoot(function root(dispose) {
			mutation = createMutation<{ add: string }, { title: string }>(ADD, undefined, client);
			ticks = createSubscription<{ tick: number }>(function options() {
				return { query: TICKS };
			}, client);

			return dispose;
		});
		const [state, mutate] = mutation!;

		await expect(mutate({ title: "" })).rejects.toThrow("title required");
		expect(state().error).toBeInstanceOf(Error);
		await settle();
		expect(ticks!()).toMatchObject({ data: { tick: 3 }, active: false });
		dispose();
	});

	it("explains a missing client", function () {
		expect(function create() {
			createRoot(function root() {
				createQuery(function options() {
					return { query: TODOS };
				});
			});
		}).toThrow("ClientContext.Provider");
	});
});
