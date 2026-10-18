// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { devtools, mountDevtools, type DevtoolsHandle } from "./index";

const URL = "https://devtools.test/graphql";
const TODOS = "query Todos { todos }";

const handles: DevtoolsHandle[] = [];

afterEach(function () {
	for (const handle of handles.splice(0)) handle.dispose();
	document.body.replaceChildren();
});

/**
 * A client answering every query with the given body.
 *
 * @param body - The JSON body
 * @returns The client
 */
function createClient(body: unknown = { data: { todos: ["a"] } }): Client {
	return new Client({
		url: URL,
		cache: new MemoryCache(),
		fetch: async function respond() {
			return Response.json(body);
		} as typeof fetch,
	});
}

/**
 * Waits for the panel's next render (it batches on animation frames).
 */
async function frame(): Promise<void> {
	await new Promise(function wait(resolve) {
		setTimeout(resolve, 40);
	});
}

/**
 * The panel's shadow root.
 *
 * @returns The root
 */
function panel(): ShadowRoot {
	return document.querySelector("[data-lumenql-devtools]")!.shadowRoot!;
}

/**
 * Clicks the first button whose text contains `text`.
 *
 * @param text - Part of the button's text
 */
function click(text: string): void {
	const target = [...panel().querySelectorAll("button")].find(function matches(button) {
		return button.textContent?.includes(text);
	});

	if (!target) throw new Error(`no button "${text}"`);
	target.click();
}

describe("devtools", function () {
	it("mounts a launcher that opens the inspector with the operations timeline", async function () {
		const client = createClient();

		handles.push(mountDevtools(client));
		await client.gql({ query: TODOS });
		await client.gql({ query: TODOS });
		await frame();

		expect(panel().querySelector(".launcher")?.textContent).toContain("2 ops");
		expect(panel().querySelector(".panel")).toBeNull();

		click("lumenql");
		await frame();

		const rows = [...panel().querySelectorAll(".row")];

		expect(rows).toHaveLength(2);
		expect(rows[0]!.textContent).toContain("cache");
		expect(rows[1]!.textContent).toContain("network");
	});

	it("shows an operation's variables, result and errors as text, never as markup", async function () {
		const client = createClient({ errors: [{ message: '<img src=x onerror="window.__pwned=1">' }] });

		handles.push(mountDevtools(client, { open: true }));
		await client.gql({ query: TODOS, variables: { id: "<b>1</b>" } }).catch(function ignore() {});
		await frame();

		panel().querySelector<HTMLButtonElement>(".row")!.click();
		await frame();

		const detail = panel().querySelector(".detail")!;

		expect(detail.querySelector("img")).toBeNull();
		expect(detail.querySelector(".err-box")?.textContent).toContain("<img src=x");
		expect(detail.textContent).toContain('"<b>1</b>"');
		expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
	});

	it("lists cache entries and live queries, and invalidates an entry", async function () {
		const client = createClient();
		const invalidate = vi.spyOn(client, "invalidate");

		handles.push(mountDevtools(client, { open: true }));

		const ref = client.watch({ key: ["todos"], query: TODOS });
		const stop = ref.subscribe(function noop() {});

		await frame();
		click("Live queries");
		await frame();
		expect(panel().querySelector(".row")?.textContent).toContain("todos");

		click("Cache");
		await frame();
		panel().querySelector<HTMLButtonElement>(".row")!.click();
		await frame();
		click("Invalidate entry key");

		expect(invalidate).toHaveBeenCalledWith(["todos"]);
		stop();
	});

	it("logs every event, pauses and clears", async function () {
		const client = createClient();

		handles.push(mountDevtools(client, { open: true }));
		click("Events");
		await client.gql({ query: TODOS });
		await frame();

		expect(panel().querySelectorAll(".log div").length).toBeGreaterThan(0);

		click("Pause");
		await frame();

		const logged = panel().querySelectorAll(".log div").length;

		await client.gql({ query: TODOS, fetchPolicy: "network-only" });
		await frame();
		expect(panel().querySelectorAll(".log div")).toHaveLength(logged);

		click("Clear");
		await frame();
		expect(panel().querySelectorAll(".log div")).toHaveLength(0);
	});

	it("is a plugin: mounted with the client, removed on dispose(), and stops listening", async function () {
		const client = new Client({ url: URL, plugins: [devtools({ position: "bottom-left", theme: "dark" })] });
		const host = document.querySelector<HTMLElement>("[data-lumenql-devtools]")!;

		expect(host.dataset.position).toBe("bottom-left");
		expect(host.dataset.theme).toBe("dark");

		client.dispose();

		expect(document.querySelector("[data-lumenql-devtools]")).toBeNull();
	});

	it("closes on Escape", async function () {
		handles.push(mountDevtools(createClient(), { open: true }));
		await frame();

		panel()
			.querySelector(".panel")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await frame();

		expect(panel().querySelector(".panel")).toBeNull();
	});
});
