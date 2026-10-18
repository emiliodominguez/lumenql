import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";

export const TODOS = "query Todos($done: Boolean) { todos(done: $done) }";
export const ADD = "mutation Add($title: String!) { add(title: $title) }";
export const TICKS = "subscription Ticks { tick }";

export type Todos = { todos: string[] };

/**
 * A client on a mock server: `Todos` answers by its `done` variable, `Add` fails for an empty title, `Ticks` streams
 * three SSE events.
 *
 * @returns The client and the number of requests per operation
 */
export function createTestClient(): { client: Client; calls: Record<string, number> } {
	const calls: Record<string, number> = {};
	const client = new Client({
		url: "https://adapters.test/graphql",
		cache: new MemoryCache(),
		fetch: async function server(_url: unknown, init?: RequestInit): Promise<Response> {
			const { query, variables } = JSON.parse(String(init?.body)) as {
				query: string;
				variables?: Record<string, unknown>;
			};
			const name = /(?:query|mutation|subscription)\s+(\w+)/.exec(query)![1]!;

			calls[name] = (calls[name] ?? 0) + 1;

			if (name === "Todos") return Response.json({ data: { todos: variables?.done ? ["shipped"] : ["write docs"] } });
			if (name === "Add") {
				return variables?.title
					? Response.json({ data: { add: variables.title } })
					: Response.json({ errors: [{ message: "title required" }] });
			}

			const events = [1, 2, 3].map(function event(tick: number): string {
				return `event: next\ndata: {"data":{"tick":${tick}}}\n\n`;
			});

			return new Response(`${events.join("")}event: complete\ndata:\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		} as typeof fetch,
	});

	return { client, calls };
}

/**
 * Lets requests, streams and reactive updates settle.
 */
export async function settle(): Promise<void> {
	await new Promise(function wait(resolve) {
		setTimeout(resolve, 20);
	});
}
