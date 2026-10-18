import { Client as CoreClient } from "./core";
import { incremental } from "./incremental";
import { logger } from "./logger";
import { persistedQueries } from "./persisted";
import { sse } from "./sse";
import type { ClientConfiguration, Plugin } from "./types";
import { upload } from "./upload";

/**
 * Plugins this entry installs itself, rebuilt from the options for every client (including `extend()`ed ones).
 */
const builtIns = new WeakSet<Plugin>();

/**
 * Creates a built-in plugin and remembers it as such.
 *
 * @param plugin - The plugin
 * @returns The same plugin
 */
function builtIn(plugin: Plugin): Plugin {
	builtIns.add(plugin);

	return plugin;
}

/**
 * The plugins of a client of this entry: the caller's own first (a plugin of the same name replaces a built-in one),
 * then uploads, persisted queries (when `persistedQueries` is set), SSE, incremental delivery and the logger (when
 * `debug` is set).
 *
 * @param configuration - The client configuration
 * @returns The plugins
 */
function withBuiltIns(configuration: ClientConfiguration): Plugin[] {
	const own = (configuration.plugins ?? []).filter(function isOwn(plugin: Plugin): boolean {
		return !builtIns.has(plugin);
	});
	const { persistedQueries: apq, debug } = configuration;

	return [
		...own,
		builtIn(upload()),
		...(apq ? [builtIn(persistedQueries(apq))] : []),
		builtIn(sse()),
		builtIn(incremental()),
		...(debug ? [builtIn(logger())] : []),
	];
}

/**
 * Lightweight, zero-dependency GraphQL client with caching, deduplication, retries, middleware, persisted queries,
 * uploads, incremental delivery, SSE subscriptions, live queries, timeouts and typed errors.
 *
 * This is the batteries-included client: `lumenql/core` exports the same client without the built-in plugins, for
 * apps that pick only what they use.
 */
export class Client extends CoreClient {
	/**
	 * @param configuration - Configuration for the client
	 */
	constructor(configuration: ClientConfiguration) {
		super({ ...configuration, plugins: withBuiltIns(configuration) });
	}
}
