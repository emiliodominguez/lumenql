import { defineConfig } from "tsup";
import { cssText } from "./scripts/css-text.mjs";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		core: "src/entries/core.ts",
		upload: "src/entries/upload.ts",
		persisted: "src/entries/persisted.ts",
		incremental: "src/entries/incremental.ts",
		sse: "src/entries/sse.ts",
		scalars: "src/entries/scalars.ts",
		entities: "src/entries/entities.ts",
		devtools: "src/devtools/index.ts",
		react: "src/react/index.ts",
		svelte: "src/svelte/index.ts",
		vue: "src/vue/index.ts",
		solid: "src/solid/index.ts",
		ws: "src/ws/index.ts",
	},
	format: ["esm", "cjs"],
	target: "es2022",
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	external: ["react", "vue", "solid-js"],
	esbuildPlugins: [cssText],
});
