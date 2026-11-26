import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const runtime = process.versions.bun === undefined ? "node" : "bun";

export default defineConfig({
	ssr: {
		resolve: {
			// Bun's resolver applies the `bun` condition, but Vite resolves with its own list.
			conditions: ["spindle-source", ...(runtime === "bun" ? ["bun"] : []), ...defaultServerConditions],
		},
	},
	test: {
		name: runtime,
		include: ["packages/*/test/**/*.test.ts"],
	},
});
