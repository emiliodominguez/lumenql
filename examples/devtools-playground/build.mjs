// Builds the self-contained devtools playground page: `node examples/devtools-playground/build.mjs [output.html]`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2] ?? join(here, "playground.html");
const { outputFiles } = buildSync({
	entryPoints: [join(here, "main.ts")],
	bundle: true,
	minify: true,
	format: "iife",
	target: "es2022",
	write: false,
});
const template = readFileSync(join(here, "template.html"), "utf8");

writeFileSync(output, template.replace("/*BUNDLE*/", outputFiles[0].text.replaceAll("</script", "<\\/script")));
console.log(`Wrote ${output}`);
