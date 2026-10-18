import { rethrowNetworkFailure } from "./retry";
import type { OperationContext, Plugin } from "./types";
import { ignoreError, onAbort } from "./utils";

/**
 * A parsed Server-Sent Event.
 */
export interface ServerSentEvent {
	/** Event type. Defaults to `message`. */
	event: string;
	/** Event payload (multi-line `data` fields joined by `\n`) */
	data: string;
}

/**
 * Reads a `text/event-stream` body as a sequence of events, per the WHATWG SSE parsing rules
 * (any line ending, multi-line data, comments). Cancels the stream when the consumer stops early.
 *
 * @param stream - The response body
 * @param signal - Cancels the stream when aborted, even if the body is not tied to a fetch
 * @yields Every dispatched event
 */
export async function* readServerSentEvents(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	for await (const [block] of readDelimited(stream, "\n\n", signal)) {
		const event = parseEvent(block);

		if (event) yield event;
	}
}

/**
 * Splits a text stream on a delimiter, normalizing line endings to LF. Linear in the body size: each chunk is
 * normalized and searched once (plus a small overlap), and chunks are only joined once a delimiter is found.
 * Text after the last delimiter is dropped when the stream ends. Cancels the stream when the consumer stops early.
 *
 * @param stream - The response body
 * @param delimiter - The delimiter (at least two characters, in normalized form)
 * @param signal - Cancels the stream when aborted, even if the body is not tied to a fetch
 * @param initial - Text considered to precede the body
 * @yields Each delimited segment, with the (possibly partial) text received after its delimiter
 */
export async function* readDelimited(
	stream: ReadableStream<Uint8Array>,
	delimiter: string,
	signal?: AbortSignal,
	initial = "",
): AsyncGenerator<[segment: string, rest: string]> {
	const reader = getReader(stream);
	const release = onAbort(signal, function cancel(): void {
		reader.cancel(signal?.reason).catch(ignoreError);
	});
	const decoder = new TextDecoder();
	const overlap = delimiter.length - 1;
	let chunks = [initial];
	let tail = initial.slice(-overlap);
	let carry = false;
	let finished = false;

	try {
		while (!finished) {
			// A body failing mid-read (connection reset) is a network failure, retryable like one.
			const { done, value } = await reader.read().catch(rethrowNetworkFailure);
			// A trailing CR may be the first half of a CRLF pair: it is held back until the next chunk.
			let text: string = (carry ? "\r" : "") + decoder.decode(value, { stream: !done });

			finished = done;
			carry = !done && text.endsWith("\r");
			text = (carry ? text.slice(0, -1) : text).replace(/\r\n?/g, "\n");

			if ((tail + text).indexOf(delimiter) === -1) {
				chunks.push(text);
				tail = (tail + text).slice(-overlap);
				continue;
			}

			let buffer = chunks.join("") + text;
			let index = buffer.indexOf(delimiter);

			while (index !== -1) {
				const rest = buffer.slice(index + delimiter.length);

				yield [buffer.slice(0, index), rest];

				buffer = rest;
				index = buffer.indexOf(delimiter);
			}

			chunks = [buffer];
			tail = buffer.slice(-overlap);
		}
	} finally {
		release();

		if (!finished) await reader.cancel().catch(ignoreError);

		reader.releaseLock();
	}
}

/**
 * Parses one event block.
 *
 * @param block - Lines between two blank lines
 * @returns The event, or `undefined` for comment-only or empty blocks
 */
function parseEvent(block: string): ServerSentEvent | undefined {
	let event: string | undefined;
	const data: string[] = [];

	for (const line of block.split("\n")) {
		if (!line || line.startsWith(":")) continue;

		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}

	if (event === undefined && data.length === 0) return undefined;

	return { event: event || "message", data: data.join("\n") };
}

/**
 * Gets a reader for a response body. node-fetch (and cross-fetch on Node) expose a Node.js `Readable`, which is
 * async-iterable but has no `getReader`.
 *
 * @param stream - The response body
 * @returns A reader (the subset this module uses)
 */
function getReader(
	stream: ReadableStream<Uint8Array>,
): Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> {
	if (typeof stream.getReader === "function") return stream.getReader();

	const iterator = (stream as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();

	return {
		read: function read(): Promise<ReadableStreamReadResult<Uint8Array>> {
			return iterator.next() as Promise<ReadableStreamReadResult<Uint8Array>>;
		},
		cancel: async function cancel(): Promise<void> {
			// Ending the iteration destroys the Node.js stream.
			await iterator.return?.();
		},
		releaseLock: function releaseLock(): void {},
	};
}

/**
 * Yields the data of SSE `next`/`message` events until `complete`.
 *
 * @param body - The response body
 * @param signal - The abort signal
 * @yields Each event payload
 */
async function* readServerSentEventData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
	for await (const event of readServerSentEvents(body, signal)) {
		if (event.event === "complete") return;
		if ((event.event === "next" || event.event === "message") && event.data) yield event.data;
	}
}

/**
 * Streams over Server-Sent Events ([GraphQL over SSE](https://github.com/enisdenjo/graphql-sse), "distinct
 * connections" mode): `subscribe()` asks for `text/event-stream` and reads each event as a result. Built into the
 * `lumenql` entry. Not needed when every subscription goes through a `subscriptionTransport` (e.g. WebSocket).
 *
 * @returns The plugin
 */
export function sse(): Plugin {
	return {
		name: "sse",
		headers(headers: Headers, context: OperationContext): void {
			if (context.stream) headers.set("Accept", "text/event-stream");
		},
		decode(response: Response, signal: AbortSignal): AsyncIterable<string> | undefined {
			// Media types are case-insensitive.
			const mediaType = response.headers.get("Content-Type")?.toLowerCase() ?? "";

			return mediaType.includes("text/event-stream") ? readServerSentEventData(response.body!, signal) : undefined;
		},
	};
}
