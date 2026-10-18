import type { Plugin } from "./types";
import { isObject } from "./utils";

/**
 * A parser for the values of a field.
 */
export type ScalarParser = (value: unknown) => unknown;

/**
 * Parses fields by name in every network result, e.g. ISO strings into `Date`s. Without a schema the client cannot
 * know a field's type, so parsers are keyed by field name (aliases included); `null` values and lists are handled
 * (each item is parsed).
 *
 * Results are cached as parsed: with a persistent cache (`StorageCache`), parsers must return JSON-serializable
 * values, or cached results come back unparsed after a reload.
 *
 * @example
 * const client = new Client({ url, plugins: [scalars({ createdAt: parseDate, price: Number })] });
 *
 * @param parsers - Parsers by field name
 * @returns The plugin
 */
export function scalars(parsers: Readonly<Record<string, ScalarParser>>): Plugin {
	/**
	 * Parses a matched field's value, item by item for lists.
	 *
	 * @param parse - The field's parser
	 * @param value - The value
	 * @returns The parsed value
	 */
	function parseValue(parse: ScalarParser, value: unknown): unknown {
		if (value === null || value === undefined) return value;
		if (Array.isArray(value)) {
			return value.map(function parseItem(item: unknown): unknown {
				return parseValue(parse, item);
			});
		}

		return parse(value);
	}

	/**
	 * Copies a result, parsing the matched fields.
	 *
	 * @param value - Any part of a result
	 * @returns The parsed copy
	 */
	function walk(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(walk);
		if (!isObject(value)) return value;

		const copy: Record<string, unknown> = {};

		for (const [key, field] of Object.entries(value)) {
			const parsed = Object.hasOwn(parsers, key) ? parseValue(parsers[key]!, field) : walk(field);

			// A `__proto__` field stays data instead of replacing the prototype.
			if (key === "__proto__") {
				Object.defineProperty(copy, key, { value: parsed, enumerable: true, writable: true, configurable: true });
			} else {
				copy[key] = parsed;
			}
		}

		return copy;
	}

	return { name: "scalars", result: walk };
}
