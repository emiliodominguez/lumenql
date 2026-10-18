import {
	createContext,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	untrack,
	useContext,
	type Accessor,
} from "solid-js";
import type { Client } from "../core";
import type { QueryRef } from "../query-ref";
import type {
	FetchMoreOptions,
	QueryState,
	RequestOptions,
	SubscribeOptions,
	TypedDocumentString,
	WatchOptions,
	WithVariables,
} from "../types";
import { stableStringify } from "../utils";

/**
 * Provides a client to {@link createQuery}, {@link createMutation} and {@link createSubscription}.
 *
 * @example
 * <ClientContext.Provider value={client}><App /></ClientContext.Provider>
 */
export const ClientContext = createContext<Client>();

/**
 * Options of {@link createQuery}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export type CreateQueryOptions<TData, TVariables> = WithVariables<WatchOptions<TData, TVariables>, TVariables> & {
	/** Don't run the query (e.g. while a variable is missing) */
	skip?: boolean | undefined;
};

/**
 * A query's state accessor, with `refetch()` and `fetchMore()`.
 *
 * @template TData - The shape of the `data` field
 */
export interface QueryAccessor<TData> extends Accessor<QueryState<TData>> {
	/** Refetches from the network. Never rejects: failures land in `error`. */
	refetch(): Promise<QueryState<TData>>;
	/** Fetches another page and merges it. Never rejects: failures land in `error`. */
	fetchMore(options: FetchMoreOptions<TData, unknown>): Promise<QueryState<TData>>;
}

/**
 * The state of a subscription.
 *
 * @template TData - The shape of each `data` payload
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
 * The idle state of a query or mutation.
 */
const IDLE: QueryState<never> = Object.freeze({ data: undefined, error: undefined, loading: false });

/**
 * Returns the provided client, or the one passed explicitly.
 *
 * @param client - An explicit client
 * @returns The client
 * @throws {Error} When none is available
 */
export function useClient(client?: Client): Client {
	const resolved = client ?? useContext(ClientContext);

	if (!resolved) throw new Error("No lumenql client: provide one with <ClientContext.Provider value={client}>.");

	return resolved;
}

/**
 * A live query: a state accessor that follows the cache (invalidations, writes, polling) while its owner lives.
 * Options are an accessor: the query switches when they change (same variables, same query).
 *
 * @example
 * const user = createQuery(() => ({ key: ["user", props.id], query: USER, variables: { id: props.id } }));
 * // <Show when={user().data}>{(data) => data().user.name}</Show>
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param options - Returns the query and watch options
 * @param client - A client, instead of the provided one
 * @returns The state accessor
 */
export function createQuery<TData = unknown, TVariables extends object = Record<string, unknown>>(
	options: Accessor<CreateQueryOptions<TData, TVariables>>,
	client?: Client,
): QueryAccessor<TData> {
	const resolved = useClient(client);
	const [state, setState] = createSignal<QueryState<TData>>(IDLE, { equals: false });
	const identity = createMemo(function identify(): string {
		const { skip, query, ...rest } = options();

		return skip ? "" : stableStringify([String(query), rest]);
	});
	let ref: QueryRef<TData, TVariables> | undefined;

	createEffect(function follow(): void {
		ref = undefined;

		if (!identity()) {
			setState(IDLE);
			return;
		}

		// Only the identity is tracked: a new options object with the same query never resubscribes.
		const { skip: _skip, ...watchOptions } = untrack(options);
		const current = resolved.watch<TData, TVariables>(
			watchOptions as WithVariables<WatchOptions<TData, TVariables>, TVariables>,
		);

		ref = current;
		onCleanup(current.subscribe(setState));
	});

	return Object.assign(state, {
		refetch(): Promise<QueryState<TData>> {
			return ref ? ref.refetch() : Promise.resolve(IDLE);
		},
		fetchMore(fetchOptions: FetchMoreOptions<TData, unknown>): Promise<QueryState<TData>> {
			return ref ? ref.fetchMore(fetchOptions as FetchMoreOptions<TData, TVariables>) : Promise.resolve(IDLE);
		},
	});
}

/**
 * A mutation: its latest call's state accessor and `mutate()`.
 *
 * @example
 * const [state, addTodo] = createMutation(ADD_TODO, { invalidates: [["todos"]] });
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param document - The mutation document
 * @param options - Request options for every call
 * @param client - A client, instead of the provided one
 * @returns The state accessor and the mutate function (rejects on failure; the error is also in the state)
 */
export function createMutation<TData = unknown, TVariables extends object = Record<string, unknown>>(
	document: string | TypedDocumentString<TData, TVariables>,
	options?: Omit<RequestOptions<TData, TVariables>, "query" | "variables">,
	client?: Client,
): [Accessor<QueryState<TData>>, (variables?: TVariables) => Promise<TData>] {
	const resolved = useClient(client);
	const [state, setState] = createSignal<QueryState<TData>>(IDLE);
	let latest = 0;

	/**
	 * Runs the mutation.
	 *
	 * @param variables - The operation variables
	 * @returns The `data` field
	 */
	async function mutate(variables?: TVariables): Promise<TData> {
		const call = ++latest;

		setState({ data: state().data, error: undefined, loading: true });

		try {
			const data = await resolved.gql<TData, TVariables>({
				...options,
				query: document,
				variables,
			} as WithVariables<RequestOptions<TData, TVariables>, TVariables>);

			if (call === latest) setState({ data, error: undefined, loading: false });

			return data;
		} catch (error) {
			if (call === latest) setState({ data: undefined, error, loading: false });

			throw error;
		}
	}

	return [state, mutate];
}

/**
 * A subscription whose stream is open while its owner lives, reopened when the options change.
 *
 * @example
 * const messages = createSubscription(() => ({ query: ON_MESSAGE, variables: { room: props.room } }));
 *
 * @template TData - The shape of each `data` payload
 * @template TVariables - The shape of the operation variables
 * @param options - Returns the subscription options (`signal` is managed)
 * @param client - A client, instead of the provided one
 * @returns The state accessor
 */
export function createSubscription<TData = unknown, TVariables extends object = Record<string, unknown>>(
	options: Accessor<WithVariables<Omit<SubscribeOptions<TData, TVariables>, "signal">, TVariables>>,
	client?: Client,
): Accessor<SubscriptionState<TData>> {
	const resolved = useClient(client);
	const [state, setState] = createSignal<SubscriptionState<TData>>({ data: undefined, error: undefined, active: false });
	const identity = createMemo(function identify(): string {
		const { query, ...rest } = options();

		return stableStringify([String(query), rest]);
	});

	createEffect(function open(): void {
		identity();

		const controller = new AbortController();
		let data: TData | undefined;

		onCleanup(function close(): void {
			controller.abort();
		});
		setState({ data: undefined, error: undefined, active: true });

		void (async function consume(): Promise<void> {
			try {
				for await (const next of resolved.subscribe<TData, TVariables>({
					...untrack(options),
					signal: controller.signal,
				} as WithVariables<SubscribeOptions<TData, TVariables>, TVariables>)) {
					data = next;
					setState({ data, error: undefined, active: true });
				}

				if (!controller.signal.aborted) setState({ data, error: undefined, active: false });
			} catch (error) {
				if (!controller.signal.aborted) setState({ data, error, active: false });
			}
		})();
	});

	return state;
}
