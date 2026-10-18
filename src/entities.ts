import type { Client } from "./core";
import type { Plugin } from "./types";
import { isObject, matchesKeyPrefix } from "./utils";

/**
 * Options for {@link entities}.
 */
export interface EntitiesOptions {
	/**
	 * Computes the identity of an object, or `undefined` for objects that are not entities. Defaults to
	 * `__typename` + `id` (or `_id`).
	 */
	identify?: ((value: Readonly<Record<string, unknown>>) => string | undefined) | undefined;
	/** Maximum cached results tracked for propagation. Defaults to `500`. */
	limit?: number | undefined;
}

/**
 * Default identity: `__typename` and `id` (or `_id`).
 *
 * @param value - An object from a result
 * @returns `Type:id`, or `undefined`
 */
function defaultIdentify(value: Readonly<Record<string, unknown>>): string | undefined {
	const id = value.id ?? value._id;

	if (typeof value.__typename !== "string" || (typeof id !== "string" && typeof id !== "number")) return undefined;

	return `${value.__typename}:${id}`;
}

/**
 * Whether a field value is copied between occurrences of an entity: scalars and lists of scalars. Nested objects
 * may come from different selections, so they are only ever updated through their own identity.
 *
 * @param value - A field value
 * @returns `true` for propagated values
 */
function isScalar(value: unknown): boolean {
	return Array.isArray(value) ? value.every(isScalar) : !isObject(value);
}

/**
 * Whether two scalar field values are equal (lists compared item by item).
 *
 * @param a - A value
 * @param b - Another value
 * @returns `true` when equal
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		return (
			a.length === b.length &&
			a.every(function sameItem(item: unknown, index: number): boolean {
				return sameValue(item, b[index]);
			})
		);
	}

	return Object.is(a, b);
}

/**
 * Keeps entities consistent across cached results, without a schema or a document parser: when a network result
 * (a mutation's included) carries an entity, its scalar fields are copied into every other cached result holding the
 * same entity, and live queries showing them update. Entities are objects with `__typename` and `id` (select
 * `__typename` in the documents) or whatever `identify` returns.
 *
 * Only fields present on both sides are updated: an entity added to or removed from a list still needs
 * `invalidates` or `refetchQueries`. Propagated data is written like `client.write()`.
 *
 * @example
 * const client = new Client({ url, cache: new MemoryCache(), plugins: [entities()] });
 *
 * @param options - Identity and tracking options
 * @returns The plugin
 */
export function entities(options: EntitiesOptions = {}): Plugin {
	const identify = options.identify ?? defaultIdentify;
	const limit = options.limit ?? 500;

	/**
	 * Collects the scalar fields of every entity in a result (later occurrences win).
	 *
	 * @param value - Any part of a result
	 * @param found - Fields by entity identity
	 * @returns The same map
	 */
	function collect(value: unknown, found: Map<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
		if (Array.isArray(value)) {
			for (const item of value) collect(item, found);
		} else if (isObject(value)) {
			const identity = identify(value);
			const fields = identity === undefined ? undefined : (found.get(identity) ?? {});

			for (const [key, field] of Object.entries(value)) {
				if (fields && key !== "__proto__" && isScalar(field)) fields[key] = field;
				else collect(field, found);
			}

			if (identity !== undefined) found.set(identity, fields!);
		}

		return found;
	}

	/**
	 * Copies updated entity fields into a result, immutably.
	 *
	 * @param value - Any part of a result
	 * @param updates - Fields by entity identity
	 * @returns The updated value, or the same reference when nothing changed
	 */
	function apply(value: unknown, updates: Map<string, Record<string, unknown>>): unknown {
		if (Array.isArray(value)) {
			let copy: unknown[] | undefined;

			value.forEach(function applyItem(item: unknown, index: number): void {
				const next = apply(item, updates);

				if (next !== item) (copy ??= [...value])[index] = next;
			});

			return copy ?? value;
		}

		if (!isObject(value)) return value;

		const identity = identify(value);
		const fields = identity === undefined ? undefined : updates.get(identity);
		let copy: Record<string, unknown> | undefined;

		for (const [key, field] of Object.entries(value)) {
			const next = fields && Object.hasOwn(fields, key) && isScalar(field) ? fields[key] : apply(field, updates);

			if (!sameValue(next, field)) {
				copy ??= { ...value };
				copy[key] = next;
			}
		}

		return copy ?? value;
	}

	return {
		name: "entities",
		setup(client: Client): () => void {
			// The latest real data of each tracked cache entry (shared, frozen references), oldest first.
			const latest = new Map<string, unknown>();
			// Cache entries holding each entity.
			const holders = new Map<string, Set<string>>();

			/**
			 * Rebuilds the entity index from the tracked entries.
			 */
			function reindex(): void {
				holders.clear();

				for (const [key, data] of latest) {
					for (const identity of collect(data, new Map()).keys()) {
						let keys = holders.get(identity);

						if (!keys) holders.set(identity, (keys = new Set()));
						keys.add(key);
					}
				}
			}

			/**
			 * Propagates the entities of a result into the other tracked entries.
			 *
			 * @param data - The result's data
			 * @param source - The entry the result came from, if any (never rewritten)
			 */
			function propagate(data: unknown, source: string | undefined): void {
				const updates = collect(data, new Map());
				const snapshot: Record<string, unknown> = {};
				let changed = false;

				for (const identity of updates.keys()) {
					for (const key of holders.get(identity) ?? []) {
						if (key === source || Object.hasOwn(snapshot, key) || !latest.has(key)) continue;

						const current = latest.get(key);
						const next = apply(current, updates);

						if (next !== current) {
							snapshot[key] = next;
							changed = true;
						}
					}
				}

				// Each write emits its own `cache` event; propagation stops once every holder agrees.
				if (changed) client.restore(snapshot).catch(ignore);
			}

			const stops = [
				client.on("cache", function tracked({ key, data }): void {
					latest.delete(key);
					latest.set(key, data);

					for (const identity of collect(data, new Map()).keys()) {
						let keys = holders.get(identity);

						if (!keys) holders.set(identity, (keys = new Set()));
						keys.add(key);
					}

					// Bounded: the least recently written entries stop being tracked, and the index is rebuilt from the
					// tracked entries once it holds many identities of entries no longer tracked.
					while (latest.size > limit) latest.delete(latest.keys().next().value!);

					if (holders.size > limit * 10) reindex();

					propagate(data, key);
				}),
				client.on("result", function received({ context, source, data }): void {
					// Results that are not cached (mutations, `no-cache`) still carry fresh entities.
					if (source === "network" && context.type === "mutation") propagate(data, undefined);
				}),
				client.on("invalidate", function invalidated({ prefix }): void {
					for (const key of [...latest.keys()]) if (matchesKeyPrefix(key, prefix)) latest.delete(key);
				}),
			];

			return function stop(): void {
				for (const off of stops) off();
			};
		},
	};
}

/**
 * Swallows a failed propagation write (reported by the client like any write).
 */
function ignore(): void {}
