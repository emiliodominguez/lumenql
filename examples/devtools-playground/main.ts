// The devtools playground: a todo app on an in-page mock GraphQL server, with the devtools panel open beside it.
// Build: `node examples/devtools-playground/build.mjs` (writes a self-contained `playground.html`).
import { MemoryCache } from "../../src/cache/memory-cache";
import { Client } from "../../src/core";
import { mountDevtools } from "../../src/devtools/index";
import { optimistic } from "../../src/optimistic";
import { sse } from "../../src/sse";

type Todo = { id: string; title: string; done: boolean };
type Todos = { todos: Todo[] };

const TODOS = "query Todos { todos { id title done } }";
const ADD = "mutation AddTodo($title: String!) { addTodo(title: $title) { id title done } }";
const TOGGLE = "mutation ToggleTodo($id: ID!) { toggleTodo(id: $id) { id done } }";
const FLAKY = "query ServerHealth { health { region latency } }";
const TICKS = "subscription Deploys { deploy { step status } }";

const server = {
	todos: [
		{ id: "1", title: "Profile the search page", done: true },
		{ id: "2", title: "Review the cache invalidation PR", done: false },
		{ id: "3", title: "Ship the onboarding flow", done: false },
	] as Todo[],
	next: 4,
	healthAttempts: 0,
};

/**
 * Waits.
 *
 * @param ms - Milliseconds
 * @returns Resolves after the delay
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

/**
 * An SSE stream of deploy steps, one every 700ms.
 *
 * @returns The response
 */
function deployStream(): Response {
	const steps = ["build", "test", "migrate", "release"];
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const [index, step] of steps.entries()) {
				await wait(700);
				const status = index === steps.length - 1 ? "live" : "done";

				controller.enqueue(
					encoder.encode(`event: next\ndata: ${JSON.stringify({ data: { deploy: { step, status } } })}\n\n`),
				);
			}

			controller.enqueue(encoder.encode("event: complete\ndata:\n\n"));
			controller.close();
		},
	});

	return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * The mock GraphQL server, routed by operation name, with realistic latency.
 *
 * @param _url - The endpoint
 * @param init - The request
 * @returns The response
 */
async function mockFetch(_url: unknown, init?: RequestInit): Promise<Response> {
	const { query, variables } = JSON.parse(String(init?.body)) as {
		query: string;
		variables?: Record<string, string>;
	};
	// Routed by the operation's name, as written in the document.
	const name = /(?:query|mutation|subscription)\s+(\w+)/.exec(query)?.[1] ?? "";

	await wait(name === "AddTodo" ? 900 : 250 + Math.random() * 250);

	if (name === "Todos") return Response.json({ data: { todos: server.todos } });

	if (name === "AddTodo") {
		if (/fail/i.test(variables?.title ?? "")) {
			return Response.json({ errors: [{ message: "Title rejected by the server", path: ["addTodo"] }], data: null });
		}

		const todo = { id: String(server.next++), title: variables!.title!, done: false };

		server.todos = [...server.todos, todo];
		return Response.json({ data: { addTodo: todo } });
	}

	if (name === "ToggleTodo") {
		server.todos = server.todos.map(function toggle(todo) {
			return todo.id === variables!.id ? { ...todo, done: !todo.done } : todo;
		});
		const toggled = server.todos.find(function matches(todo) {
			return todo.id === variables!.id;
		});

		return Response.json({ data: { toggleTodo: toggled } });
	}

	if (name === "ServerHealth") {
		// Fails twice, then answers: the client retries.
		if (++server.healthAttempts % 3 !== 0) return new Response("upstream timeout", { status: 503 });

		return Response.json({ data: { health: { region: "eu-west-1", latency: 38 } } });
	}

	if (name === "Deploys") return deployStream();

	return Response.json({ errors: [{ message: `Unknown operation ${name}` }] });
}

const client = new Client({
	url: "/graphql",
	cache: new MemoryCache(),
	fetch: mockFetch as typeof fetch,
	retry: { attempts: 2, delay: 400 },
	plugins: [sse()],
});

// Open beside the app on wide screens; on a phone it would cover the app, so the launcher opens it on demand.
mountDevtools(client, { open: matchMedia("(min-width: 900px)").matches });

const list = document.getElementById("todos")!;
const status = document.getElementById("status")!;
const ref = client.watch<Todos>({ key: ["todos"], query: TODOS });

ref.subscribe(function render({ data, loading, error }) {
	status.textContent = error ? `Error: ${(error as Error).message}` : loading ? "Loading…" : "Up to date";
	status.dataset.state = error ? "error" : loading ? "loading" : "ok";
	list.replaceChildren(
		...(data?.todos ?? []).map(function item(todo) {
			const row = document.createElement("li");
			const box = document.createElement("input");
			const label = document.createElement("label");

			box.type = "checkbox";
			box.id = `todo-${todo.id}`;
			box.checked = todo.done;
			box.addEventListener("change", function toggle() {
				client.gql({ query: TOGGLE, variables: { id: todo.id }, invalidates: [["todos"]] }).catch(ignore);
			});
			label.htmlFor = box.id;
			label.textContent = todo.title;
			row.dataset.optimistic = String(todo.id.startsWith("temp"));
			row.append(box, label);

			return row;
		}),
	);
});

/**
 * Adds a todo with an optimistic row, reconciled by invalidating the list.
 *
 * @param title - The title
 */
function addTodo(title: string): void {
	client
		.gql({
			query: ADD,
			variables: { title },
			invalidates: [["todos"]],
			optimistic: [
				optimistic<Todos, Record<string, never>>({ key: ["todos"], query: TODOS }, function add(current) {
					return { todos: [...(current?.todos ?? []), { id: `temp-${Date.now()}`, title, done: false }] };
				}),
			],
		})
		.catch(ignore);
}

/**
 * Swallows an expected failure (the devtools show it).
 */
function ignore(): void {}

const actions: Record<string, () => void> = {
	refetch() {
		void ref.refetch();
	},
	dedupe() {
		Promise.all([
			client.gql({ query: TODOS, fetchPolicy: "network-only" }),
			client.gql({ query: TODOS, fetchPolicy: "network-only" }),
		]).catch(ignore);
	},
	fail() {
		addTodo("This one will fail");
	},
	retry() {
		client.gql({ query: FLAKY, fetchPolicy: "network-only" }).catch(ignore);
	},
	stream() {
		void (async function follow() {
			for await (const _ of client.subscribe({ query: TICKS })) void _;
		})();
	},
	invalidate() {
		client.invalidate(["todos"]).catch(ignore);
	},
};

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) {
	button.addEventListener("click", actions[button.dataset.action!]!);
}

document.getElementById("add")!.addEventListener("submit", function submit(event) {
	const input = document.getElementById("title") as HTMLInputElement;

	event.preventDefault();
	if (input.value.trim()) addTodo(input.value.trim());
	input.value = "";
});
