import { defineProvider, providerEnv } from "@standardagents/spec"
import { openaiCompatible } from "spindle-runtime"

// Spindle ships no OpenRouter provider. This extension points the example's model at the endpoint of the live lanes.
export default defineProvider({
  name: "spindle_test",
  baseProvider: openaiCompatible,
  config: {
    baseUrl: providerEnv("SPINDLE_TEST_BASE_URL", { valueType: "url", required: true }),
    apiKey: providerEnv("SPINDLE_TEST_API_KEY", { valueType: "secret" }),
  },
})
