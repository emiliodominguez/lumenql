import type { Client } from "../core";
import type { QueryRef } from "../query-ref";
import type {
	QueryState,
	RequestOptions,
	SubscribeOptions,
	TypedDocumentString,
	WatchOptions,
	WithVariables,
} from "../types";

/**
 * A Svelte readable store: `subscribe` calls `run` synchronously with the current value.
 *
 * @template T - The value type
 */
export interface Readable<T> {
	/**
	 * Subscribes to the value.
	 *
	 * @param run - Called with the current value, then with every change
	 * @returns Unsubscribes
	 */
	subscribe(run: (value: T) => void): () => void;
}

/**
 * A live query store. Use it as `$todos` in components; it fetches while subscribed.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export type QueryStore<TData, TVariables> = QueryRef<TData, TVariables>;

/**
 * A mutation store: its value is the latest call's state.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface MutationStore<TData, TVariables> extends Readable<QueryState<TData>> {
	/**
	 * Runs the mutation. Rejects on failure (the error is also in the store).
	 *
	 * @param variables - The operation variables
	 * @returns The `data` field
	 */
	mutate(variables?: TVariables): Promise<TData>;
	/** Resets the store to its idle state */
	reset(): void;
}

/**
 * The state of a subscription store.
 *
 * @template TData - The shape of the `data` field
 */
export interface SubscriptionState<TData> {
	/** The latest result */
	data: TData | undefined;
	/** The failure that ended the stream, if any */
	error: unknown;
	/** Whether the stream is open */
	active: boolean;
}

/**
 * The idle state of a mutation.
 */
const IDLE: QueryState<never> = Object.freeze({ data: undefined, error: undefined, loading: false });

/**
 * Creates a minimal writable value with Svelte store semantics.
 *
 * @template T - The value type
 * @param initial - The initial value
 * @param start - Called when the first subscriber arrives; returns the function called when the last one leaves
 * @returns The store and its setter
 */
function createStore<T>(initial: T, start?: (set: (value: T) => void) => () => void) {
	const runs = new Set<(value: T) => void>();
	let value = initial;
	let stop: (() => void) | undefined;

	/**
	 * Sets the value and notifies subscribers.
	 *
	 * @param next - The new value
	 */
	function set(next: T): void {
		value = next;
		for (const run of [...runs]) run(value);
	}

	return {
		set,
		get(): T {
			return value;
		},
		subscribe(run: (value: T) => void): () => void {
			runs.add(run);
			run(value);
			if (runs.size === 1 && start) stop = start(set);

			return function unsubscribe(): void {
				if (!runs.delete(run) || runs.size > 0) return;

				stop?.();
				stop = undefined;
			};
		},
	};
}

/**
 * A live query as a Svelte store: `$todos.data`, `$todos.loading`, `$todos.error`. It fetches while subscribed and
 * stays in sync with the cache (invalidations, writes, polling). `todos.refetch()` and `todos.fetchMore()` work too.
 *
 * @example
 * const todos = query(client, { key: ["todos"], query: TODOS });
 * // {#each $todos.data?.todos ?? [] as todo}…{/each}
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param client - The client
 * @param options - The query and watch options
 * @returns The store
 */
export function query<TData = unknown, TVariables extends object = Record<string, unknown>>(
	client: Client,
	options: WithVariables<WatchOptions<TData, TVariables>, TVariables>,
): QueryStore<TData, TVariables> {
	return client.watch<TData, TVariables>(options);
}

/**
 * A mutation as a Svelte store of its latest call's state, with `mutate()` and `reset()`.
 *
 * @example
 * const addTodo = mutation(client, ADD_TODO, { invalidates: [["todos"]] });
 * // <button on:click={() => addTodo.mutate({ title })} disabled={$addTodo.loading}>Add</button>
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param client - The client
 * @param document - The mutation document
 * @param options - Request options for every call
 * @returns The store
 */
export function mutation<TData = unknown, TVariables extends object = Record<string, unknown>>(
	client: Client,
	document: string | TypedDocumentString<TData, TVariables>,
	options?: Omit<RequestOptions<TData, TVariables>, "query" | "variables">,
): MutationStore<TData, TVariables> {
	const store = createStore<QueryState<TData>>(IDLE);
	let latest = 0;

	return {
		subscribe: store.subscribe,
		async mutate(variables?: TVariables): Promise<TData> {
			const call = ++latest;

			store.set({ data: store.get().data, error: undefined, loading: true });

			try {
				const data = await client.gql<TData, TVariables>({ ...options, query: document, variables } as WithVariables<
					RequestOptions<TData, TVariables>,
					TVariables
				>);

				if (call === latest) store.set({ data, error: undefined, loading: false });

				return data;
			} catch (error) {
				if (call === latest) store.set({ data: undefined, error, loading: false });

				throw error;
			}
		},
		reset(): void {
			latest++;
			store.set(IDLE);
		},
	};
}

/**
 * A subscription as a Svelte store: the stream opens with the first subscriber and closes with the last one.
 *
 * @example
 * const messages = subscription(client, { query: ON_MESSAGE });
 * // {#if $messages.data}{$messages.data.messageAdded.text}{/if}
 *
 * @template TData - The shape of each `data` payload
 * @template TVariables - The shape of the operation variables
 * @param client - The client
 * @param options - The subscription options (`signal` is managed by the store)
 * @returns The store
 */
export function subscription<TData = unknown, TVariables extends object = Record<string, unknown>>(
	client: Client,
	options: WithVariables<Omit<SubscribeOptions<TData, TVariables>, "signal">, TVariables>,
): Readable<SubscriptionState<TData>> {
	const store = createStore<SubscriptionState<TData>>(
		{ data: undefined, error: undefined, active: false },
		function open(set: (value: SubscriptionState<TData>) => void): () => void {
			const controller = new AbortController();
			let data: TData | undefined;

			set({ data: undefined, error: undefined, active: true });
			void (async function consume(): Promise<void> {
				try {
					for await (const next of client.subscribe<TData, TVariables>({
						...options,
						signal: controller.signal,
					} as WithVariables<SubscribeOptions<TData, TVariables>, TVariables>)) {
						data = next;
						set({ data, error: undefined, active: true });
					}

					if (!controller.signal.aborted) set({ data, error: undefined, active: false });
				} catch (error) {
					if (!controller.signal.aborted) set({ data, error, active: false });
				}
			})();

			return function close(): void {
				controller.abort();
			};
		},
	);

	return { subscribe: store.subscribe };
}
