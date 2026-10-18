import type { Client } from "../core";
import type { CacheKey, ClientEvents, Plugin } from "../types";

/**
 * Options for {@link devtools}.
 */
export interface DevtoolsOptions {
	/** Open the panel when it mounts. Defaults to `false` (only the launcher shows). */
	open?: boolean | undefined;
	/** Corner the launcher and panel dock to. Defaults to `bottom-right`. */
	position?: "bottom-right" | "bottom-left" | undefined;
	/** Color scheme. Defaults to `system` (follows `prefers-color-scheme`). */
	theme?: "system" | "light" | "dark" | undefined;
	/** Maximum operations and events kept. Defaults to `300`. */
	limit?: number | undefined;
	/** Element the panel mounts into. Defaults to `document.body`. */
	container?: HTMLElement | undefined;
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
}

/**
 * An operation as the panel tracks it.
 */
interface OperationRecord {
	id: number;
	type: string;
	name: string;
	stream: boolean;
	fetchPolicy: string;
	key: string;
	variables: unknown;
	startedAt: number;
	endedAt: number | undefined;
	status: "pending" | "ok" | "error" | "streaming";
	source: string;
	data: unknown;
	error: unknown;
	retries: number;
	results: number;
}

/**
 * A cache entry as the panel tracks it.
 */
interface CacheRecord {
	key: string;
	data: unknown;
	updatedAt: number;
	writes: number;
	optimistic: string | undefined;
}

/**
 * A raw event in the log.
 */
interface EventRecord {
	at: number;
	type: keyof ClientEvents;
	summary: string;
}

/**
 * Panel tabs.
 */
type Tab = "operations" | "cache" | "live" | "events";

/**
 * Characters of JSON shown before truncating (large results would freeze the panel).
 */
const JSON_LIMIT = 40_000;

/**
 * The panel's styles. Colors are tokens on `:host`, redefined for dark schemes.
 */
const STYLES = `
/* Docked inspector: a launcher pill in a corner; the panel opens above it as a rail of tabs, a timeline list and a detail pane. */
:host {
	--lq-bg: #f5f6f8;
	--lq-surface: #ffffff;
	--lq-sunken: #eceef2;
	--lq-line: #d9dde4;
	--lq-fg: #1a2130;
	--lq-muted: #5d687a;
	--lq-accent: #a75f00;
	--lq-accent-soft: #fbecd6;
	--lq-ok: #1d7f53;
	--lq-err: #bf3328;
	--lq-err-soft: #fbe3e0;
	--lq-info: #2c62c9;
	--lq-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	--lq-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
	all: initial;
	position: fixed;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	z-index: 2147483000;
	bottom: calc(12px + env(safe-area-inset-bottom, 0px));
	right: calc(12px + env(safe-area-inset-right, 0px));
	font: 12px/1.45 var(--lq-sans);
	color: var(--lq-fg);
	color-scheme: light;
}
:host([data-position="bottom-left"]) { right: auto; left: calc(12px + env(safe-area-inset-left, 0px)); align-items: flex-start; }
:host([data-theme="dark"]) {
	--lq-bg: #11141a; --lq-surface: #181c24; --lq-sunken: #0d1015; --lq-line: #2a303b; --lq-fg: #e3e7ee;
	--lq-muted: #8b95a7; --lq-accent: #f0b347; --lq-accent-soft: #3a2c12; --lq-ok: #4fc28c; --lq-err: #ff6b5f;
	--lq-err-soft: #3d1a17; --lq-info: #74a6ff; color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
	:host(:not([data-theme="light"])) {
		--lq-bg: #11141a; --lq-surface: #181c24; --lq-sunken: #0d1015; --lq-line: #2a303b; --lq-fg: #e3e7ee;
		--lq-muted: #8b95a7; --lq-accent: #f0b347; --lq-accent-soft: #3a2c12; --lq-ok: #4fc28c; --lq-err: #ff6b5f;
		--lq-err-soft: #3d1a17; --lq-info: #74a6ff; color-scheme: dark;
	}
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--lq-accent); outline-offset: 1px; }
.launcher {
	display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 8px;
	background: var(--lq-surface); border: 1px solid var(--lq-line); border-radius: 999px;
	box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); font: 600 11px/1 var(--lq-mono); letter-spacing: 0.06em;
}
.meter { display: flex; gap: 2px; align-items: flex-end; height: 12px; }
.meter i { width: 3px; border-radius: 1px; background: var(--lq-line); }
.meter i.on { background: var(--lq-accent); }
.meter i:nth-child(1) { height: 5px; } .meter i:nth-child(2) { height: 8px; } .meter i:nth-child(3) { height: 12px; }
.count { color: var(--lq-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.count.err { color: var(--lq-err); }
.panel {
	display: grid; grid-template-rows: auto minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); width: min(760px, calc(100vw - 24px)); height: min(460px, calc(100vh - 80px));
	margin-bottom: 8px; background: var(--lq-bg); border: 1px solid var(--lq-line); border-radius: 10px; overflow: hidden;
	box-shadow: 0 12px 40px rgb(0 0 0 / 0.18);
}
.bar { display: flex; align-items: center; gap: 4px; min-width: 0; padding: 6px 8px; border-bottom: 1px solid var(--lq-line); background: var(--lq-surface); }
.mark { font: 700 11px/1 var(--lq-mono); letter-spacing: 0.08em; text-transform: lowercase; margin-right: 8px; }
.mark b { color: var(--lq-accent); }
.tabs { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; }
.tab { padding: 4px 8px; border: 0; border-radius: 6px; background: none; color: var(--lq-muted); white-space: nowrap; }
.tab[aria-selected="true"] { background: var(--lq-accent-soft); color: var(--lq-fg); }
.tab span { margin-left: 4px; font: 11px var(--lq-mono); font-variant-numeric: tabular-nums; }
.tool { padding: 4px 8px; border: 1px solid var(--lq-line); border-radius: 6px; background: var(--lq-surface); color: var(--lq-muted); }
.tool[aria-pressed="true"] { color: var(--lq-accent); border-color: var(--lq-accent); }
.body { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); min-height: 0; }
.list { overflow: auto; border-right: 1px solid var(--lq-line); }
.detail { overflow: auto; padding: 10px 12px; background: var(--lq-surface); min-width: 0; }
.row {
	display: grid; grid-template-columns: 22px minmax(0, 1fr) auto 56px; align-items: center; gap: 8px; width: 100%;
	padding: 6px 10px; border: 0; border-bottom: 1px solid var(--lq-line); background: none; text-align: left;
}
.row:hover { background: var(--lq-sunken); }
.row[aria-selected="true"] { background: var(--lq-accent-soft); }
.op { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 5px; font: 700 10px var(--lq-mono); background: var(--lq-sunken); color: var(--lq-muted); }
.op.mutation { color: var(--lq-accent); }
.op.subscription { color: var(--lq-info); }
.name { min-width: 0; }
.name strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.name small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--lq-muted); font: 10.5px var(--lq-mono); }
.chip { padding: 1px 6px; border: 1px solid var(--lq-line); border-radius: 999px; font: 10px var(--lq-mono); color: var(--lq-muted); white-space: nowrap; }
.chip.error { border-color: var(--lq-err); color: var(--lq-err); background: var(--lq-err-soft); }
.chip.pending, .chip.streaming { border-color: var(--lq-accent); color: var(--lq-accent); }
.chip.ok { border-color: var(--lq-ok); color: var(--lq-ok); }
.time { display: grid; gap: 3px; justify-items: end; font: 10.5px var(--lq-mono); color: var(--lq-muted); font-variant-numeric: tabular-nums; }
.wf { position: relative; width: 56px; height: 3px; border-radius: 2px; background: var(--lq-sunken); }
.wf i { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: 2px; background: var(--lq-info); }
.wf i.error { background: var(--lq-err); } .wf i.pending, .wf i.streaming { background: var(--lq-accent); }
.empty { padding: 24px 16px; color: var(--lq-muted); line-height: 1.6; }
.empty code { font-family: var(--lq-mono); color: var(--lq-fg); }
h3 { margin: 0 0 6px; font: 600 13px var(--lq-sans); overflow-wrap: anywhere; }
h4 { margin: 14px 0 6px; font: 600 10px var(--lq-sans); letter-spacing: 0.08em; text-transform: uppercase; color: var(--lq-muted); }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; margin: 0; }
dt { color: var(--lq-muted); }
dd { margin: 0; font-family: var(--lq-mono); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
pre { margin: 0; padding: 8px 10px; max-height: 260px; overflow: auto; background: var(--lq-sunken); border-radius: 6px; font: 11px/1.5 var(--lq-mono); white-space: pre; }
.k { color: var(--lq-info); } .s { color: var(--lq-ok); } .n { color: var(--lq-accent); } .l { color: var(--lq-muted); }
.err-box { padding: 8px 10px; border-left: 3px solid var(--lq-err); background: var(--lq-err-soft); border-radius: 0 6px 6px 0; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.log { font: 11px var(--lq-mono); }
.log div { display: grid; grid-template-columns: 74px 82px minmax(0, 1fr); gap: 8px; padding: 3px 10px; border-bottom: 1px solid var(--lq-line); }
.log time { color: var(--lq-muted); font-variant-numeric: tabular-nums; }
.log b { font-weight: 600; color: var(--lq-accent); }
.log span { overflow-wrap: anywhere; }
@media (max-width: 560px) {
	.body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
	.list { border-right: 0; border-bottom: 1px solid var(--lq-line); }
	.mark { display: none; }
}
@media (prefers-reduced-motion: no-preference) {
	.chip.pending, .chip.streaming, .meter i.on { animation: lq-pulse 1.2s ease-in-out infinite; }
	@keyframes lq-pulse { 50% { opacity: 0.45; } }
}
`;

/**
 * Creates an element with attributes and children. Text is always set as text, never parsed as HTML: results come
 * from the server and must not inject markup.
 *
 * @param tag - The tag name
 * @param attributes - Attributes (`class`, `aria-*`, `data-*`...); `undefined` values are skipped
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
 * Renders a value as highlighted, truncated JSON.
 *
 * @param value - Any value
 * @returns A `pre` element
 */
function json(value: unknown): HTMLElement {
	let text: string;

	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}

	if (text.length > JSON_LIMIT) text = `${text.slice(0, JSON_LIMIT)}\n… (${text.length - JSON_LIMIT} more characters)`;

	const pre = h("pre");
	const token = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
	let index = 0;

	for (let match = token.exec(text); match; match = token.exec(text)) {
		pre.append(text.slice(index, match.index));

		const kind = match[1] ? (match[2] ? "k" : "s") : match[3] ? "l" : "n";

		pre.append(h("span", { class: kind }, match[1] ?? match[0]));
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
 * @returns The duration, e.g. `42ms` or `1.3s`
 */
function formatDuration(ms: number): string {
	return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * Formats a clock time with milliseconds.
 *
 * @param at - A timestamp
 * @returns `hh:mm:ss.mmm`
 */
function formatClock(at: number): string {
	const date = new Date(at);

	return `${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Describes a serialized cache key: its user key, variables and operation name.
 *
 * @param key - A serialized cache key
 * @returns A readable label and detail
 */
function describeKey(key: string): { label: string; detail: string; prefix: CacheKey | undefined } {
	try {
		const [prefix, , variables, operationName] = JSON.parse(key) as [CacheKey, string, unknown, string | null];
		const label = prefix.length ? prefix.map(String).join(" › ") : "(no key)";
		const detail = [operationName, variables === null ? "" : JSON.stringify(variables)].filter(Boolean).join(" ");

		return { label, detail, prefix };
	} catch {
		return { label: key, detail: "", prefix: undefined };
	}
}

/**
 * Summarizes an error for a list.
 *
 * @param error - Any thrown value
 * @returns Its message
 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Mounts the devtools panel for a client: a launcher pill in a corner showing in-flight operations and errors, and
 * an inspector with the operations timeline (source, timing, variables, results, errors, retries), the cache
 * (entries, writes, optimistic layers, invalidation), live queries and the raw event log. It only listens to the
 * client's events, so the client behaves exactly the same with or without it. Does nothing outside a browser.
 *
 * @example
 * import { mountDevtools } from "lumenql/devtools";
 *
 * if (import.meta.env.DEV) mountDevtools(client);
 *
 * @param client - The client to inspect
 * @param options - Panel options
 * @returns Controls for the panel
 */
export function mountDevtools(client: Client, options: DevtoolsOptions = {}): DevtoolsHandle {
	if (typeof document === "undefined") {
		return { open: noop, close: noop, dispose: noop };
	}

	const limit = options.limit ?? 300;
	const operations = new Map<number, OperationRecord>();
	const entries = new Map<string, CacheRecord>();
	const live = new Map<string, number>();
	const events: EventRecord[] = [];
	const host = h("div", {
		"data-lumenql-devtools": "",
		"data-position": options.position ?? "bottom-right",
		"data-theme": options.theme === "system" ? undefined : options.theme,
	});
	const root = host.attachShadow({ mode: "open" });
	let isOpen = options.open === true;
	let paused = false;
	let tab: Tab = "operations";
	let selected: string | number | undefined;
	let frame: number | undefined;

	root.append(h("style", {}, STYLES));
	(options.container ?? document.body).append(host);

	/**
	 * Schedules a render on the next animation frame (events can arrive in bursts).
	 */
	function invalidateView(): void {
		if (frame === undefined) frame = requestAnimationFrame(render);
	}

	/**
	 * Keeps a list bounded, dropping the oldest items.
	 *
	 * @param map - Records by key, in insertion order
	 */
	function trim<K, V>(map: Map<K, V>): void {
		while (map.size > limit) map.delete(map.keys().next().value as K);
	}

	/**
	 * Records a raw event.
	 *
	 * @param type - The event type
	 * @param summary - One line about it
	 */
	function log(type: keyof ClientEvents, summary: string): void {
		if (paused) return;

		events.push({ at: Date.now(), type, summary });
		if (events.length > limit) events.shift();
		invalidateView();
	}

	/**
	 * The record of an operation, if it is tracked.
	 *
	 * @param id - The operation id
	 * @returns The record
	 */
	function operation(id: number | undefined): OperationRecord | undefined {
		return id === undefined ? undefined : operations.get(id);
	}

	const stops = [
		client.on("operation", function started({ id, context, fetchPolicy, key }): void {
			log("operation", `#${id} ${context.type} ${context.name ?? "(anonymous)"} · ${fetchPolicy}`);
			if (paused) return;

			operations.set(id, {
				id,
				type: context.type,
				name: context.name ?? "(anonymous)",
				stream: context.stream === true,
				fetchPolicy,
				key,
				variables: context.variables,
				startedAt: Date.now(),
				endedAt: undefined,
				status: context.stream ? "streaming" : "pending",
				source: context.stream ? "stream" : "network",
				data: undefined,
				error: undefined,
				retries: 0,
				results: 0,
			});
			trim(operations);
		}),
		client.on("result", function resulted({ id, source, data }): void {
			const record = operation(id);

			log("result", `#${id} ${source}`);
			if (!record) return;

			record.data = data;
			record.source = source;
			record.results++;

			if (source !== "stream") {
				record.status = "ok";
				record.endedAt = Date.now();
			}
		}),
		client.on("error", function failed({ id, error }): void {
			const record = operation(id);

			log("error", `#${id} ${errorMessage(error)}`);
			if (!record) return;

			record.status = "error";
			record.error = error;
			record.endedAt = Date.now();
		}),
		client.on("done", function ended({ id }): void {
			const record = operation(id);

			log("done", `#${id} stream ended`);
			if (!record) return;

			record.status = "ok";
			record.endedAt = Date.now();
		}),
		client.on("retry", function retried({ context, delay, attempts, error }): void {
			const record = operation(context.id);

			log(
				"retry",
				`#${context.id} ${context.attempt + 1}/${attempts} in ${formatDuration(delay)}: ${errorMessage(error)}`,
			);
			if (record) record.retries = context.attempt + 1;
		}),
		client.on("cache", function written({ key, data }): void {
			const record = entries.get(key);

			log("cache", describeKey(key).label);
			if (paused) return;

			entries.set(key, {
				key,
				data,
				updatedAt: Date.now(),
				writes: (record?.writes ?? 0) + 1,
				optimistic: record?.optimistic,
			});
			trim(entries);
		}),
		client.on("invalidate", function invalidated({ prefix, removed }): void {
			log("invalidate", `[${prefix.map(String).join(", ")}] · ${removed} removed`);
			if (paused) return;

			for (const key of [...entries.keys()]) {
				const { prefix: entryPrefix } = describeKey(key);

				if (
					entryPrefix &&
					prefix.every(function same(segment, index): boolean {
						return entryPrefix[index] === segment;
					})
				) {
					entries.delete(key);
				}
			}
		}),
		client.on("optimistic", function layered({ key, phase }): void {
			const record = entries.get(key);

			log("optimistic", `${describeKey(key).label} · ${phase}`);
			if (record) record.optimistic = phase === "apply" ? "optimistic" : undefined;
		}),
		client.on("watch", function watched({ key, watchers }): void {
			log("watch", `${describeKey(key).label} · ${watchers} watching`);
			if (paused) return;

			if (watchers > 0) live.set(key, watchers);
			else live.delete(key);
		}),
	];

	/**
	 * Loads the entries already cached when the panel opens.
	 */
	function loadCache(): void {
		client.extract().then(function fill(snapshot: Record<string, unknown>): void {
			for (const [key, data] of Object.entries(snapshot)) {
				if (!entries.has(key))
					entries.set(key, { key, data, updatedAt: Date.now(), writes: 0, optimistic: undefined });
			}

			invalidateView();
		}, noop);
	}

	/**
	 * Creates a toolbar button.
	 *
	 * @param label - The visible label
	 * @param action - What it does
	 * @param pressed - Toggle state, for toggle buttons
	 * @returns The button
	 */
	function button(label: string, action: () => void, pressed?: boolean): HTMLElement {
		const element = h(
			"button",
			{ class: "tool", type: "button", "aria-pressed": pressed === undefined ? undefined : String(pressed) },
			label,
		);

		element.addEventListener("click", action);

		return element;
	}

	/**
	 * Renders the launcher.
	 *
	 * @returns The launcher button
	 */
	function renderLauncher(): HTMLElement {
		let pending = 0;
		let failed = 0;

		for (const record of operations.values()) {
			if (record.status === "pending" || record.status === "streaming") pending++;
			if (record.status === "error") failed++;
		}

		const meter = h("span", { class: "meter", "aria-hidden": "true" });

		for (let bar = 0; bar < 3; bar++) meter.append(h("i", { class: pending > bar ? "on" : undefined }));

		const launcher = h(
			"button",
			{
				class: "launcher",
				type: "button",
				"aria-expanded": String(isOpen),
				"aria-label": `lumenql devtools: ${pending} in flight, ${failed} failed`,
			},
			meter,
			"lumenql",
			h("span", { class: "count" }, `${operations.size} ops`),
			failed ? h("span", { class: "count err" }, `${failed} failed`) : undefined,
		);

		launcher.addEventListener("click", function toggle(): void {
			if (isOpen) handle.close();
			else handle.open();
		});

		return launcher;
	}

	/**
	 * Renders a list row.
	 *
	 * @param id - The row's selection id
	 * @param children - The row's cells
	 * @returns The row
	 */
	function row(id: string | number, ...children: Node[]): HTMLElement {
		const element = h("button", { class: "row", type: "button", "aria-selected": String(selected === id) }, ...children);

		element.addEventListener("click", function select(): void {
			selected = id;
			invalidateView();
		});

		return element;
	}

	/**
	 * Renders the operations timeline and the selected operation.
	 *
	 * @returns The list and the detail pane
	 */
	function renderOperations(): [HTMLElement, HTMLElement] {
		const list = h("div", { class: "list", role: "list" });
		const records = [...operations.values()].reverse();
		const now = Date.now();
		const first = records.at(-1)?.startedAt ?? now;
		const span = Math.max(now - first, 1);

		if (records.length === 0) {
			list.append(
				h(
					"p",
					{ class: "empty" },
					"Operations appear here as the app runs ",
					h("code", {}, "gql"),
					", live queries and subscriptions.",
				),
			);
		}

		for (const record of records) {
			const duration = (record.endedAt ?? now) - record.startedAt;
			const bar = h("i", {
				class: record.status,
				style: `left:${((record.startedAt - first) / span) * 100}%;width:${(Math.max(duration, 1) / span) * 100}%`,
			});

			list.append(
				row(
					record.id,
					h("span", { class: `op ${record.type}`, title: record.type }, record.type.charAt(0).toUpperCase()),
					h(
						"span",
						{ class: "name" },
						h("strong", {}, record.name),
						h("small", {}, describeKey(record.key).label),
					),
					h(
						"span",
						{ class: `chip ${record.status === "ok" ? record.source : record.status}` },
						record.status === "ok" ? record.source : record.status,
					),
					h("span", { class: "time" }, formatDuration(duration), h("span", { class: "wf" }, bar)),
				),
			);
		}

		const record = typeof selected === "number" ? operations.get(selected) : undefined;
		const detail = h("div", { class: "detail" });

		if (!record) {
			detail.append(h("p", { class: "empty" }, "Select an operation to see its variables, result and timing."));
			return [list, detail];
		}

		detail.append(
			h("h3", {}, `${record.type} ${record.name}`),
			h(
				"dl",
				{},
				h("dt", {}, "Status"),
				h("dd", {}, record.status === "ok" ? `ok · ${record.source}` : record.status),
				h("dt", {}, "Policy"),
				h("dd", {}, record.fetchPolicy),
				h("dt", {}, "Duration"),
				h("dd", {}, formatDuration((record.endedAt ?? Date.now()) - record.startedAt)),
				h("dt", {}, "Retries"),
				h("dd", {}, String(record.retries)),
				h("dt", {}, "Results"),
				h("dd", {}, String(record.results)),
				h("dt", {}, "Key"),
				h("dd", {}, describeKey(record.key).label),
			),
			h("h4", {}, "Variables"),
			json(record.variables ?? null),
		);

		if (record.error !== undefined) {
			const errors = (record.error as { errors?: ReadonlyArray<{ message: string }> }).errors ?? [];

			detail.append(h("h4", {}, "Error"), h("div", { class: "err-box" }, errorMessage(record.error)));

			if (errors.length) detail.append(json(errors));
		}

		if (record.data !== undefined) {
			detail.append(h("h4", {}, record.stream ? "Latest result" : "Result"), json(record.data));
		}

		return [list, detail];
	}

	/**
	 * Renders the cache entries and the selected entry.
	 *
	 * @returns The list and the detail pane
	 */
	function renderCache(): [HTMLElement, HTMLElement] {
		const list = h("div", { class: "list", role: "list" });
		const records = [...entries.values()].sort(function newestFirst(a: CacheRecord, b: CacheRecord): number {
			return b.updatedAt - a.updatedAt;
		});

		if (records.length === 0) {
			list.append(h("p", { class: "empty" }, "Nothing cached yet. Entries appear when results land in the cache."));
		}

		for (const record of records) {
			const { label, detail } = describeKey(record.key);

			list.append(
				row(
					record.key,
					h("span", { class: "op" }, "K"),
					h("span", { class: "name" }, h("strong", {}, label), h("small", {}, detail || " ")),
					h(
						"span",
						{ class: `chip ${record.optimistic ? "pending" : ""}` },
						record.optimistic ?? `${record.writes} writes`,
					),
					h("span", { class: "time" }, formatClock(record.updatedAt).slice(3, 8)),
				),
			);
		}

		const record = typeof selected === "string" ? entries.get(selected) : undefined;
		const pane = h("div", { class: "detail" });

		if (!record) {
			pane.append(h("p", { class: "empty" }, "Select an entry to see its data, or invalidate it."));
			return [list, pane];
		}

		const { label, detail, prefix } = describeKey(record.key);
		const actions = h("div", { class: "actions" });

		if (prefix) {
			actions.append(
				button("Invalidate entry key", function invalidate(): void {
					client.invalidate(prefix).catch(noop);
				}),
			);
		}

		actions.append(button("Reload from cache", loadCache));
		pane.append(
			h("h3", {}, label),
			h(
				"dl",
				{},
				h("dt", {}, "Operation"),
				h("dd", {}, detail || "—"),
				h("dt", {}, "Updated"),
				h("dd", {}, formatClock(record.updatedAt)),
			),
			actions,
			h("h4", {}, "Data"),
			json(record.data),
		);

		return [list, pane];
	}

	/**
	 * Renders the live queries.
	 *
	 * @returns The list and the detail pane
	 */
	function renderLive(): [HTMLElement, HTMLElement] {
		const list = h("div", { class: "list", role: "list" });

		if (live.size === 0) {
			list.append(
				h(
					"p",
					{ class: "empty" },
					"No live query is mounted. ",
					h("code", {}, "watch()"),
					" and the hooks show up here.",
				),
			);
		}

		for (const [key, watchers] of live) {
			const { label, detail } = describeKey(key);

			list.append(
				row(
					`live:${key}`,
					h("span", { class: "op subscription" }, "L"),
					h("span", { class: "name" }, h("strong", {}, label), h("small", {}, detail || " ")),
					h("span", { class: "chip ok" }, `${watchers} watching`),
					h("span", { class: "time" }, ""),
				),
			);
		}

		const key = typeof selected === "string" && selected.startsWith("live:") ? selected.slice(5) : undefined;
		const pane = h("div", { class: "detail" });
		const record = key === undefined ? undefined : entries.get(key);

		if (key === undefined) pane.append(h("p", { class: "empty" }, "Select a live query to see the data it shows."));
		else pane.append(h("h3", {}, describeKey(key).label), h("h4", {}, "Cached data"), json(record?.data ?? null));

		return [list, pane];
	}

	/**
	 * Renders the raw event log.
	 *
	 * @returns The log, spanning both columns
	 */
	function renderEvents(): HTMLElement {
		const list = h("div", { class: "list log", style: "grid-column:1/-1;border-right:0" });

		if (events.length === 0) list.append(h("p", { class: "empty" }, "Every client event is logged here."));

		for (const event of [...events].reverse()) {
			list.append(
				h("div", {}, h("time", {}, formatClock(event.at)), h("b", {}, event.type), h("span", {}, event.summary)),
			);
		}

		return list;
	}

	/**
	 * Renders the panel, replacing the previous render.
	 */
	function render(): void {
		frame = undefined;

		const scroll = root.querySelector(".list")?.scrollTop ?? 0;
		const children: Node[] = [];

		if (isOpen) {
			const tabs = h("div", { class: "tabs", role: "tablist" });
			const counts: Record<Tab, number> = {
				operations: operations.size,
				cache: entries.size,
				live: live.size,
				events: events.length,
			};

			for (const name of ["operations", "cache", "live", "events"] as Tab[]) {
				const element = h(
					"button",
					{ class: "tab", type: "button", role: "tab", "aria-selected": String(tab === name) },
					name === "live" ? "Live queries" : name.charAt(0).toUpperCase() + name.slice(1),
					h("span", {}, String(counts[name])),
				);

				element.addEventListener("click", function choose(): void {
					tab = name;
					selected = undefined;
					if (name === "cache") loadCache();
					invalidateView();
				});
				tabs.append(element);
			}

			const body = h("div", { class: "body" });

			if (tab === "events") body.append(renderEvents());
			else
				body.append(...(tab === "operations" ? renderOperations() : tab === "cache" ? renderCache() : renderLive()));

			children.push(
				h(
					"div",
					{ class: "panel", role: "dialog", "aria-label": "lumenql devtools" },
					h(
						"div",
						{ class: "bar" },
						h("span", { class: "mark" }, h("b", {}, "lumen"), "ql"),
						tabs,
						button(
							paused ? "Resume" : "Pause",
							function togglePause(): void {
								paused = !paused;
								invalidateView();
							},
							paused,
						),
						button("Clear", function clear(): void {
							operations.clear();
							events.length = 0;
							selected = undefined;
							invalidateView();
						}),
					),
					body,
				),
			);
		}

		children.push(renderLauncher());
		root.replaceChildren(root.querySelector("style")!, ...children);

		const list = root.querySelector(".list");

		if (list) list.scrollTop = scroll;
	}

	const handle: DevtoolsHandle = {
		open(): void {
			isOpen = true;
			loadCache();
			invalidateView();
		},
		close(): void {
			isOpen = false;
			invalidateView();
		},
		dispose(): void {
			for (const stop of stops) stop();
			if (frame !== undefined) cancelAnimationFrame(frame);
			host.remove();
		},
	};

	root.addEventListener("keydown", function closeOnEscape(event: Event): void {
		if ((event as KeyboardEvent).key === "Escape") handle.close();
	});

	if (isOpen) loadCache();
	render();

	return handle;
}

/**
 * The devtools as a plugin: mounts the panel when the client is created and removes it on `client.dispose()`.
 *
 * @example
 * const client = new Client({ url, plugins: import.meta.env.DEV ? [devtools()] : [] });
 *
 * @param options - Panel options
 * @returns The plugin
 */
export function devtools(options?: DevtoolsOptions): Plugin {
	return {
		name: "devtools",
		setup(client: Client): () => void {
			return mountDevtools(client, options).dispose;
		},
	};
}

/**
 * Does nothing.
 */
function noop(): void {}
