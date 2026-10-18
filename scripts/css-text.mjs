import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { transform } from "esbuild";

/**
 * An esbuild plugin loading `*.css?raw` imports as minified text (the devtools ship their stylesheet as a string).
 *
 * @type {import("esbuild").Plugin}
 */
export const cssText = {
	name: "css-text",
	setup(build) {
		build.onResolve({ filter: /\.css\?raw$/ }, function locate(args) {
			// The suffix stays on the path: other CSS loaders (tsup's) only claim paths ending in `.css`.
			return { path: resolve(args.resolveDir, args.path), namespace: "css-text" };
		});
		build.onLoad({ filter: /.*/, namespace: "css-text" }, async function load(args) {
			const { code } = await transform(await readFile(args.path.slice(0, -"?raw".length), "utf8"), {
				loader: "css",
				minify: true,
			});

			return { contents: code.trim(), loader: "text" };
		});
	},
};
