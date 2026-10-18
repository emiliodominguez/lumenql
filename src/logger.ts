import type { Client } from "./core";
import type { OperationContext, Plugin } from "./types";

/**
 * Logs operations, cache hits, deduplications, retries and timings through `console.debug`, from the client's
 * events. The `lumenql` entry installs it with `debug: true`.
 *
 * @example
 * const client = new Client({ url, plugins: [logger()] }); // from "lumenql/core"
 *
 * @param log - Where lines go. Defaults to `console.debug`.
 * @returns The plugin
 */
export function logger(log: (line: string) => void = console.debug): Plugin {
	return {
		name: "logger",
		setup(client: Client): () => void {
			// Start time and retries per operation id, for the final "ok in Nms after N retries" line.
			const starts = new Map<number | undefined, number>();
			const retries = new Map<number | undefined, number>();
			const refreshes = new Set<number>();

			/**
			 * Writes a line about an operation.
			 *
			 * @param context - The operation metadata
			 * @param detail - What happened
			 */
			function write(context: OperationContext, detail: string): void {
				log(`[lumenql] ${context.type} ${context.name ?? "(anonymous)"} → ${detail}`);
			}

			const stops = [
				client.on("operation", function started({ id, context, fetchPolicy }): void {
					starts.set(id, Date.now());
					// A cache hit is followed by a background refresh: its timing must survive the hit.
					if (fetchPolicy === "cache-and-network") refreshes.add(id);

					if (context.stream) write(context, "streaming");
				}),
				client.on("retry", function retried({ context, delay, attempts }): void {
					retries.set(context.id, context.attempt + 1);
					write(context, `retry ${context.attempt + 1}/${attempts} in ${Math.round(delay)}ms`);
				}),
				client.on("result", function resulted({ id, context, source }): void {
					const retried = retries.get(id) ?? 0;
					const duration = Date.now() - (starts.get(id) ?? Date.now());

					// A stream keeps its start time until it ends, and a cache hit until its background refresh does.
					if (source === "cache" && refreshes.delete(id)) return write(context, "cache hit");
					if (source !== "stream") starts.delete(id);
					refreshes.delete(id);
					retries.delete(id);

					if (source === "cache") write(context, "cache hit");
					else if (source === "dedupe") write(context, "deduplicated");
					else if (source === "network")
						write(context, `ok in ${duration}ms${retried ? ` after ${retried} retries` : ""}`);
				}),
				client.on("error", function failed({ id }): void {
					starts.delete(id);
					refreshes.delete(id);
					retries.delete(id);
				}),
				client.on("done", function ended({ id }): void {
					starts.delete(id);
				}),
			];

			return function stop(): void {
				for (const off of stops) off();
			};
		},
	};
}
