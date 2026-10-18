import { isClientError } from "./errors";
import type { MaybePromise, OperationContext, OperationPayload, PersistedQueriesOptions, Plugin } from "./types";
import { ignoreError, sha256 } from "./utils";

/**
 * Detects the Automatic Persisted Queries negotiation errors.
 *
 * @param error - Any thrown value
 * @returns `"missing"` when the server needs the full document, `"unsupported"` when APQ is unavailable
 */
function getPersistedQueryMiss(error: unknown): "missing" | "unsupported" | undefined {
	if (!isClientError(error)) return undefined;

	for (const { message, extensions } of error.errors) {
		if (message === "PersistedQueryNotFound" || extensions?.code === "PERSISTED_QUERY_NOT_FOUND") return "missing";
		if (message === "PersistedQueryNotSupported" || extensions?.code === "PERSISTED_QUERY_NOT_SUPPORTED") {
			return "unsupported";
		}
	}

	return undefined;
}

/**
 * [Automatic Persisted Queries](https://www.apollographql.com/docs/apollo-server/performance/apq): sends a SHA-256
 * hash first and the full document only when the server asks for it, turning itself off when the server does not
 * support APQ. With `{ strict: true }` (trusted documents), only the hash is ever sent, subscriptions included, and an
 * unknown hash is an error. The `lumenql` entry installs it from the `persistedQueries` option.
 *
 * @example
 * const client = new Client({ url, method: "GET", plugins: [persistedQueries()] }); // from "lumenql/core"
 *
 * @param options - `true`, or a custom `hash` and `strict` mode
 * @returns The plugin
 */
export function persistedQueries(options: boolean | PersistedQueriesOptions = true): Plugin {
	const strict = typeof options === "object" && options.strict === true;
	const custom = typeof options === "object" ? options.hash : undefined;
	const hashes = new Map<string, Promise<string>>();
	// Flipped off when the server reports it does not support persisted queries.
	let supported = true;

	/**
	 * Resolves and memoizes the hash of a document. A failure is never memoized: the next request retries it.
	 *
	 * @param query - The GraphQL document
	 * @returns The hash
	 */
	function hash(query: string): Promise<string> {
		let pending = hashes.get(query);

		if (!pending) {
			pending = Promise.resolve()
				.then(function compute(): MaybePromise<string> {
					return custom ? custom(query) : sha256(query);
				})
				.catch(function forget(error: unknown): never {
					hashes.delete(query);
					throw error;
				});
			hashes.set(query, pending);
		}

		return pending;
	}

	return {
		name: "persisted-queries",
		async send<T>(
			payload: OperationPayload,
			context: OperationContext,
			next: (payload: OperationPayload) => Promise<T>,
		): Promise<T> {
			const { query, variables, operationName } = payload;

			// Streams only hide the document in strict mode: they cannot renegotiate once opened.
			if (query === undefined || (context.stream && !strict)) return next(payload);

			const sha256Hash = strict
				? await hash(query)
				: supported
					? // A failing hash (e.g. no `crypto.subtle` on insecure origins) falls back to sending the full document.
						await hash(query).catch(ignoreError)
					: undefined;

			if (sha256Hash === undefined) return next(payload);

			const extensions = { ...payload.extensions, persistedQuery: { version: 1, sha256Hash } };

			try {
				return await next({ variables, operationName, extensions });
			} catch (error) {
				const miss = getPersistedQueryMiss(error);

				// Trusted documents never reveal the document: an unknown hash is an error, not a negotiation.
				if (!miss || strict || context.stream) throw error;
				if (miss === "unsupported") supported = false;

				return next({
					query,
					variables,
					operationName,
					extensions: miss === "unsupported" ? undefined : extensions,
				});
			}
		},
	};
}
