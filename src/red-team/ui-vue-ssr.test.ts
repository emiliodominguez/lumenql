import { describe, expect, it } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { lumenql, useQuery, useSubscription } from "../vue/index";

const TODOS = "query Todos { todos }";
const TICKS = "subscription Ticks { tick }";

/**
 * Waits.
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

describe("vue SSR", function () {
	it("useQuery does not leave a live query (and its polling) running on the server after renderToString", async function () {
		let requests = 0;
		const client = new Client({
			url: "https://ssr.test/graphql",
			cache: new MemoryCache(),
			fetch: async function server() {
				requests++;
				return Response.json({ data: { todos: ["a"] } });
			} as typeof fetch,
		});
		let watchers = 0;

		client.on("watch", function count(event) {
			watchers = event.watchers;
		});

		const Page = defineComponent({
			setup() {
				const todos = useQuery<{ todos: string[] }>({ key: ["todos"], query: TODOS, pollInterval: 20 });

				return function render() {
					return h("p", String(todos.loading.value));
				};
			},
		});

		await renderToString(createSSRApp(Page).use(lumenql(client)));
		const afterRender = requests;

		await wait(150);

		// The request is over and the page is sent: nothing should keep watching or polling on the server.
		expect({ watchers, requestsAfterRender: requests - afterRender }).toEqual({ watchers: 0, requestsAfterRender: 0 });
	});

	it("useSubscription does not leave a stream open on the server after renderToString", async function () {
		let signal: AbortSignal | undefined;
		const client = new Client({
			url: "https://ssr.test/graphql",
			fetch: async function server(_url: unknown, init?: RequestInit) {
				signal = init?.signal ?? undefined;
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('event: next\ndata: {"data":{"tick":1}}\n\n'));
						// never closes: a live subscription
					},
				});

				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			} as typeof fetch,
		});
		const Page = defineComponent({
			setup() {
				useSubscription<{ tick: number }>({ query: TICKS });

				return function render() {
					return h("p");
				};
			},
		});

		await renderToString(createSSRApp(Page).use(lumenql(client)));
		await wait(100);

		// Either the stream never started on the server (Vue 3.5) or it was closed once the render finished.
		expect(signal === undefined || signal.aborted).toBe(true);
	});
});
