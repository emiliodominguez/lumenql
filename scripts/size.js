import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { buildSync, transformSync } from "esbuild";

/**
 * Maximum min+gzip size of a typical app import from the batteries-included entry (`Client` + `MemoryCache`,
 * tree-shaken), in bytes. CI fails above it.
 */
const BUDGET = 11.75 * 1024;

/**
 * Tree-shaken imports measured against a budget (min+gzip bytes), in addition to the full bundles.
 */
const IMPORTS = [
	{ label: "Client + MemoryCache", code: 'import { Client, MemoryCache } from "./dist/index.js";', budget: BUDGET },
	{
		label: "core: Client + MemoryCache",
		code: 'import { Client, MemoryCache } from "./dist/core.js";',
		budget: 9.25 * 1024,
	},
	{ label: "plugin: upload", code: 'import { upload } from "./dist/upload.js";', budget: 1.75 * 1024 },
	{
		label: "plugin: persistedQueries",
		code: 'import { persistedQueries } from "./dist/persisted.js";',
		budget: 1.75 * 1024,
	},
	{ label: "plugin: incremental", code: 'import { incremental } from "./dist/incremental.js";', budget: 1.75 * 1024 },
	{ label: "plugin: scalars", code: 'import { scalars } from "./dist/scalars.js";', budget: 1.75 * 1024 },
	{ label: "devtools", code: 'import { devtools } from "./dist/devtools.js";', budget: 7 * 1024 },
	{ label: "plugin: sse", code: 'import { sse } from "./dist/sse.js";', budget: 1.75 * 1024 },
];

/**
 * Prints minified, gzip and brotli sizes for the full bundles and for tree-shaken imports, and fails when an import
 * exceeds its budget.
 */
function main() {
	for (const file of ["dist/react.js", "dist/ws.js"]) {
		report(file, transformSync(readFileSync(file, "utf8"), { minify: true, loader: "js" }).code);
	}

	for (const { label, code, budget } of IMPORTS) {
		const { outputFiles } = buildSync({
			stdin: {
				contents: `${code} console.log(${code.match(/\{ (.+) \}/)[1]});`,
				resolveDir: process.cwd(),
				loader: "js",
			},
			bundle: true,
			minify: true,
			format: "esm",
			write: false,
			external: ["react"],
			logLevel: "error",
		});
		const gzip = report(label, outputFiles[0].text);

		if (gzip > budget) {
			console.error(`\nSize budget exceeded for ${label}: ${format(gzip)} > ${format(budget)} (min+gzip)`);
			process.exitCode = 1;
		}
	}
}

/**
 * Prints the sizes of a minified bundle.
 *
 * @param {string} label - Row label
 * @param {string} code - Minified code
 * @returns {number} The gzip size in bytes
 */
function report(label, code) {
	const minified = Buffer.from(code);
	const gzip = gzipSync(minified, { level: 9 }).length;

	console.log(
		[
			label.padEnd(22),
			`${format(minified.length)} min`,
			`${format(gzip)} gzip`,
			`${format(brotliCompressSync(minified).length)} brotli`,
		].join("  "),
	);

	return gzip;
}

/**
 * Formats a byte count as kilobytes.
 *
 * @param {number} bytes - Byte count
 * @returns {string} The formatted size
 */
function format(bytes) {
	return `${(bytes / 1024).toFixed(2)} kB`;
}

main();
