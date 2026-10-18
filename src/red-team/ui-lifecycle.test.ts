// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createApp, effectScope } from "vue";
import { Client } from "../client";
import { createSubscription } from "../solid/index";
import { subscription } from "../svelte/index";
import { lumenql, useSubscription } from "../vue/index";

const TICKS = "subscription Ticks { tick }";

/**
 * Waits.
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

/**
 * Test helper: streamingClient.
 */
function streamingClient(signals: AbortSignal[]): Client {
	return new Client({
		url: "https://life.test/graphql",
		headers: async function slowHeaders() {
			await wait(5);
			return {};
		},
		fetch: async function server(input: unknown, init?: RequestInit) {
			signals.push(init?.signal ?? (input as Request).signal);
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('event: next\ndata: {"data":{"tick":1}}\n\n'));
				},
			});

			return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
		} as typeof fetch,
	});
}

describe("closing during the first await", function () {
	it("svelte", async function () {
		const signals: AbortSignal[] = [];
		const store = subscription(streamingClient(signals), { query: TICKS });

		store.subscribe(function noop() {})();
		await wait(30);
		expect(
			signals.every(function closed(signal) {
				return signal.aborted;
			}),
		).toBe(true);
	});

	it("vue", async function () {
		const signals: AbortSignal[] = [];
		const app = createApp({
			render: function render() {
				return null;
			},
		}).use(lumenql(streamingClient(signals)));
		const scope = effectScope();

		app.runWithContext(function run() {
			scope.run(function setup() {
				useSubscription({ query: TICKS });
			});
		});
		scope.stop();
		await wait(30);
		expect(
			signals.every(function closed(signal) {
				return signal.aborted;
			}),
		).toBe(true);
	});

	it("solid", async function () {
		const signals: AbortSignal[] = [];
		const client = streamingClient(signals);

		createRoot(function root(dispose) {
			createSubscription(function options() {
				return { query: TICKS };
			}, client);
			return dispose;
		})();
		await wait(30);
		expect(
			signals.every(function closed(signal) {
				return signal.aborted;
			}),
		).toBe(true);
	});
});
