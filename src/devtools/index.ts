import type { Client } from "../core";
import type { CacheKey, ClientEvents, Plugin } from "../types";

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
	/** Mount in production builds too (`NODE_ENV=production`). Defaults to `false`: the plugin does nothing there. */
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
	data: unknown;
	updatedAt: number;
	version: number;
}

/**
 * A line of the event log.
 */
interface LogRecord {
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
 * Labels for where a result came from.
 */
const SOURCES: Record<string, string> = { network: "network", cache: "cache", dedupe: "deduped", stream: "stream" };

/**
 * The panel's styles. Colors are tokens on `:host`, redefined for dark schemes.
 */
const STYLES = `
/* A quiet launcher in a corner; the panel opens above it: a header (tabs, filter), a list, and a detail column. */
:host {
	--paper: #fbf9f5; --raised: #ffffff; --hover: #f3efe7; --line: #e9e3d8; --ink: #1d1a15; --soft: #77705f;
	--amber: #c47a0c; --amber-wash: #f8ecd6; --ok: #2f8a5b; --bad: #c6402d; --bad-wash: #fbe7e2;
	--sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	--mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
	all: initial; position: fixed; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
	bottom: calc(14px + env(safe-area-inset-bottom, 0px)); right: calc(14px + env(safe-area-inset-right, 0px));
	font: 12.5px/1.5 var(--sans); color: var(--ink); color-scheme: light; -webkit-font-smoothing: antialiased;
}
:host([data-position="bottom-left"]) { right: auto; left: calc(14px + env(safe-area-inset-left, 0px)); align-items: flex-start; }
:host([data-theme="dark"]) {
	--paper: #16140f; --raised: #1d1a15; --hover: #24211b; --line: #2f2b24; --ink: #efe9df; --soft: #9b9385;
	--amber: #f1b44a; --amber-wash: #33270f; --ok: #5fc792; --bad: #ff7b67; --bad-wash: #3a1d17; color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
	:host(:not([data-theme="light"])) {
		--paper: #16140f; --raised: #1d1a15; --hover: #24211b; --line: #2f2b24; --ink: #efe9df; --soft: #9b9385;
		--amber: #f1b44a; --amber-wash: #33270f; --ok: #5fc792; --bad: #ff7b67; --bad-wash: #3a1d17; color-scheme: dark;
	}
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--line); }
.dot.ok { background: var(--ok); } .dot.error { background: var(--bad); } .dot.pending { background: var(--amber); }
.dot.live { background: var(--amber); box-shadow: 0 0 0 3px var(--amber-wash); }
.launcher {
	display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px 0 11px;
	background: var(--raised); border: 1px solid var(--line); border-radius: 999px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.1);
}
.launcher:hover { border-color: var(--amber); }
.word { font: 600 12px/1 var(--sans); letter-spacing: -0.01em; }
.word b { font-weight: 600; color: var(--amber); }
.tally { font: 11px/1 var(--mono); color: var(--soft); font-variant-numeric: tabular-nums; }
.tally.bad { color: var(--bad); }
.panel {
	display: grid; grid-template-rows: auto minmax(0, 1fr); width: min(720px, calc(100vw - 28px)); height: min(430px, calc(100vh - 100px));
	background: var(--paper); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; box-shadow: 0 18px 50px rgb(0 0 0 / 0.16);
}
header { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); min-width: 0; }
.tabs { display: flex; gap: 2px; padding: 2px; background: var(--hover); border-radius: 8px; }
.tab { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: var(--soft); white-space: nowrap; }
.tab[aria-selected="true"] { background: var(--raised); color: var(--ink); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }
.tab small { font: 10.5px var(--mono); color: var(--soft); font-variant-numeric: tabular-nums; }
.filter { flex: 1; min-width: 60px; height: 28px; padding: 0 10px; border: 1px solid transparent; border-radius: 8px; background: none; outline: none; }
.filter::placeholder { color: var(--soft); }
.filter:focus { border-color: var(--line); background: var(--raised); }
.ghost { height: 28px; padding: 0 10px; border: 0; border-radius: 8px; background: none; color: var(--soft); }
.ghost:hover { background: var(--hover); color: var(--ink); }
.close { width: 28px; padding: 0; font-size: 16px; line-height: 1; }
.body { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
.body.split { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); }
.list { overflow: auto; padding: 6px; }
.body.split .list { border-right: 1px solid var(--line); }
.row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 6px 10px; border: 0; border-radius: 8px; background: none; text-align: left; }
.row:hover { background: var(--hover); }
.row[aria-selected="true"] { background: var(--amber-wash); }
.what { flex: 1; min-width: 0; }
.what b, .what span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.what b { font-weight: 550; }
.what span { font-size: 11px; color: var(--soft); }
.meta { flex: none; display: flex; align-items: baseline; gap: 10px; font: 11px var(--mono); color: var(--soft); font-variant-numeric: tabular-nums; }
.meta .tag.error { color: var(--bad); } .meta .tag.pending { color: var(--amber); }
.ms { min-width: 46px; text-align: right; }
.detail { overflow: auto; padding: 16px 18px 20px; background: var(--raised); }
.back { display: none; margin: -6px 0 8px -8px; }
h2 { margin: 0; font: 600 15px/1.3 var(--sans); letter-spacing: -0.01em; overflow-wrap: anywhere; }
.line { margin: 4px 0 0; font: 11px var(--mono); color: var(--soft); overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.action { height: 28px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--raised); }
.action:hover { border-color: var(--amber); }
h3 { margin: 18px 0 6px; font: 600 10.5px var(--sans); letter-spacing: 0.08em; text-transform: uppercase; color: var(--soft); }
pre { margin: 0; padding: 10px 12px; max-height: 280px; overflow: auto; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; font: 11.5px/1.55 var(--mono); white-space: pre; tab-size: 2; }
.k { color: var(--ink); } .s { color: var(--ok); } .n { color: var(--amber); } .l { color: var(--soft); }
.problem { padding: 10px 12px; background: var(--bad-wash); color: var(--bad); border-radius: 8px; overflow-wrap: anywhere; }
.empty { display: grid; place-content: center; gap: 4px; height: 100%; min-height: 120px; padding: 24px; text-align: center; color: var(--soft); }
.empty b { color: var(--ink); font-weight: 550; }
.log { padding: 6px 4px; font: 11px/1.5 var(--mono); }
.log p { display: grid; grid-template-columns: 64px 76px minmax(0, 1fr); gap: 10px; margin: 0; padding: 3px 10px; border-radius: 6px; }
.log p:hover { background: var(--hover); }
.log time { color: var(--soft); font-variant-numeric: tabular-nums; }
.log i { font-style: normal; color: var(--amber); }
.log span { overflow-wrap: anywhere; }
@media (max-width: 600px) {
	.panel { height: min(520px, calc(100vh - 90px)); }
	header { flex-wrap: wrap; row-gap: 8px; }
	header .word { display: none; }
	.tabs { flex: 1; }
	.filter { order: 3; flex-basis: 100%; border-color: var(--line); }
	.body.split { grid-template-columns: minmax(0, 1fr); }
	.body.split .list { display: none; }
	.back { display: inline-flex; align-items: center; }
	.log p { grid-template-columns: 76px minmax(0, 1fr); }
	.log time { display: none; }
}
@media (prefers-reduced-motion: no-preference) {
	.dot.pending { animation: glow 1.1s ease-in-out infinite; }
	.panel { animation: rise 160ms ease-out; }
	@keyframes glow { 50% { opacity: 0.35; } }
	@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
}
`;

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
 * @returns A label, a detail line and the user key
 */
function describeKey(key: string): { label: string; detail: string; prefix: CacheKey | undefined } {
	try {
		const [prefix, , variables, operationName] = JSON.parse(key) as [CacheKey, string, unknown, string | null];

		return {
			label: prefix.length ? prefix.map(String).join(" / ") : "no key",
			detail: [operationName, variables === null ? "" : JSON.stringify(variables)].filter(Boolean).join(" "),
			prefix,
		};
	} catch {
		return { label: key, detail: "", prefix: undefined };
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
 * Parses a shortcut like `ctrl+shift+l` into a keyboard event matcher.
 *
 * @param shortcut - The shortcut
 * @returns Whether an event matches it
 */
function matcher(shortcut: string): (event: KeyboardEvent) => boolean {
	const parts = shortcut.toLowerCase().split("+");
	const key = parts.pop();

	return function matches(event: KeyboardEvent): boolean {
		return (
			event.key?.toLowerCase() === key &&
			event.ctrlKey === parts.includes("ctrl") &&
			event.shiftKey === parts.includes("shift") &&
			event.altKey === parts.includes("alt") &&
			event.metaKey === parts.includes("meta")
		);
	};
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
 * queries watching it, and a log of every event. Click an operation to see its variables, result or error, run it
 * again or copy its data. The panel only listens to the client's events, so the client behaves the same with or
 * without it. Does nothing outside a browser.
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
	let frame: number | undefined;
	let shown = "";
	let disposed = false;

	const host = h("div", {
		"data-lumenql-devtools": "",
		"data-position": options.position ?? "bottom-right",
		"data-theme": options.theme === "system" ? undefined : options.theme,
	});
	const root = host.attachShadow({ mode: "open" });
	const tabs = h("div", { class: "tabs", role: "tablist" });
	const filter = h("input", { class: "filter", type: "search", placeholder: "Filter", "aria-label": "Filter" });
	const list = h("div", { class: "list" });
	const detail = h("div", { class: "detail" });
	const body = h("div", { class: "body" }, list, detail);
	const panel = h(
		"section",
		{ class: "panel", role: "dialog", "aria-label": "lumenql devtools" },
		h(
			"header",
			{},
			h("span", { class: "word" }, h("b", {}, "lumen"), "ql"),
			tabs,
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
	const launcher = h("button", { type: "button", class: "launcher" });

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
	 * Closes the panel.
	 */
	function close(): void {
		if (disposed) return;

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
		log.push({ at: Date.now(), type, text });
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
	 * Syncs the cache list with what the cache holds: entries written before the panel mounted appear, entries the
	 * cache evicted or expired disappear.
	 */
	function loadCache(): void {
		client.extract().then(function fill(snapshot: Record<string, unknown>): void {
			if (disposed) return;

			for (const key of [...entries.keys()]) if (!Object.hasOwn(snapshot, key)) entries.delete(key);

			for (const [key, data] of Object.entries(snapshot)) {
				if (!entries.has(key)) entries.set(key, { key, data, updatedAt: Date.now(), version: 0 });
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
		const n = clients.get(source) ?? clients.size + 1;

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
				write("operation", `${context.type} ${context.name ?? "anonymous"}`);
			}),
			source.on("result", function resulted({ id, source, data }): void {
				touch(op(id), function settle(record: OperationRecord): void {
					record.data = data;
					record.source = source;

					if (source !== "stream") {
						record.status = "ok";
						record.endedAt = Date.now();
					}
				});
				write("result", `#${id} ${SOURCES[source] ?? source}`);
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
				entries.set(key, { key, data, updatedAt: Date.now(), version });
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
			for (const stop of stops) stop();
			clients.delete(source);
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
		const needle = (filter as HTMLInputElement).value.trim().toLowerCase();

		return (
			!needle ||
			texts.some(function contains(text: string): boolean {
				return text.toLowerCase().includes(needle);
			})
		);
	}

	/**
	 * Creates a list row selecting an item (clicking a selected row closes its detail).
	 *
	 * @param id - The item's selection id
	 * @param children - The row's content
	 * @returns The row
	 */
	function row(id: string, ...children: Node[]): HTMLElement {
		const element = h("button", { type: "button", class: "row", "aria-selected": String(selected === id) }, ...children);

		element.addEventListener("click", function select(): void {
			selected = selected === id ? undefined : id;
			update();
		});

		return element;
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

			navigator.clipboard?.writeText(stringify(value)).then(function copied(): void {
				target.textContent = "Copied";
				setTimeout(function restore(): void {
					target.textContent = label;
				}, 1_200);
			}, noop);
		});
	}

	/**
	 * Fills the list with the operations, newest first.
	 */
	function listOperations(): void {
		const now = Date.now();
		const rows: Node[] = [];

		for (const [id, record] of [...operations].reverse()) {
			const where = describeKey(record.key).label;

			if (!matches(record.name, record.type, where)) continue;

			rows.push(
				row(
					`op:${id}`,
					h("span", { class: `dot ${record.status}` }),
					h("span", { class: "what" }, h("b", {}, record.name), h("span", {}, `${record.type} · ${where}`)),
					h(
						"span",
						{ class: "meta" },
						h("span", { class: `tag ${record.status}` }, status(record)),
						h("span", { class: "ms" }, duration((record.endedAt ?? now) - record.startedAt)),
					),
				),
			);
		}

		list.replaceChildren(
			...(rows.length
				? rows
				: [
						operations.size
							? empty("No match", "Nothing matches the filter.")
							: empty("No operations yet", "Queries, mutations and subscriptions show up here as they run."),
					]),
		);
	}

	/**
	 * Shows an operation.
	 *
	 * @param record - The operation
	 */
	function showOperation(record: OperationRecord): void {
		const retries = record.retries ? `${record.retries} ${record.retries === 1 ? "retry" : "retries"}` : "";
		const facts = [record.type, status(record), duration((record.endedAt ?? Date.now()) - record.startedAt), retries];
		const actions = h("div", { class: "actions" });

		if (record.type === "query" && !record.stream) {
			actions.append(
				button("Run again", "action", function rerun(): void {
					const [key, , , operationName] = JSON.parse(record.key) as [CacheKey, string, unknown, string | null];

					// The same entry (key, variables, operation), refreshed from the network.
					record.client
						.gql({
							query: record.query,
							variables: record.variables as object,
							key,
							operationName: operationName ?? undefined,
							fetchPolicy: "network-only",
						})
						.catch(noop);
				}),
			);
		}

		if (record.data !== undefined) actions.append(copy("Copy result", record.data));
		if (record.variables !== undefined) actions.append(copy("Copy variables", record.variables));

		detail.replaceChildren(
			button("‹ Back", "ghost back", deselect),
			h("h2", {}, record.name),
			h("p", { class: "line" }, [...facts, record.fetchPolicy, clock(record.startedAt)].filter(Boolean).join(" · ")),
			actions,
			...(record.error === undefined
				? []
				: [h("h3", {}, "Error"), h("div", { class: "problem" }, message(record.error))]),
			...(record.data === undefined
				? []
				: [h("h3", {}, record.stream ? "Latest result" : "Result"), json(record.data)]),
			...(record.variables === undefined ? [] : [h("h3", {}, "Variables"), json(record.variables)]),
		);
	}

	/**
	 * Fills the list with the cache entries, the most recently written first; live ones are marked.
	 */
	function listCache(): void {
		const rows: Node[] = [];

		for (const record of [...entries.values()].reverse()) {
			const { label, detail: info } = describeKey(record.key);
			const live = watchers.get(record.key) ?? 0;

			if (!matches(label, info)) continue;

			rows.push(
				row(
					`entry:${record.key}`,
					h("span", { class: `dot ${live ? "live" : ""}` }),
					h("span", { class: "what" }, h("b", {}, label), h("span", {}, info || "no variables")),
					h(
						"span",
						{ class: "meta" },
						h("span", {}, live ? "live" : ""),
						h("span", { class: "ms" }, clock(record.updatedAt)),
					),
				),
			);
		}

		list.replaceChildren(
			...(rows.length
				? rows
				: [
						entries.size
							? empty("No match", "Nothing matches the filter.")
							: empty("Nothing cached", "Results appear here when they land in the cache."),
					]),
		);
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

		// An entry without a key has no prefix of its own: invalidating `[]` would drop every result.
		if (prefix?.length) {
			actions.append(
				button("Invalidate", "action", function invalidate(): void {
					client.invalidate(prefix).catch(noop);
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
		const lines: Node[] = [];

		for (const line of [...log].reverse()) {
			if (!matches(line.type, line.text)) continue;

			lines.push(h("p", {}, h("time", {}, clock(line.at)), h("i", {}, line.type), h("span", {}, line.text)));
		}

		list.replaceChildren(...(lines.length ? lines : [empty("Quiet so far", "Every client event is logged here.")]));
	}

	/**
	 * Clears the selection.
	 */
	function deselect(): void {
		selected = undefined;
		update();
	}

	/**
	 * Renders the launcher, the tabs, the list and (when it changed) the detail.
	 */
	function render(): void {
		frame = undefined;
		panel.hidden = !isOpen;

		let pending = 0;

		for (const record of operations.values()) if (record.status === "pending") pending++;

		launcher.replaceChildren(
			h("span", { class: `dot ${pending ? "pending" : failures ? "error" : "ok"}` }),
			h("span", { class: "word" }, h("b", {}, "lumen"), "ql"),
			failures
				? h("span", { class: "tally bad" }, `${failures} failed`)
				: h("span", { class: "tally" }, pending ? `${pending} running` : String(operations.size)),
		);
		launcher.setAttribute("aria-expanded", String(isOpen));
		launcher.setAttribute("aria-label", `${isOpen ? "Close" : "Open"} lumenql devtools`);
		launcher.title = shortcutLabel ? `lumenql devtools (${shortcutLabel})` : "lumenql devtools";

		if (!isOpen) return;

		const counts: Record<Tab, number | undefined> = { operations: operations.size, cache: entries.size, log: undefined };

		tabs.replaceChildren(
			...(["operations", "cache", "log"] as Tab[]).map(function tabButton(name: Tab): HTMLElement {
				const label = name.charAt(0).toUpperCase() + name.slice(1);
				const element = h(
					"button",
					{ type: "button", class: "tab", role: "tab", "aria-selected": String(tab === name) },
					label,
				);

				if (counts[name] !== undefined) element.append(h("small", {}, String(counts[name])));
				element.addEventListener("click", function choose(): void {
					tab = name;
					selected = undefined;
					if (name === "cache") loadCache();
					remember({ open: true, tab });
					update();
				});

				return element;
			}),
		);

		const record = tab === "operations" && selected?.startsWith("op:") ? operations.get(selected.slice(3)) : undefined;
		const entry = tab === "cache" && selected?.startsWith("entry:") ? entries.get(selected.slice(6)) : undefined;

		list.classList.toggle("log", tab === "log");

		if (tab === "operations") listOperations();
		else if (tab === "cache") listCache();
		else listLog();

		body.classList.toggle("split", record !== undefined || entry !== undefined);
		detail.hidden = record === undefined && entry === undefined;

		// The detail is rebuilt only when what it shows changed: selecting text or scrolling in it survives bursts.
		const showing = record
			? `${selected}:${record.version}`
			: entry
				? `entry:${entry.key}:${entry.version}:${watchers.get(entry.key) ?? 0}`
				: "";

		if (showing !== shown) {
			shown = showing;

			if (record) showOperation(record);
			else if (entry) showEntry(entry);
			else detail.replaceChildren();
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
		if ((event as KeyboardEvent).key === "Escape") close();
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
			frame = undefined;
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
 * The devtools as a plugin: one line, mounted with the client and removed by `client.dispose()`. In production
 * builds (`NODE_ENV=production`) it does nothing unless `force` is set; import it conditionally to also leave its
 * code out of the bundle.
 *
 * @example
 * const client = new Client({ url, plugins: [devtools()] });
 *
 * @param options - Panel options
 * @returns The plugin
 */
export function devtools(options: DevtoolsOptions = {}): Plugin {
	// One panel per plugin instance: clients derived with `extend()` reuse the plugin, and join its panel.
	let panel: DevtoolsHandle | undefined;
	let users = 0;

	return {
		name: "devtools",
		setup(client: Client): (() => void) | undefined {
			if (isProduction() && !options.force) return undefined;

			const detach = panel ? panel.attach(client) : noop;

			panel ??= mountDevtools(client, options);
			users++;

			return function teardown(): void {
				detach();

				if (--users === 0) {
					panel?.dispose();
					panel = undefined;
				}
			};
		},
	};
}

/**
 * Does nothing.
 */
function noop(): void {}
