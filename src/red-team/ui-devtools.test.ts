// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { devtools, mountDevtools, type DevtoolsHandle } from "../devtools/index";

const URL = "https://devtools.test/graphql";
const TODOS = "query Todos { todos }";
const USER = "query User { user }";
const handles: DevtoolsHandle[] = [];

afterEach(function cleanup() {
	for (const handle of handles.splice(0)) handle.dispose();
	document.body.replaceChildren();
	try {
		localStorage.clear();
	} catch {
		// ignore
	}
	vi.restoreAllMocks();
});

/**
 * Creates a client on a mock server.
 */
function createClient(
	cache = new MemoryCache(),
	plugins: Client["constructor"] extends never ? never : unknown[] = [],
): Client {
	return new Client({
		url: URL,
		cache,
		plugins: plugins as never,
		fetch: async function respond(_url: unknown, init?: RequestInit) {
			const { query } = JSON.parse(String(init?.body)) as { query: string };

			return Response.json(query.includes("User") ? { data: { user: "ada" } } : { data: { todos: ["a"] } });
		} as typeof fetch,
	});
}

/**
 * Waits for the panel's next render.
 */
async function frame(): Promise<void> {
	await new Promise(function wait(resolve) {
		setTimeout(resolve, 40);
	});
}

/**
 * The panel's shadow root.
 */
function root(): ShadowRoot {
	return document.querySelector("[data-lumenql-devtools]")!.shadowRoot!;
}

/**
 * The panel's buttons.
 */
function buttons(): HTMLButtonElement[] {
	return [...root().querySelectorAll("button")] as HTMLButtonElement[];
}

/**
 * Clicks the first visible button containing a text.
 */
function click(text: string): void {
	const target = buttons().find(function matches(button) {
		return button.textContent?.includes(text) && !button.closest("[hidden]");
	});

	if (!target)
		throw new Error(
			`No button "${text}" in: ${buttons()
				.map(function t(b) {
					return b.textContent;
				})
				.join(" | ")}`,
		);
	target.click();
}

describe("devtools", function () {
	it("the devtools() plugin mounts one panel per app, not one more per client.extend()", function () {
		const client = createClient(new MemoryCache(), [devtools()]);

		// e.g. per-user headers, a per-request client, a scoped client in a component
		client.extend({ headers: { authorization: "Bearer a" } });
		client.extend({ headers: { authorization: "Bearer b" } });
		client.extend({ timeout: 1_000 });

		expect(document.querySelectorAll("[data-lumenql-devtools]").length).toBe(1);
		client.dispose();
	});

	it("Invalidate on an entry without a user key does not wipe every other cached entry", async function () {
		const client = createClient();

		await client.gql({ key: ["user"], query: USER });
		await client.gql({ query: TODOS }); // no `key`: its prefix is []
		handles.push(mountDevtools(client, { open: true }));
		await frame();

		click("Cache");
		await frame();

		const rows = [...root().querySelectorAll(".row")] as HTMLElement[];
		const unkeyed = rows.find(function hasNoKey(row) {
			return !row.textContent?.includes("user");
		});

		unkeyed!.click();
		await frame();

		// An entry without a key has no prefix of its own: the panel offers no invalidation that would drop every entry.
		expect(
			buttons().some(function isInvalidate(button) {
				return button.textContent === "Invalidate" && !button.closest("[hidden]");
			}),
		).toBe(false);
		expect(await client.read({ key: ["user"], query: USER })).toEqual({ user: "ada" });
	});

	it("the cache tab does not keep listing entries the cache evicted", async function () {
		const client = createClient(new MemoryCache({ maxSize: 1 }));

		handles.push(mountDevtools(client, { open: true }));
		await client.gql({ key: ["todos"], query: TODOS });
		await client.gql({ key: ["user"], query: USER }); // evicts ["todos"]
		await frame();

		expect(Object.keys(await client.extract())).toHaveLength(1);

		click("Cache");
		await frame();

		expect(root().querySelectorAll(".row").length).toBe(1);
	});

	it("schedules no animation frame after dispose", async function () {
		const client = createClient();

		await client.gql({ key: ["todos"], query: TODOS });

		const raf = vi.spyOn(globalThis, "requestAnimationFrame");
		const handle = mountDevtools(client, { open: true }); // starts loading the cache snapshot

		handle.dispose();

		const before = raf.mock.calls.length;

		await frame();
		expect(raf.mock.calls.length).toBe(before);
	});

	it("Run again refetches the operation's own cache entry (same key), not a new unkeyed one", async function () {
		const client = createClient();
		const states: unknown[] = [];
		const ref = client.watch<{ todos: string[] }>({ key: ["todos"], query: TODOS });
		const stop = ref.subscribe(function record(state) {
			states.push(state.data);
		});

		handles.push(mountDevtools(client, { open: true }));
		await frame();
		await client.gql({ key: ["todos"], query: TODOS, fetchPolicy: "network-only" });
		await frame();

		const keysBefore = Object.keys(await client.extract());
		const row = [...root().querySelectorAll(".row")].find(function isTodos(element) {
			return element.textContent?.includes("Todos");
		}) as HTMLElement;

		row.click();
		await frame();
		click("Run again");
		await frame();

		expect(Object.keys(await client.extract())).toEqual(keysBefore);
		stop();
	});
});
