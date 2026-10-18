// The bare client: no built-in plugins. Add only what you use (`lumenql/upload`, `lumenql/persisted`...).
export { Client } from "../core";
export { MemoryCache, type MemoryCacheConfiguration } from "../cache/memory-cache";
export { StorageCache, type StorageCacheConfiguration, type StorageLike } from "../cache/storage-cache";
export { dedupeFragments, graphql, minify, type DocumentString } from "../document";
export { ClientError, isClientError, type ClientErrorDetails } from "../errors";
export { logger } from "../logger";
export { optimistic } from "../optimistic";
export { QueryRef, type QueryListener } from "../query-ref";
export { isRetryable } from "../retry";
export type {
	AuthTokenResolver,
	Cache,
	CacheKey,
	CacheTarget,
	ClientConfiguration,
	ClientEventListener,
	ClientEvents,
	FetchMoreOptions,
	FetchPolicy,
	GraphQLFormattedError,
	GraphQLResponse,
	DeepReadonly,
	HeadersLike,
	HeadersResolver,
	MaybePromise,
	Middleware,
	MiddlewareNext,
	OperationContext,
	OperationPayload,
	OperationType,
	OptimisticUpdate,
	PersistedQueriesOptions,
	Plugin,
	QueryState,
	RequestOptions,
	RequiredKeys,
	RetryOptions,
	StreamState,
	SubscribeOptions,
	SubscriptionRequest,
	SubscriptionTransport,
	TypedDocumentString,
	WatchOptions,
	WithSkippableVariables,
	WithVariables,
} from "../types";
