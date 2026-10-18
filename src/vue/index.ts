import {
	inject,
	onScopeDispose,
	readonly,
	shallowRef,
	toValue,
	watch,
	type App,
	type InjectionKey,
	type MaybeRefOrGetter,
	type ShallowRef,
} from "vue";
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
 * Where the client is provided.
 */
const CLIENT: InjectionKey<Client> = Symbol("lumenql");

/**
 * The state of a query, as refs.
 *
 * @template TData - The shape of the `data` field
 */
export interface UseQueryResult<TData> {
	/** The latest data (kept while refetching and after errors) */
	data: Readonly<ShallowRef<TData | undefined>>;
	/** The error of the latest fetch */
	error: Readonly<ShallowRef<unknown>>;
	/** Whether a fetch is in progress */
	loading: Readonly<ShallowRef<boolean>>;
	/** Refetches from the network. Never rejects: failures land in `error`. */
	refetch(): Promise<QueryState<TData>>;
	/** Fetches another page and merges it. Never rejects: failures land in `error`. */
	fetchMore(options: FetchMoreOptions<TData, unknown>): Promise<QueryState<TData>>;
}

/**
 * Options of {@link useQuery}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export type UseQueryOptions<TData, TVariables> = WithVariables<WatchOptions<TData, TVariables>, TVariables> & {
	/** Don't run the query (e.g. while a variable is missing) */
	skip?: boolean | undefined;
};

/**
 * The state of a mutation, as refs, with `mutate()`.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface UseMutationResult<TData, TVariables> {
	/** The latest call's data */
	data: Readonly<ShallowRef<TData | undefined>>;
	/** The latest call's error */
	error: Readonly<ShallowRef<unknown>>;
	/** Whether a call is in progress */
	loading: Readonly<ShallowRef<boolean>>;
	/** Runs the mutation. Rejects on failure (the error is also in `error`). */
	mutate(variables?: TVariables): Promise<TData>;
	/** Resets the state */
	reset(): void;
}

/**
 * The state of a subscription, as refs.
 *
 * @template TData - The shape of each `data` payload
 */
export interface UseSubscriptionResult<TData> {
	/** The latest result */
	data: Readonly<ShallowRef<TData | undefined>>;
	/** The failure that ended the stream, if any */
	error: Readonly<ShallowRef<unknown>>;
	/** Whether the stream is open */
	active: Readonly<ShallowRef<boolean>>;
}

/**
 * The Vue plugin providing a client to every component.
 *
 * @example
 * createApp(App).use(lumenql(client)).mount("#app");
 *
 * @param client - The client
 * @returns The plugin
 */
export function lumenql(client: Client): { install(app: App): void } {
	return {
		install(app: App): void {
			app.provide(CLIENT, client);
		},
	};
}

/**
 * Returns the client provided by {@link lumenql}.
 *
 * @returns The client
 * @throws {Error} When no client was provided
 */
export function useClient(): Client {
	const client = inject(CLIENT, null);

	if (!client) throw new Error("No lumenql client: install it with `app.use(lumenql(client))`.");

	return client;
}

/**
 * A live query: refs that follow the cache (invalidations, writes, polling) while the component is mounted. Options
 * may be a ref or a getter: the query switches when they change (same variables, same query).
 *
 * @example
 * const { data, loading } = useQuery(() => ({ key: ["user", props.id], query: USER, variables: { id: props.id } }));
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param options - The query and watch options, or a ref or getter returning them
 * @returns The query state
 */
export function useQuery<TData = unknown, TVariables extends object = Record<string, unknown>>(
	options: MaybeRefOrGetter<UseQueryOptions<TData, TVariables>>,
): UseQueryResult<TData> {
	const client = useClient();
	const data = shallowRef<TData | undefined>(undefined);
	const error = shallowRef<unknown>(undefined);
	const loading = shallowRef(false);
	let ref: QueryRef<TData, TVariables> | undefined;

	watch(
		function identity(): string {
			const { skip, query, ...rest } = toValue(options);

			return skip ? "" : stableStringify([String(query), rest]);
		},
		function follow(key: string, _previous: string | undefined, onCleanup: (cleanup: () => void) => void): void {
			ref = undefined;

			if (!key) {
				data.value = undefined;
				error.value = undefined;
				loading.value = false;
				return;
			}

			const { skip: _skip, ...watchOptions } = toValue(options);
			const current = client.watch<TData, TVariables>(
				watchOptions as WithVariables<WatchOptions<TData, TVariables>, TVariables>,
			);

			ref = current;

			// On the server nothing ever unsubscribes (before Vue 3.5, cleanups of setup watchers are dropped there):
			// render what the cache holds, without activating the query.
			if (typeof window === "undefined") {
				const state = current.getState();

				data.value = state.data;
				error.value = state.error;
				loading.value = state.loading;
				return;
			}

			onCleanup(
				current.subscribe(function update(state: QueryState<TData>): void {
					data.value = state.data;
					error.value = state.error;
					loading.value = state.loading;
				}),
			);
		},
		{ immediate: true },
	);

	return {
		data: readonly(data),
		error: readonly(error),
		loading: readonly(loading),
		refetch(): Promise<QueryState<TData>> {
			return ref ? ref.refetch() : Promise.resolve({ data: undefined, error: undefined, loading: false });
		},
		fetchMore(fetchOptions: FetchMoreOptions<TData, unknown>): Promise<QueryState<TData>> {
			return ref
				? ref.fetchMore(fetchOptions as FetchMoreOptions<TData, TVariables>)
				: Promise.resolve({ data: undefined, error: undefined, loading: false });
		},
	} as UseQueryResult<TData>;
}

/**
 * A mutation with its latest call's state as refs.
 *
 * @example
 * const { mutate, loading } = useMutation(ADD_TODO, { invalidates: [["todos"]] });
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param document - The mutation document
 * @param options - Request options for every call
 * @returns The mutation state and `mutate()`
 */
export function useMutation<TData = unknown, TVariables extends object = Record<string, unknown>>(
	document: string | TypedDocumentString<TData, TVariables>,
	options?: Omit<RequestOptions<TData, TVariables>, "query" | "variables">,
): UseMutationResult<TData, TVariables> {
	const client = useClient();
	const data = shallowRef<TData | undefined>(undefined);
	const error = shallowRef<unknown>(undefined);
	const loading = shallowRef(false);
	let latest = 0;

	return {
		data: readonly(data),
		error: readonly(error),
		loading: readonly(loading),
		async mutate(variables?: TVariables): Promise<TData> {
			const call = ++latest;

			error.value = undefined;
			loading.value = true;

			try {
				const result = await client.gql<TData, TVariables>({
					...options,
					query: document,
					variables,
				} as WithVariables<RequestOptions<TData, TVariables>, TVariables>);

				if (call === latest) {
					data.value = result;
					loading.value = false;
				}

				return result;
			} catch (caught) {
				if (call === latest) {
					data.value = undefined;
					error.value = caught;
					loading.value = false;
				}

				throw caught;
			}
		},
		reset(): void {
			latest++;
			data.value = undefined;
			error.value = undefined;
			loading.value = false;
		},
	} as UseMutationResult<TData, TVariables>;
}

/**
 * A subscription whose stream is open while the component is mounted, reopened when the options change.
 *
 * @example
 * const { data } = useSubscription(() => ({ query: ON_MESSAGE, variables: { room: props.room } }));
 *
 * @template TData - The shape of each `data` payload
 * @template TVariables - The shape of the operation variables
 * @param options - The subscription options (`signal` is managed), or a ref or getter returning them
 * @returns The subscription state
 */
export function useSubscription<TData = unknown, TVariables extends object = Record<string, unknown>>(
	options: MaybeRefOrGetter<WithVariables<Omit<SubscribeOptions<TData, TVariables>, "signal">, TVariables>>,
): UseSubscriptionResult<TData> {
	const client = useClient();
	const data = shallowRef<TData | undefined>(undefined);
	const error = shallowRef<unknown>(undefined);
	const active = shallowRef(false);

	watch(
		function identity(): string {
			const { query, ...rest } = toValue(options);

			return stableStringify([String(query), rest]);
		},
		function open(_key: string, _previous: string | undefined, onCleanup: (cleanup: () => void) => void): void {
			// Payloads of other variables never show as this stream's.
			data.value = undefined;
			error.value = undefined;

			// Streams never open on the server: nothing would close them (see `useQuery`).
			if (typeof window === "undefined") return;

			const controller = new AbortController();

			onCleanup(function close(): void {
				controller.abort();
			});
			active.value = true;

			void (async function consume(): Promise<void> {
				try {
					for await (const next of client.subscribe<TData, TVariables>({
						...toValue(options),
						signal: controller.signal,
					} as WithVariables<SubscribeOptions<TData, TVariables>, TVariables>)) {
						data.value = next;
					}
				} catch (caught) {
					if (!controller.signal.aborted) error.value = caught;
				} finally {
					if (!controller.signal.aborted) active.value = false;
				}
			})();
		},
		{ immediate: true },
	);

	onScopeDispose(function stop(): void {
		active.value = false;
	});

	return { data: readonly(data), error: readonly(error), active: readonly(active) } as UseSubscriptionResult<TData>;
}
