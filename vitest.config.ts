import { defineConfig } from "vitest/config";

export default defineConfig({
	// Solid's default export is its server build (no reactivity): tests run the browser one.
	resolve: { alias: [{ find: /^solid-js$/, replacement: "solid-js/dist/solid.js" }] },
	test: {
		include: ["src/**/*.test.{ts,tsx}"],
		typecheck: { enabled: true, include: ["src/**/*.test-d.ts"] },
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-d.ts", "src/**/*.helpers.ts", "src/index.ts", "src/types.ts"],
			thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
		},
	},
});
