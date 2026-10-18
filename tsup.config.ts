import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		core: "src/entries/core.ts",
		upload: "src/entries/upload.ts",
		persisted: "src/entries/persisted.ts",
		incremental: "src/entries/incremental.ts",
		sse: "src/entries/sse.ts",
		scalars: "src/entries/scalars.ts",
		react: "src/react/index.ts",
		ws: "src/ws/index.ts",
	},
	format: ["esm", "cjs"],
	target: "es2022",
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	external: ["react"],
});
