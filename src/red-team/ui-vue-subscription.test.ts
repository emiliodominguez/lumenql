// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick, ref } from "vue";
import { Client } from "../client";
import type { SubscriptionRequest } from "../types";
import { lumenql, useSubscription } from "../vue/index";

const ON_MESSAGE = "subscription OnMessage($room: String!) { message(room: $room) }";

/**
 * Waits.
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

describe("vue useSubscription", function () {
	it("does not show the previous variables' payload after switching to new variables", async function () {
		const client = new Client({
			url: "https://vue.test/graphql",
			subscriptionTransport: {
				subscribe: async function* transport(request: SubscriptionRequest, signal: AbortSignal) {
					const room = (request.variables as { room: string }).room;

					// Room "a" has a message right away; room "b" is quiet for now.
					if (room === "a") yield { data: { message: "secret message in room a" } };

					await new Promise(function hang(resolve) {
						signal.addEventListener("abort", resolve);
					});
				},
			},
		});
		const room = ref("a");
		const app = createApp({
			render: function render() {
				return null;
			},
		}).use(lumenql(client));
		const scope = effectScope();
		const result = app.runWithContext(function run() {
			return scope.run(function setup() {
				return useSubscription<{ message: string }, { room: string }>(function options() {
					return { query: ON_MESSAGE, variables: { room: room.value } };
				});
			})!;
		});

		await wait(10);
		expect(result.data.value).toEqual({ message: "secret message in room a" });

		room.value = "b";
		await nextTick();
		await wait(10);

		// React's useSubscription (and the Svelte/Solid bindings) reset `data` when the stream is reopened.
		expect(result.active.value).toBe(true);
		expect(result.data.value).toBeUndefined();

		scope.stop();
	});
});
