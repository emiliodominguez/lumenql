import type { GraphQLFormattedError } from "./types";
import { isObject } from "./utils";

/**
 * Details attached to a {@link ClientError}.
 */
export interface ClientErrorDetails {
	/** HTTP status code of the response, or `0` for non-HTTP transports (e.g. WebSocket) */
	status: number;
	/** GraphQL errors returned by the server, if any */
	errors?: ReadonlyArray<GraphQLFormattedError> | undefined;
	/** Partial data returned alongside the errors, if any */
	data?: unknown | undefined;
	/** The raw fetch Response, absent for non-HTTP transports */
	response?: Response | undefined;
	/** Underlying error (e.g. a JSON parse failure) */
	cause?: unknown | undefined;
}

/**
 * Thrown when the server answers with a non-2xx status, GraphQL errors, an unparseable body or no data.
 * Transport failures (DNS, CORS, offline) and aborts are not wrapped and propagate as thrown by `fetch`.
 */
export class ClientError extends Error {
	/** HTTP status code of the response, or `0` for non-HTTP transports (e.g. WebSocket) */
	readonly status: number;

	/** GraphQL errors returned by the server. Empty when the failure is not GraphQL-level. */
	readonly errors: ReadonlyArray<GraphQLFormattedError>;

	/** Partial data returned alongside the errors, if any */
	readonly data: unknown;

	/** The raw fetch Response, absent for non-HTTP transports */
	readonly response: Response | undefined;

	/**
	 * @param message - Human-readable summary
	 * @param details - Response details
	 */
	constructor(message: string, details: ClientErrorDetails) {
		super(message, { cause: details.cause });
		this.name = "ClientError";
		this.status = details.status;
		this.errors = details.errors ?? [];
		this.data = details.data;
		this.response = details.response;
	}
}

/**
 * Type guard for {@link ClientError}. Survives duplicated module instances, unlike `instanceof`.
 *
 * @param error - Any thrown value
 * @returns `true` when the value is a ClientError
 */
export function isClientError(error: unknown): error is ClientError {
	// Duck-typed across copies of the library (e.g. ESM and CJS builds), but never another library's `ClientError`.
	return (
		error instanceof ClientError ||
		(error instanceof Error && error.name === "ClientError" && Array.isArray((error as ClientError).errors))
	);
}

/**
 * Normalizes the `errors` of a response, which a buggy or hostile server may send as a single object, a string or
 * a list with non-object entries.
 *
 * @param errors - The raw `errors` value
 * @returns Well-formed errors (empty when there are none)
 */
export function normalizeErrors(errors: unknown): GraphQLFormattedError[] {
	if (errors === undefined || errors === null) return [];

	return (Array.isArray(errors) ? errors : [errors]).map(toFormattedError);
}

/**
 * Normalizes one GraphQL error.
 *
 * @param error - The raw error
 * @returns The error, or a placeholder carrying its text
 */
function toFormattedError(error: unknown): GraphQLFormattedError {
	if (isObject(error) && typeof error.message === "string") return error as unknown as GraphQLFormattedError;

	return { message: typeof error === "string" ? error : "Unknown error" };
}
