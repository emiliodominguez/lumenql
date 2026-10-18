import type { Client } from "../core";
import type { CacheKey, ClientEvents, Plugin } from "../types";
import STYLES from "./styles.css?raw";

/**
 * Options for {@link devtools} and {@link mountDevtools}.
 */
export interface DevtoolsOptions {
	/** Open the panel when it mounts. Defaults to how it was left last time (closed at first). */
	open?: boolean | undefined;
	/** Corner the panel docks to. Defaults to `bottom-right`. */
	position?: "bottom-right" | "bottom-left" | undefined;
	/** Color scheme. Defaults to `system`. */
	theme?: "system" | "light" | "dark" | undefined;
	/** Keyboard shortcut toggling the panel, e.g. `"ctrl+shift+l"` (the default). `false` disables it. */
	shortcut?: string | false | undefined;
	/** Maximum operations, cache entries and log lines kept. Defaults to `300`. */
	limit?: number | undefined;
	/** Element the panel mounts into. Defaults to `document.body`. */
	container?: HTMLElement | undefined;
	/**
	 * `devtools()` only: mount in production builds too (`NODE_ENV=production`). Defaults to `false`: the plugin does
	 * nothing there. `mountDevtools()` always mounts (call it conditionally).
	 */
	force?: boolean | undefined;
}

/**
 * Controls a mounted panel.
 */
export interface DevtoolsHandle {
	/** Opens the panel */
	open(): void;
	/** Closes the panel (the launcher stays) */
	close(): void;
	/** Removes the panel and stops listening */
	dispose(): void;
	/**
	 * Also shows another client's operations in this panel (e.g. one derived with `extend()`).
	 *
	 * @param client - The client
	 * @returns Stops showing it
	 */
	attach(client: Client): () => void;
}

/**
 * An operation as the panel tracks it.
 */
interface OperationRecord {
	id: number;
	client: Client;
	type: string;
	name: string;
	query: string;
	stream: boolean;
	fetchPolicy: string;
	key: string;
	variables: unknown;
	startedAt: number;
	endedAt: number | undefined;
	status: "pending" | "ok" | "error";
	source: string;
	data: unknown;
	error: unknown;
	retries: number;
	version: number;
}

/**
 * A cache entry as the panel tracks it.
 */
interface CacheRecord {
	key: string;
	client: Client;
	data: unknown;
	updatedAt: number;
	version: number;
}

/**
 * A line of the event log.
 */
interface LogRecord {
	seq: number;
	at: number;
	type: keyof ClientEvents;
	text: string;
}

/**
 * Panel tabs.
 */
type Tab = "operations" | "cache" | "log";

/**
 * Where the panel remembers whether it was open and which tab was shown.
 */
const STORAGE_KEY = "lumenql:devtools";

/**
 * Characters of JSON shown before truncating (large results would freeze the panel).
 */
const JSON_LIMIT = 40_000;

/**
 * Minimum time the launcher shows activity, in milliseconds: fast operations still register, without flickering.
 */
const BUSY_HOLD = 600;

/**
 * Labels for where a result came from.
 */
const SOURCES: Record<string, string> = { network: "network", cache: "cache", dedupe: "deduped", stream: "stream" };

/**
 * Declared locally: bundlers replace `process.env.NODE_ENV` at build time; elsewhere it may not exist.
 */
declare const process: { env: Record<string, string | undefined> };

/**
 * Whether this is a production build.
 *
 * @returns `true` when `NODE_ENV` is `production`
 */
function isProduction(): boolean {
	try {
		return process.env.NODE_ENV === "production";
	} catch {
		return false;
	}
}

/**
 * Creates an element. Text is always set as text, never parsed as HTML: results come from the server and must not
 * inject markup.
 *
 * @param tag - The tag name
 * @param attributes - Attributes; `undefined` values are skipped
 * @param children - Child nodes or text
 * @returns The element
 */
function h(
	tag: string,
	attributes: Record<string, string | undefined> = {},
	...children: Array<Node | string | undefined>
): HTMLElement {
	const element = document.createElement(tag);

	for (const [name, value] of Object.entries(attributes)) if (value !== undefined) element.setAttribute(name, value);
	for (const child of children) if (child !== undefined) element.append(child);

	return element;
}

/**
 * Creates a button.
 *
 * @param label - The visible label
 * @param className - Its class
 * @param action - What it does
 * @param attributes - More attributes
 * @returns The button
 */
function button(
	label: string,
	className: string,
	action: (event: MouseEvent) => void,
	attributes: Record<string, string | undefined> = {},
): HTMLElement {
	const element = h("button", { type: "button", class: className, ...attributes }, label);

	element.addEventListener("click", action);

	return element;
}

/**
 * Serializes a value as indented JSON, truncated past {@link JSON_LIMIT} characters.
 *
 * @param value - Any value
 * @returns The JSON text
 */
function stringify(value: unknown): string {
	let text: string;

	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}

	return text.length > JSON_LIMIT ? `${text.slice(0, JSON_LIMIT)}\n… ${text.length - JSON_LIMIT} more characters` : text;
}

/**
 * Renders a value as highlighted JSON.
 *
 * @param value - Any value
 * @returns A `pre` element
 */
function json(value: unknown): HTMLElement {
	const text = stringify(value);
	const pre = h("pre");
	const token = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
	let index = 0;

	for (let match = token.exec(text); match; match = token.exec(text)) {
		const kind = match[1] ? (match[2] ? "k" : "s") : match[3] ? "l" : "n";

		pre.append(text.slice(index, match.index), h("span", { class: kind }, match[1] ?? match[0]));
		if (match[2]) pre.append(match[2]);
		index = token.lastIndex;
	}

	pre.append(text.slice(index));

	return pre;
}

/**
 * Formats a duration.
 *
 * @param ms - Milliseconds
 * @returns `42 ms` or `1.3 s`
 */
function duration(ms: number): string {
	return ms < 1_000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/**
 * Formats a clock time.
 *
 * @param at - A timestamp
 * @returns `hh:mm:ss`
 */
function clock(at: number): string {
	return new Date(at).toTimeString().slice(0, 8);
}

/**
 * Describes a serialized cache key: its user key, and its operation and variables.
 *
 * @param key - A serialized cache key
 * @returns A label, a detail line, the user key and the operation name
 */
function describeKey(key: string): {
	label: string;
	detail: string;
	prefix: CacheKey | undefined;
	name: string | undefined;
} {
	try {
		const [prefix, , variables, operationName] = JSON.parse(key) as [CacheKey, string, unknown, string | null];

		return {
			label: prefix.length ? prefix.map(String).join(" / ") : "no key",
			detail: [operationName, variables === null ? "" : JSON.stringify(variables)].filter(Boolean).join(" "),
			prefix,
			name: operationName ?? undefined,
		};
	} catch {
		return { label: key, detail: "", prefix: undefined, name: undefined };
	}
}

/**
 * The message of a thrown value.
 *
 * @param error - Any thrown value
 * @returns Its message
 */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Parses a shortcut like `ctrl+shift+l` into a keyboard event matcher. Letters and digits also match by physical key,
 * so the shortcut works whatever the keyboard layout or the characters `alt` produces (e.g. on macOS).
 *
 * @param shortcut - The shortcut
 * @returns Whether an event matches it
 */
function matcher(shortcut: string): (event: KeyboardEvent) => boolean {
	const parts = shortcut.toLowerCase().split("+");
	const key = parts.pop() ?? "";
	const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : undefined;

	return function matches(event: KeyboardEvent): boolean {
		return (
			(event.key?.toLowerCase() === key || (code !== undefined && event.code === code)) &&
			event.ctrlKey === parts.includes("ctrl") &&
			event.shiftKey === parts.includes("shift") &&
			event.altKey === parts.includes("alt") &&
			event.metaKey === parts.includes("meta")
		);
	};
}

/**
 * Copies text to the clipboard: with the Clipboard API, or (on insecure origins, e.g. a dev server reached by its LAN
 * address) through a selected text area.
 *
 * @param text - The text
 * @param scratch - Where the fallback text area is briefly mounted
 * @returns Resolves once copied
 */
async function writeClipboard(text: string, scratch: ShadowRoot): Promise<void> {
	try {
		return await navigator.clipboard.writeText(text);
	} catch {
		const area = h("textarea", { class: "scratch", readonly: "" }) as HTMLTextAreaElement;

		area.value = text;
		scratch.append(area);
		area.select();

		const copied = document.execCommand("copy");

		area.remove();
		if (!copied) throw new Error("Copy failed");
	}
}

/**
 * Reads what the panel remembered.
 *
 * @returns The remembered state
 */
function recall(): { open?: boolean; tab?: Tab } {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { open?: boolean; tab?: Tab };
	} catch {
		return {};
	}
}

/**
 * Remembers whether the panel is open and which tab it shows.
 *
 * @param state - The state
 */
function remember(state: { open: boolean; tab: Tab }): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Storage unavailable: the panel just starts closed next time.
	}
}

/**
 * Mounts the devtools panel for a client. A small launcher sits in a corner (click it, or press `Ctrl+Shift+L`).
 * The panel lists operations with where each result came from and how long it took, the cache with the live
 * queries watching it, and a log of every event. Click an operation to see its variables, result, error and
 * document, run it again or copy its data. The panel only listens to the client's events, so the client behaves the
 * same with or without it. It renders in a shadow root under a custom element: page styles never leak in, and its
 * styles never leak out. Works with any framework (or none); does nothing outside a browser.
 *
 * @example
 * mountDevtools(client);
 *
 * @param client - The client to inspect
 * @param options - Panel options
 * @returns Controls for the panel
 */
export function mountDevtools(client: Client, options: DevtoolsOptions = {}): DevtoolsHandle {
	if (typeof document === "undefined") {
		return {
			open: noop,
			close: noop,
			dispose: noop,
			attach(): () => void {
				return noop;
			},
		};
	}

	const limit = options.limit ?? 300;
	const remembered = recall();
	// Operations by `<client>:<id>`: ids are per client.
	const operations = new Map<string, OperationRecord>();
	const clients = new Map<Client, number>();
	const detachers = new Set<() => void>();
	const entries = new Map<string, CacheRecord>();
	const watchers = new Map<string, number>();
	const log: LogRecord[] = [];
	const shortcutLabel = options.shortcut === false ? undefined : (options.shortcut ?? "ctrl+shift+l");
	const shortcut = shortcutLabel === undefined ? undefined : matcher(shortcutLabel);
	let isOpen = options.open ?? remembered.open === true;
	let tab: Tab = remembered.tab === "cache" || remembered.tab === "log" ? remembered.tab : "operations";
	let selected: string | undefined;
	let failures = 0;
	let attached = 0;
	let logged = 0;
	let frame: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// When the launcher started showing activity (it shows it for at least `BUSY_HOLD`).
	let busySince: number | undefined;
	// Rows by selection id, rebuilt only when what they show changed (hover, focus and animations survive renders).
	let rows = new Map<string, { element: HTMLElement; signature: string }>();
	let shown = "";
	// The facts line of a running operation's detail, ticking with its duration.
	let ticking: { element: HTMLElement; record: OperationRecord } | undefined;
	// The client whose next operation is selected (after "Run again").
	let follow: Client | undefined;
	let disposed = false;

	const host = h("lumenql-devtools", {
		"data-lumenql-devtools": "",
		"data-position": options.position ?? "bottom-right",
		"data-theme": options.theme === "system" ? undefined : options.theme,
	});
	const root = host.attachShadow({ mode: "open" });
	const filter = h("input", {
		class: "filter",
		type: "search",
		placeholder: "Filter",
		"aria-label": "Filter",
	}) as HTMLInputElement;
	const list = h("div", { class: "list" });
	const detail = h("div", { class: "detail" });
	const body = h("div", { class: "body" }, list, detail);
	const tabs = (["operations", "cache", "log"] as Tab[]).map(function tabButton(name: Tab) {
		const count = h("small");
		const element = h(
			"button",
			{ type: "button", class: "tab", role: "tab" },
			name.charAt(0).toUpperCase() + name.slice(1),
			count,
		);

		element.addEventListener("click", function choose(): void {
			tab = name;
			selected = undefined;
			if (name === "cache") loadCache();
			remember({ open: true, tab });
			update();
		});

		return { name, element, count };
	});
	const panel = h(
		"section",
		{ class: "panel", role: "dialog", "aria-label": "lumenql devtools" },
		h(
			"header",
			{},
			h("span", { class: "word" }, h("b", {}, "lumen"), "ql"),
			h(
				"div",
				{ class: "tabs", role: "tablist" },
				...tabs.map(function element({ element }): HTMLElement {
					return element;
				}),
			),
			filter,
			button("Clear", "ghost", function clear(): void {
				operations.clear();
				log.length = 0;
				failures = 0;
				selected = undefined;
				update();
			}),
			button("×", "ghost close", close, { "aria-label": "Close devtools" }),
		),
		body,
	);
	const pulse = h("span", { class: "dot" });
	const tally = h("span", { class: "tally" });
	const launcher = h(
		"button",
		{ type: "button", class: "launcher", title: shortcutLabel ? `lumenql devtools (${shortcutLabel})` : undefined },
		pulse,
		h("span", { class: "word" }, h("b", {}, "lumen"), "ql"),
		tally,
	);

	launcher.addEventListener("click", function toggle(): void {
		if (isOpen) close();
		else open();
	});
	filter.addEventListener("input", update);
	// A constructed style sheet works under a strict CSP (no inline styles); older browsers get a <style> element.
	if ("adoptedStyleSheets" in root && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
		const sheet = new CSSStyleSheet();

		sheet.replaceSync(STYLES);
		root.adoptedStyleSheets = [sheet];
	} else {
		root.append(h("style", {}, STYLES));
	}

	root.append(panel, launcher);
	(options.container ?? document.body).append(host);

	/**
	 * Schedules a render on the next frame: events arrive in bursts.
	 */
	function update(): void {
		if (frame === undefined && !disposed) frame = requestAnimationFrame(render);
	}

	/**
	 * Opens the panel.
	 */
	function open(): void {
		if (disposed) return;

		isOpen = true;
		failures = 0;
		loadCache();
		remember({ open: true, tab });
		update();
	}

	/**
	 * Closes the panel. Focus inside it moves to the launcher, never to the page's start.
	 */
	function close(): void {
		if (disposed) return;

		if (panel.contains(root.activeElement)) launcher.focus();
		isOpen = false;
		remember({ open: false, tab });
		update();
	}

	/**
	 * Adds a log line.
	 *
	 * @param type - The event type
	 * @param text - What happened
	 */
	function write(type: keyof ClientEvents, text: string): void {
		log.push({ seq: ++logged, at: Date.now(), type, text });
		if (log.length > limit) log.shift();
		update();
	}

	/**
	 * Updates a tracked operation.
	 *
	 * @param id - The operation's `<client>:<id>`
	 * @param change - Applies the change
	 */
	function touch(id: string, change: (record: OperationRecord) => void): void {
		const record = operations.get(id);

		if (!record) return;

		change(record);
		record.version++;
	}

	/**
	 * Keeps a map bounded, dropping its oldest items.
	 *
	 * @param map - Items in insertion order
	 */
	function trim<K, V>(map: Map<K, V>): void {
		while (map.size > limit) map.delete(map.keys().next().value as K);
	}

	/**
	 * Syncs the cache list with what the caches hold: entries written before the panel mounted appear, entries a
	 * cache evicted or expired disappear.
	 */
	function loadCache(): void {
		const sources = [...clients.keys()];

		Promise.all(
			sources.map(function snapshot(source: Client): Promise<Record<string, unknown>> {
				return source.extract().catch(function unreadable(): Record<string, unknown> {
					return {};
				});
			}),
		).then(function fill(snapshots: Array<Record<string, unknown>>): void {
			if (disposed) return;

			const held = new Map<string, { data: unknown; client: Client }>();

			snapshots.forEach(function collect(snapshot: Record<string, unknown>, index: number): void {
				for (const [key, data] of Object.entries(snapshot)) held.set(key, { data, client: sources[index]! });
			});

			for (const key of [...entries.keys()]) if (!held.has(key)) entries.delete(key);

			for (const [key, { data, client: source }] of held) {
				if (!entries.has(key)) entries.set(key, { key, client: source, data, updatedAt: Date.now(), version: 0 });
			}

			trim(entries);
			update();
		}, noop);
	}

	/**
	 * Shows a client's events in the panel.
	 *
	 * @param source - The client
	 * @returns Stops showing it
	 */
	function attach(source: Client): () => void {
		const existing = clients.get(source);

		if (existing !== undefined || disposed) return noop;

		const n = ++attached;

		/**
		 * The panel-wide id of one of this client's operations.
		 *
		 * @param id - The client's operation id
		 * @returns `<client>:<id>`
		 */
		function op(id: number | undefined): string {
			return `${n}:${id}`;
		}

		clients.set(source, n);

		const stops = [
			source.on("operation", function started({ id, context, fetchPolicy, key }): void {
				operations.set(op(id), {
					id,
					client: source,
					type: context.type,
					name: context.name ?? "anonymous",
					query: context.query,
					stream: context.stream === true,
					fetchPolicy,
					key,
					variables: context.variables,
					startedAt: Date.now(),
					endedAt: undefined,
					status: "pending",
					source: context.stream ? "stream" : "network",
					data: undefined,
					error: undefined,
					retries: 0,
					version: 0,
				});
				trim(operations);

				if (follow === source) {
					follow = undefined;
					selected = `op:${op(id)}`;
				}

				write("operation", `${context.type} ${context.name ?? "anonymous"}`);
			}),
			source.on("result", function resulted({ id, source: from, data }): void {
				touch(op(id), function settle(record: OperationRecord): void {
					record.data = data;
					record.source = from;

					if (from !== "stream") {
						record.status = "ok";
						record.endedAt = Date.now();
					}
				});
				write("result", `#${id} ${SOURCES[from] ?? from}`);
			}),
			source.on("error", function failed({ id, error }): void {
				touch(op(id), function fail(record: OperationRecord): void {
					record.status = "error";
					record.error = error;
					record.endedAt = Date.now();
				});
				if (!isOpen) failures++;
				write("error", `#${id} ${message(error)}`);
			}),
			source.on("done", function ended({ id }): void {
				touch(op(id), function finish(record: OperationRecord): void {
					record.status = "ok";
					record.endedAt = Date.now();
				});
				write("done", `#${id} stream ended`);
			}),
			source.on("retry", function retried({ context, delay, attempts }): void {
				touch(op(context.id), function count(record: OperationRecord): void {
					record.retries = context.attempt + 1;
				});
				write("retry", `#${context.id} attempt ${context.attempt + 2}/${attempts + 1} in ${duration(delay)}`);
			}),
			source.on("cache", function cached({ key, data }): void {
				const version = (entries.get(key)?.version ?? 0) + 1;

				// Re-inserted: the most recently written entries come first.
				entries.delete(key);
				entries.set(key, { key, client: source, data, updatedAt: Date.now(), version });
				trim(entries);
				write("cache", describeKey(key).label);
			}),
			source.on("invalidate", function invalidated({ prefix, removed }): void {
				for (const key of [...entries.keys()]) {
					const { prefix: entryPrefix } = describeKey(key);

					if (
						entryPrefix &&
						prefix.every(function same(segment: unknown, index: number): boolean {
							return entryPrefix[index] === segment;
						})
					) {
						entries.delete(key);
					}
				}

				write("invalidate", `${prefix.length ? prefix.map(String).join(" / ") : "everything"} · ${removed} removed`);
			}),
			source.on("optimistic", function layered({ key, phase }): void {
				write("optimistic", `${describeKey(key).label} · ${phase}`);
			}),
			source.on("watch", function watched({ key, watchers: count }): void {
				if (count > 0) watchers.set(key, count);
				else watchers.delete(key);

				write("watch", `${describeKey(key).label} · ${count} watching`);
			}),
		];

		/**
		 * Stops showing this client.
		 */
		function detach(): void {
			for (const stop of stops.splice(0)) stop();
			if (clients.get(source) === n) clients.delete(source);
			detachers.delete(detach);
		}

		detachers.add(detach);

		return detach;
	}

	attach(client);

	/**
	 * Whether any of the texts contains the filter.
	 *
	 * @param texts - The searchable texts
	 * @returns `true` when there is no filter or a text contains it
	 */
	function matches(...texts: string[]): boolean {
		const needle = filter.value.trim().toLowerCase();

		return (
			!needle ||
			texts.some(function contains(text: string): boolean {
				return text.toLowerCase().includes(needle);
			})
		);
	}

	/**
	 * Returns the row of an item: the one already shown when what it shows is unchanged, else a new one.
	 *
	 * @param id - The item's selection id
	 * @param signature - What the row shows (its version, whether it is selected...)
	 * @param next - The rows of this render
	 * @param build - Builds the row's content
	 * @returns The row
	 */
	function keyed(
		id: string,
		signature: string,
		next: Map<string, { element: HTMLElement; signature: string }>,
		build: () => Node[],
	): HTMLElement {
		const current = rows.get(id);
		let element = current?.signature === signature ? current.element : undefined;

		if (!element) {
			element = h("button", { type: "button", class: "row", "aria-selected": String(selected === id) }, ...build());
			element.addEventListener("click", function select(): void {
				selected = selected === id ? undefined : id;
				update();
			});
		}

		next.set(id, { element, signature });

		return element;
	}

	/**
	 * Shows rows in the list, moving only what changed (focus, hover and scroll survive), or an empty state.
	 *
	 * @param nodes - The rows, in order
	 * @param next - The rows of this render
	 * @param placeholder - Shown when there are no rows
	 */
	function fill(
		nodes: HTMLElement[],
		next: Map<string, { element: HTMLElement; signature: string }>,
		placeholder: () => HTMLElement,
	): void {
		const focused = root.activeElement;

		if (!nodes.length) nodes = [placeholder()];

		nodes.forEach(function place(node: HTMLElement, index: number): void {
			const at = list.children[index];

			if (at !== node) list.insertBefore(node, at ?? null);
		});

		while (list.children.length > nodes.length) list.lastElementChild!.remove();

		// A focused row rebuilt for new content hands its focus to its replacement.
		for (const [id, { element }] of rows) {
			if (element === focused && !element.isConnected) next.get(id)?.element.focus();
		}

		rows = next;
	}

	/**
	 * Creates an empty state.
	 *
	 * @param title - What is missing
	 * @param hint - How it appears
	 * @returns The element
	 */
	function empty(title: string, hint: string): HTMLElement {
		return h("div", { class: "empty" }, h("b", {}, title), h("span", {}, hint));
	}

	/**
	 * Creates a button copying a value as JSON.
	 *
	 * @param label - The label
	 * @param value - The value
	 * @returns The button
	 */
	function copy(label: string, value: unknown): HTMLElement {
		return button(label, "action", function copyValue(event: MouseEvent): void {
			const target = event.currentTarget as HTMLElement;

			/**
			 * Shows how the copy went, then the label again.
			 *
			 * @param outcome - The text to show
			 */
			function report(outcome: string): void {
				target.textContent = outcome;
				setTimeout(function restore(): void {
					target.textContent = label;
				}, 1_200);
			}

			writeClipboard(stringify(value), root).then(
				function copied(): void {
					report("Copied");
				},
				function failed(): void {
					report("Copy failed");
				},
			);
		});
	}

	/**
	 * The running time of an operation.
	 *
	 * @param record - The operation
	 * @param now - The current time
	 * @returns The duration
	 */
	function elapsed(record: OperationRecord, now: number): string {
		return duration((record.endedAt ?? now) - record.startedAt);
	}

	/**
	 * Fills the list with the operations, newest first.
	 *
	 * @param now - The current time
	 */
	function listOperations(now: number): void {
		const next = new Map<string, { element: HTMLElement; signature: string }>();
		const nodes: HTMLElement[] = [];

		for (const [id, record] of [...operations].reverse()) {
			const where = describeKey(record.key).label;
			const key = `op:${id}`;

			if (!matches(record.name, record.type, where)) continue;

			const element = keyed(key, `${record.version}:${selected === key}`, next, function build(): Node[] {
				return [
					h("span", { class: `dot ${record.status}` }),
					h("span", { class: "what" }, h("b", {}, record.name), h("span", {}, `${record.type} · ${where}`)),
					h(
						"span",
						{ class: "meta" },
						h("span", { class: `tag ${record.status}` }, status(record)),
						h("span", { class: "ms" }, elapsed(record, now)),
					),
				];
			});

			// A running operation's duration ticks without rebuilding its row.
			if (record.status === "pending") element.querySelector(".ms")!.textContent = elapsed(record, now);
			nodes.push(element);
		}

		fill(nodes, next, function placeholder(): HTMLElement {
			return operations.size
				? empty("No match", "Nothing matches the filter.")
				: empty("No operations yet", "Queries, mutations and subscriptions show up here as they run.");
		});
	}

	/**
	 * The facts line of an operation: type, status, duration, retries, fetch policy and start time.
	 *
	 * @param record - The operation
	 * @param now - The current time
	 * @returns The line
	 */
	function facts(record: OperationRecord, now: number): string {
		const retries = record.retries ? `${record.retries} ${record.retries === 1 ? "retry" : "retries"}` : "";

		return [record.type, status(record), elapsed(record, now), retries, record.fetchPolicy, clock(record.startedAt)]
			.filter(Boolean)
			.join(" · ");
	}

	/**
	 * Shows an operation.
	 *
	 * @param record - The operation
	 * @param now - The current time
	 */
	function showOperation(record: OperationRecord, now: number): void {
		const actions = h("div", { class: "actions" });
		const line = h("p", { class: "line" }, facts(record, now));
		const { prefix, name } = describeKey(record.key);

		if (record.type === "query" && !record.stream && prefix) {
			actions.append(
				button("Run again", "action", function rerun(): void {
					// The same entry (key, variables, operation), refreshed from the network; the panel follows the new run.
					follow = record.client;

					try {
						record.client
							.gql({
								query: record.query,
								variables: record.variables as object,
								key: prefix,
								operationName: name,
								fetchPolicy: "network-only",
							})
							.catch(noop);
					} finally {
						follow = undefined;
					}
				}),
			);
		}

		if (record.data !== undefined) actions.append(copy("Copy result", record.data));
		if (record.variables !== undefined) actions.append(copy("Copy variables", record.variables));
		actions.append(copy("Copy query", record.query));

		ticking = record.status === "pending" ? { element: line, record } : undefined;
		detail.replaceChildren(
			button("‹ Back", "ghost back", deselect),
			h("h2", {}, record.name),
			line,
			actions,
			...(record.error === undefined
				? []
				: [h("h3", {}, "Error"), h("div", { class: "problem" }, message(record.error))]),
			...(record.data === undefined
				? []
				: [h("h3", {}, record.stream ? "Latest result" : "Result"), json(record.data)]),
			...(record.variables === undefined ? [] : [h("h3", {}, "Variables"), json(record.variables)]),
			h("h3", {}, "Query"),
			h("pre", { class: "doc" }, record.query),
		);
	}

	/**
	 * Fills the list with the cache entries, the most recently written first; live ones are marked.
	 */
	function listCache(): void {
		const next = new Map<string, { element: HTMLElement; signature: string }>();
		const nodes: HTMLElement[] = [];

		for (const record of [...entries.values()].reverse()) {
			const { label, detail: info } = describeKey(record.key);
			const live = watchers.get(record.key) ?? 0;
			const key = `entry:${record.key}`;

			if (!matches(label, info)) continue;

			nodes.push(
				keyed(key, `${record.version}:${live}:${selected === key}`, next, function build(): Node[] {
					return [
						h("span", { class: `dot ${live ? "live" : ""}` }),
						h("span", { class: "what" }, h("b", {}, label), h("span", {}, info || "no variables")),
						h(
							"span",
							{ class: "meta" },
							h("span", {}, live ? "live" : ""),
							h("span", { class: "ms" }, clock(record.updatedAt)),
						),
					];
				}),
			);
		}

		fill(nodes, next, function placeholder(): HTMLElement {
			return entries.size
				? empty("No match", "Nothing matches the filter.")
				: empty("Nothing cached", "Results appear here when they land in the cache.");
		});
	}

	/**
	 * Shows a cache entry.
	 *
	 * @param record - The entry
	 */
	function showEntry(record: CacheRecord): void {
		const { label, detail: info, prefix } = describeKey(record.key);
		const live = watchers.get(record.key) ?? 0;
		const actions = h("div", { class: "actions" });
		const watching = live ? `${live} live ${live === 1 ? "query" : "queries"}` : "not watched";

		ticking = undefined;

		// An entry without a key has no prefix of its own: invalidating `[]` would drop every result.
		if (prefix?.length) {
			actions.append(
				button("Invalidate", "action", function invalidate(): void {
					record.client.invalidate(prefix).catch(noop);
				}),
			);
		}

		actions.append(copy("Copy data", record.data));
		detail.replaceChildren(
			button("‹ Back", "ghost back", deselect),
			h("h2", {}, label),
			h("p", { class: "line" }, [info, watching, `updated ${clock(record.updatedAt)}`].filter(Boolean).join(" · ")),
			actions,
			h("h3", {}, "Data"),
			json(record.data),
		);
	}

	/**
	 * Fills the list with the event log, newest first.
	 */
	function listLog(): void {
		const lines: HTMLElement[] = [];
		const next = new Map<string, { element: HTMLElement; signature: string }>();

		for (const line of [...log].reverse()) {
			if (!matches(line.type, line.text)) continue;

			const id = `log:${line.seq}`;
			const element =
				rows.get(id)?.element ??
				h("p", {}, h("time", {}, clock(line.at)), h("i", {}, line.type), h("span", {}, line.text));

			next.set(id, { element, signature: "" });
			lines.push(element);
		}

		fill(lines, next, function placeholder(): HTMLElement {
			return empty("Quiet so far", "Every client event is logged here.");
		});
	}

	/**
	 * Clears the selection.
	 */
	function deselect(): void {
		selected = undefined;
		update();
	}

	/**
	 * Renders the launcher, the tabs, the list and (when it changed) the detail. Only what changed is touched.
	 */
	function render(): void {
		const now = Date.now();
		let pending = 0;

		frame = undefined;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;

		for (const record of operations.values()) if (record.status === "pending") pending++;

		// Activity shows for at least `BUSY_HOLD`: a fast operation registers instead of flickering the launcher.
		if (pending) busySince ??= now;

		const hold = busySince === undefined ? 0 : busySince + BUSY_HOLD - now;
		const busy = pending > 0 || hold > 0;

		if (!busy) busySince = undefined;

		launcher.className = `launcher${busy ? " busy" : failures ? " bad" : ""}`;
		tally.textContent = String(operations.size);
		launcher.setAttribute("aria-expanded", String(isOpen));
		launcher.setAttribute(
			"aria-label",
			[
				`${isOpen ? "Close" : "Open"} lumenql devtools`,
				`${operations.size} operations`,
				pending ? `${pending} running` : "",
				failures ? `${failures} failed` : "",
			]
				.filter(Boolean)
				.join(", "),
		);
		panel.hidden = !isOpen;

		// Running durations tick while the panel is open; the launcher settles once its hold ends.
		if (pending && isOpen) timer = setTimeout(update, 250);
		else if (busy) timer = setTimeout(update, hold);

		if (!isOpen) return;

		const counts: Record<Tab, number | undefined> = { operations: operations.size, cache: entries.size, log: undefined };

		for (const { name, element, count } of tabs) {
			element.setAttribute("aria-selected", String(tab === name));
			count.textContent = counts[name] === undefined ? "" : String(counts[name]);
		}

		const record = tab === "operations" && selected?.startsWith("op:") ? operations.get(selected.slice(3)) : undefined;
		const entry = tab === "cache" && selected?.startsWith("entry:") ? entries.get(selected.slice(6)) : undefined;

		list.classList.toggle("log", tab === "log");

		if (tab === "operations") listOperations(now);
		else if (tab === "cache") listCache();
		else listLog();

		body.classList.toggle("split", record !== undefined || entry !== undefined);
		detail.hidden = record === undefined && entry === undefined;

		// The detail is rebuilt only when what it shows changed: selecting text or scrolling in it survives bursts.
		const showing = record
			? `${selected}:${record.version}`
			: entry
				? `${selected}:${entry.version}:${watchers.get(entry.key) ?? 0}`
				: "";

		if (showing !== shown) {
			shown = showing;

			if (record) showOperation(record, now);
			else if (entry) showEntry(entry);
			else {
				ticking = undefined;
				detail.replaceChildren();
			}
		} else if (ticking?.record.status === "pending") {
			ticking.element.textContent = facts(ticking.record, now);
		}
	}

	/**
	 * Toggles the panel with the shortcut.
	 *
	 * @param event - The keyboard event
	 */
	function onKey(event: KeyboardEvent): void {
		if (!shortcut?.(event)) return;

		event.preventDefault();
		if (isOpen) close();
		else open();
	}

	root.addEventListener("keydown", function closeOnEscape(event: Event): void {
		if ((event as KeyboardEvent).key === "Escape" && isOpen) close();
	});
	window.addEventListener("keydown", onKey);

	if (isOpen) loadCache();
	render();

	return {
		open,
		close,
		attach,
		dispose(): void {
			disposed = true;
			for (const detach of [...detachers]) detach();
			window.removeEventListener("keydown", onKey);
			if (frame !== undefined) cancelAnimationFrame(frame);
			if (timer !== undefined) clearTimeout(timer);
			frame = undefined;
			timer = undefined;
			host.remove();
		},
	};
}

/**
 * A short label for an operation's state: where its result came from, or that it is running or failed.
 *
 * @param record - The operation
 * @returns The label
 */
function status(record: OperationRecord): string {
	if (record.status === "error") return "failed";
	if (record.status === "pending") return record.stream ? "streaming" : "pending";

	return SOURCES[record.source] ?? record.source;
}

/**
 * The panel the `devtools()` plugins share: one per page, even when the app creates new clients (hot module
 * reloading, `extend()`, one client per route). Each client joins it, and it is removed with the last one.
 */
let shared: { handle: DevtoolsHandle; users: number } | undefined;

/**
 * The devtools as a plugin: one line, mounted with the client and removed by `client.dispose()`. Every client using
 * it shows in the same panel (the first one's options apply). In production builds (`NODE_ENV=production`) it does
 * nothing unless `force` is set; import it conditionally to also leave its code out of the bundle.
 *
 * @example
 * const client = new Client({ url, plugins: [devtools()] });
 *
 * @param options - Panel options
 * @returns The plugin
 */
export function devtools(options: DevtoolsOptions = {}): Plugin {
	return {
		name: "devtools",
		setup(client: Client): (() => void) | undefined {
			if (isProduction() && !options.force) return undefined;

			const panel = shared ?? { handle: mountDevtools(client, options), users: 0 };
			const detach = panel.handle.attach(client);

			shared = panel;
			panel.users++;

			return function teardown(): void {
				detach();

				if (--panel.users === 0) {
					panel.handle.dispose();
					if (shared === panel) shared = undefined;
				}
			};
		},
	};
}

/**
 * Does nothing.
 */
function noop(): void {}
