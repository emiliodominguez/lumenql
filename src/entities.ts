import type { Client } from "./core";
import type { CacheKey, Plugin } from "./types";
import { isObject, isPlainData, matchesKeyPrefix } from "./utils";

/**
 * Options for {@link entities}.
 */
export interface EntitiesOptions {
	/**
	 * Computes the identity of an object, or `undefined` for objects that are not entities. Defaults to
	 * `__typename` + `id` (or `_id`).
	 */
	identify?: ((value: Readonly<Record<string, unknown>>) => string | undefined) | undefined;
	/** Maximum cache entries indexed for propagation (the least recently written are forgotten). Defaults to `500`. */
	limit?: number | undefined;
}

/**
 * Fields of an entity, by identity.
 */
type Updates = Map<string, Record<string, unknown>>;

/**
 * Default identity: `__typename` and `id` (or `_id`). Numeric and string ids are the same entity (`1` and `"1"`).
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
 * Whether a field value is copied between occurrences of an entity: scalars, values that are not plain data (dates,
 * money...) and lists of them. Nested plain objects may come from different selections: they are only ever updated
 * through their own identity.
 *
 * @param value - A field value
 * @returns `true` for propagated values
 */
function isScalar(value: unknown): boolean {
	if (Array.isArray(value)) return value.every(isScalar);

	return !isObject(value) || !isPlainData(value);
}

/**
 * Whether two field values are equal: lists item by item, dates by time, anything else by identity.
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

	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();

	return Object.is(a, b);
}

/**
 * Keeps entities consistent across cached results, without a schema or a document parser: when a network result
 * (a mutation's included) or a write carries an entity, its scalar fields are copied into every other cached result
 * holding the same entity, and live queries showing them update. Entities are objects with `__typename` and `id`
 * (select `__typename` in the documents) or whatever `identify` returns.
 *
 * Only fields present on both sides are updated: an entity added to or removed from a list still needs
 * `invalidates` or `refetchQueries`. Updates go through `client.updateEntry()`: they apply to each entry's newest
 * data, never override responses in flight, and never recreate an invalidated entry. Clients derived with
 * `extend()` share the plugin and its index.
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
	// The identities each indexed entry holds, least recently written first, and the entries holding each identity.
	const held = new Map<string, Set<string>>();
	const holders = new Map<string, Set<string>>();

	/**
	 * Collects the scalar fields of every entity in a result (later occurrences win).
	 *
	 * @param value - Any part of a result
	 * @param found - Fields by identity
	 * @returns The same map
	 */
	function collect(value: unknown, found: Updates): Updates {
		if (Array.isArray(value)) {
			for (const item of value) collect(item, found);
		} else if (isObject(value) && isPlainData(value)) {
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
	 * @param updates - Fields by identity
	 * @returns The updated value, or the same reference when nothing changed
	 */
	function apply(value: unknown, updates: Updates): unknown {
		if (Array.isArray(value)) {
			let copy: unknown[] | undefined;

			value.forEach(function applyItem(item: unknown, index: number): void {
				const next = apply(item, updates);

				if (next !== item) (copy ??= [...value])[index] = next;
			});

			return copy ?? value;
		}

		if (!isObject(value) || !isPlainData(value)) return value;

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

	/**
	 * Stops indexing an entry.
	 *
	 * @param key - The serialized cache key
	 */
	function forget(key: string): void {
		for (const identity of held.get(key) ?? []) {
			const keys = holders.get(identity);

			keys?.delete(key);
			if (keys?.size === 0) holders.delete(identity);
		}

		held.delete(key);
	}

	/**
	 * Indexes the entities an entry holds now.
	 *
	 * @param key - The serialized cache key
	 * @param updates - Its entities
	 */
	function index(key: string, updates: Updates): void {
		forget(key);

		const identities = new Set(updates.keys());

		held.set(key, identities);

		for (const identity of identities) {
			let keys = holders.get(identity);

			if (!keys) holders.set(identity, (keys = new Set()));
			keys.add(key);
		}

		// Bounded: the least recently written entries are forgotten.
		while (held.size > limit) forget(held.keys().next().value!);
	}

	/**
	 * Copies a result's entities into the other entries holding them.
	 *
	 * @param client - The client to update entries through
	 * @param updates - The result's entities
	 * @param source - The entry the result came from, if any (never rewritten)
	 */
	function propagate(client: Client, updates: Updates, source: string | undefined): void {
		const targets = new Set<string>();

		for (const identity of updates.keys()) for (const key of holders.get(identity) ?? []) targets.add(key);

		targets.delete(source!);

		for (const key of targets) {
			client
				.updateEntry(key, function patch(data: unknown): unknown {
					return apply(data, updates);
				})
				.catch(ignore);
		}
	}

	return {
		name: "entities",
		setup(client: Client): () => void {
			const stops = [
				client.on("cache", function written({ key, data, derived }): void {
					const updates = collect(data, new Map());

					index(key, updates);

					// Data derived by a propagation only carries what it copied: propagating it again would loop.
					if (!derived && updates.size > 0) propagate(client, updates, key);
				}),
				client.on("result", function received({ context, source, data }): void {
					// Results that are not cached (mutations, `no-cache`) still carry fresh entities.
					if (source === "network" && context.type === "mutation")
						propagate(client, collect(data, new Map()), undefined);
				}),
				client.on("invalidate", function invalidated({ prefix }: { prefix: CacheKey }): void {
					for (const key of [...held.keys()]) if (matchesKeyPrefix(key, prefix)) forget(key);
				}),
			];

			return function stop(): void {
				for (const off of stops) off();
			};
		},
	};
}

/**
 * Swallows a failed propagation (the client reports cache failures).
 */
function ignore(): void {}
