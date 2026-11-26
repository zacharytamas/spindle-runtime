import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Bun's resolver applies the `bun` condition, but Vite resolves with its own list, so `#platform` needs it added under Bun.
const runtimeConditions = process.versions.bun === undefined ? [] : ["bun"];

export default defineConfig({
	ssr: {
		resolve: {
			conditions: ["spindle-source", ...runtimeConditions, ...defaultServerConditions],
		},
	},
	test: {
		include: ["packages/*/test/**/*.test.ts"],
	},
});
