// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { lumenql, useMutation, useQuery, useSubscription } from "../vue/index";
import { ADD, TICKS, TODOS, type Todos, createTestClient, settle } from "./adapters.helpers";

describe("lumenql/vue", function () {
	it("useQuery follows reactive variables and stops when unmounted", async function () {
		const { client, calls } = createTestClient();
		const done = ref(false);
		let result: ReturnType<typeof useQuery<Todos, { done: boolean }>> | undefined;
		const Root = defineComponent({
			setup() {
				result = useQuery<Todos, { done: boolean }>(function options() {
					return { key: ["todos", done.value], query: TODOS, variables: { done: done.value } };
				});

				return function render() {
					return h("p", result!.data.value?.todos.join(","));
				};
			},
		});
		const element = document.createElement("div");
		const app = createApp(Root).use(lumenql(client));

		app.mount(element);
		await settle();
		expect(element.textContent).toBe("write docs");

		done.value = true;
		await settle();
		await nextTick();
		expect(element.textContent).toBe("shipped");
		expect(result!.loading.value).toBe(false);

		app.unmount();
		await client.invalidate([]);
		await settle();
		expect(calls.Todos).toBe(2);
	});

	it("useMutation and useSubscription expose their state as refs", async function () {
		const { client } = createTestClient();
		let mutation: ReturnType<typeof useMutation<{ add: string }, { title: string }>> | undefined;
		let ticks: ReturnType<typeof useSubscription<{ tick: number }>> | undefined;
		const Root = defineComponent({
			setup() {
				mutation = useMutation<{ add: string }, { title: string }>(ADD);
				ticks = useSubscription<{ tick: number }>({ query: TICKS });

				return function render() {
					return h("p");
				};
			},
		});
		const app = createApp(Root).use(lumenql(client));

		app.mount(document.createElement("div"));
		await expect(mutation!.mutate({ title: "a" })).resolves.toEqual({ add: "a" });
		await settle();

		expect(mutation!.data.value).toEqual({ add: "a" });
		expect(ticks!.data.value).toEqual({ tick: 3 });
		expect(ticks!.active.value).toBe(false);
		app.unmount();
	});

	it("explains a missing client", function () {
		const Root = defineComponent({
			setup() {
				useQuery({ query: TODOS });

				return function render() {
					return h("p");
				};
			},
		});
		const app = createApp(Root);
		let error: unknown;

		app.config.errorHandler = function capture(caught: unknown) {
			error = caught;
		};
		app.mount(document.createElement("div"));

		expect(String(error)).toContain("app.use(lumenql(client))");
	});
});
