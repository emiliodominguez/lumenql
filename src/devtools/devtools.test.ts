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
	localStorage.clear();
	vi.unstubAllEnvs();
});

/**
 * A client answering every request with the given body, counting requests.
 *
 * @param body - The JSON body
 * @returns The client and its fetch mock
 */
function createClient(body: unknown = { data: { todos: ["a"] } }) {
	const fetchMock = vi.fn(async function respond() {
		return Response.json(body);
	});
	const client = new Client({ url: URL, cache: new MemoryCache(), fetch: fetchMock as unknown as typeof fetch });

	return { client, fetchMock };
}

/**
 * Mounts a panel for the test, disposed afterwards.
 *
 * @param client - The client
 * @param options - Panel options
 * @returns The handle
 */
function mount(client: Client, options?: Parameters<typeof mountDevtools>[1]): DevtoolsHandle {
	const handle = mountDevtools(client, options);

	handles.push(handle);

	return handle;
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

/**
 * The texts of the list rows.
 *
 * @returns One string per row
 */
function rows(): string[] {
	return [...panel().querySelectorAll(".row")].map(function text(row) {
		return row.textContent ?? "";
	});
}

describe("devtools", function () {
	it("shows a launcher that opens the operations list, labelled by where each result came from", async function () {
		const { client } = createClient();

		mount(client);
		await client.gql({ query: TODOS });
		await client.gql({ query: TODOS });
		await frame();

		expect(panel().querySelector(".launcher")?.textContent).toContain("2");
		expect(panel().querySelector<HTMLElement>(".panel")!.hidden).toBe(true);

		click("lumenql");
		await frame();

		expect(rows()).toHaveLength(2);
		expect(rows()[0]).toContain("cache");
		expect(rows()[1]).toContain("network");
	});

	it("opens and closes with the keyboard shortcut and Escape, and remembers it", async function () {
		const { client } = createClient();

		mount(client);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "L", ctrlKey: true, shiftKey: true }));
		await frame();
		expect(panel().querySelector<HTMLElement>(".panel")!.hidden).toBe(false);
		expect(JSON.parse(localStorage.getItem("lumenql:devtools")!)).toMatchObject({ open: true });

		panel()
			.querySelector(".panel")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await frame();
		expect(panel().querySelector<HTMLElement>(".panel")!.hidden).toBe(true);
	});

	it("filters, shows an operation's result and runs it again", async function () {
		const { client, fetchMock } = createClient();

		mount(client, { open: true });
		await client.gql({ query: TODOS });
		await client.gql({ query: "query Other { other }" }).catch(function ignore() {});
		await frame();

		const filter = panel().querySelector<HTMLInputElement>(".filter")!;

		filter.value = "todo";
		filter.dispatchEvent(new Event("input"));
		await frame();
		expect(rows()).toHaveLength(1);

		panel().querySelector<HTMLButtonElement>(".row")!.click();
		await frame();
		expect(panel().querySelector(".detail h2")?.textContent).toBe("Todos");
		expect(panel().querySelector(".detail pre")?.textContent).toContain('"todos"');

		click("Run again");
		await frame();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("shows server text as text, never as markup", async function () {
		const { client } = createClient({ errors: [{ message: '<img src=x onerror="window.__pwned=1">' }] });

		mount(client, { open: true });
		await client.gql({ query: TODOS, variables: { id: "<b>1</b>" } }).catch(function ignore() {});
		await frame();
		panel().querySelector<HTMLButtonElement>(".row")!.click();
		await frame();

		const detail = panel().querySelector(".detail")!;

		expect(detail.querySelector("img, b:not(h2 b)")).toBeNull();
		expect(detail.querySelector(".problem")?.textContent).toContain("<img src=x");
		expect(detail.textContent).toContain('"<b>1</b>"');
		expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
	});

	it("lists cache entries, marks the live ones, and invalidates", async function () {
		const { client } = createClient();
		const invalidate = vi.spyOn(client, "invalidate");

		mount(client, { open: true });

		const stop = client.watch({ key: ["todos"], query: TODOS }).subscribe(function noop() {});

		await frame();
		click("Cache");
		await frame();
		expect(rows()[0]).toContain("todos");
		expect(rows()[0]).toContain("live");

		panel().querySelector<HTMLButtonElement>(".row")!.click();
		await frame();
		click("Invalidate");
		expect(invalidate).toHaveBeenCalledWith(["todos"]);
		stop();
	});

	it("logs every event and clears", async function () {
		const { client } = createClient();

		mount(client, { open: true });
		click("Log");
		await client.gql({ query: TODOS });
		await frame();
		expect(panel().querySelectorAll(".log p").length).toBeGreaterThan(0);

		click("Clear");
		await frame();
		expect(panel().querySelectorAll(".log p")).toHaveLength(0);
	});

	it("counts failures on the launcher while closed", async function () {
		const { client } = createClient({ errors: [{ message: "nope" }] });

		mount(client);
		await client.gql({ query: TODOS }).catch(function ignore() {});
		await frame();

		const launcher = panel().querySelector(".launcher")!;

		expect(launcher.classList.contains("bad")).toBe(true);
		expect(launcher.getAttribute("aria-label")).toContain("1 failed");
	});

	it("keeps the launcher's nodes while an operation runs, and holds the activity briefly", async function () {
		let answer!: () => void;
		const fetchMock = vi.fn(function respond() {
			return new Promise<Response>(function later(resolve) {
				answer = function reply() {
					resolve(Response.json({ data: { todos: [] } }));
				};
			});
		});
		const client = new Client({ url: URL, fetch: fetchMock as unknown as typeof fetch });

		mount(client);
		await frame();

		const launcher = panel().querySelector(".launcher")!;
		const nodes = [...launcher.childNodes];
		const request = client.gql({ query: TODOS });

		await frame();
		expect(launcher.classList.contains("busy")).toBe(true);
		expect(launcher.getAttribute("aria-label")).toContain("1 running");
		expect(launcher.querySelector(".tally")?.textContent).toBe("1");

		answer();
		await request;
		await frame();
		// Still showing activity (no flicker for fast operations), with the very same nodes (no layout shift).
		expect(launcher.classList.contains("busy")).toBe(true);
		expect([...launcher.childNodes]).toEqual(nodes);

		await new Promise(function wait(resolve) {
			setTimeout(resolve, 650);
		});
		await frame();
		expect(launcher.classList.contains("busy")).toBe(false);
		expect(launcher.getAttribute("aria-label")).not.toContain("running");
	});

	it("keeps focus on a row while new operations arrive", async function () {
		const { client } = createClient();

		mount(client, { open: true });
		await client.gql({ query: TODOS });
		await frame();

		const first = panel().querySelector<HTMLButtonElement>(".row")!;

		first.focus();
		await client.gql({ query: TODOS, variables: { page: 2 } });
		await frame();

		expect(rows()).toHaveLength(2);
		expect(panel().activeElement).toBe(first);
		expect(panel().querySelectorAll(".row")[1]).toBe(first);
	});

	it("follows a rerun and shows the operation's document", async function () {
		const { client } = createClient();

		mount(client, { open: true });
		await client.gql({ query: TODOS, key: ["todos"] });
		await frame();
		panel().querySelector<HTMLButtonElement>(".row")!.click();
		await frame();
		expect(panel().querySelector(".detail")?.textContent).toContain(TODOS);

		click("Run again");
		await frame();
		await frame();

		const selected = panel().querySelector('.row[aria-selected="true"]');

		expect(rows()).toHaveLength(2);
		expect(selected).toBe(panel().querySelector(".row"));
		expect(panel().querySelector(".detail .line")?.textContent).toContain("network-only");
	});

	it("matches the shortcut by physical key, whatever character the layout produces", async function () {
		const { client } = createClient();

		mount(client, { shortcut: "alt+shift+l" });
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Ò", code: "KeyL", altKey: true, shiftKey: true }));
		await frame();
		expect(panel().querySelector<HTMLElement>(".panel")!.hidden).toBe(false);
	});

	it("copies without the Clipboard API, and says when copying fails", async function () {
		const { client } = createClient();
		const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		const execCommand = vi.fn(function copy() {
			return true;
		});

		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
		Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

		try {
			mount(client, { open: true });
			await client.gql({ query: TODOS });
			await frame();
			panel().querySelector<HTMLButtonElement>(".row")!.click();
			await frame();

			click("Copy result");
			await frame();
			expect(execCommand).toHaveBeenCalledWith("copy");
			expect(panel().querySelector(".detail")?.textContent).toContain("Copied");
			expect(panel().querySelector("textarea")).toBeNull();

			execCommand.mockReturnValue(false);
			click("Copy query");
			await frame();
			expect(panel().querySelector(".detail")?.textContent).toContain("Copy failed");
		} finally {
			if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
			else Reflect.deleteProperty(navigator, "clipboard");
			Reflect.deleteProperty(document, "execCommand");
		}
	});

	it("invalidates an entry through the client that cached it", async function () {
		const { client } = createClient();
		const { client: other } = createClient();
		const invalidate = vi.spyOn(other, "invalidate");
		const handle = mount(client, { open: true });

		handle.attach(other);
		await other.gql({ query: TODOS, key: ["other"] });
		await frame();
		click("Cache");
		await frame();
		panel().querySelector<HTMLButtonElement>(".row")!.click();
		await frame();
		click("Invalidate");

		expect(invalidate).toHaveBeenCalledWith(["other"]);
	});

	it("renders under its own element, so page styles never reach it", function () {
		const { client } = createClient();

		mount(client);

		expect(document.querySelector("[data-lumenql-devtools]")?.localName).toBe("lumenql-devtools");
	});

	it("is a one-line plugin, removed on dispose(), and off in production builds unless forced", async function () {
		const client = new Client({ url: URL, plugins: [devtools({ position: "bottom-left", theme: "dark" })] });
		const host = document.querySelector<HTMLElement>("[data-lumenql-devtools]")!;

		expect(host.dataset.position).toBe("bottom-left");
		expect(host.dataset.theme).toBe("dark");

		client.dispose();
		expect(document.querySelector("[data-lumenql-devtools]")).toBeNull();

		vi.stubEnv("NODE_ENV", "production");
		new Client({ url: URL, plugins: [devtools()] });
		expect(document.querySelector("[data-lumenql-devtools]")).toBeNull();

		new Client({ url: URL, plugins: [devtools({ force: true })] }).dispose();
	});

	it("shares one panel across clients (hot reloads create new ones), removed with the last", function () {
		const first = new Client({ url: URL, plugins: [devtools()] });
		const second = new Client({ url: URL, plugins: [devtools()] });

		expect(document.querySelectorAll("[data-lumenql-devtools]")).toHaveLength(1);

		first.dispose();
		expect(document.querySelectorAll("[data-lumenql-devtools]")).toHaveLength(1);

		second.dispose();
		expect(document.querySelector("[data-lumenql-devtools]")).toBeNull();
	});
});
