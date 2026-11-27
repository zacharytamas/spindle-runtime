import { defineModel, defineProvider, providerEnv } from "@standardagents/spec"
import { openaiCompatible } from "spindle-runtime"

const local = defineProvider({
  name: "spindle_test",
  baseProvider: openaiCompatible,
  config: {
    baseUrl: providerEnv("SPINDLE_TEST_BASE_URL", { valueType: "url", required: true }),
    apiKey: providerEnv("SPINDLE_TEST_API_KEY", { valueType: "secret" }),
  },
})

export default defineModel({
  name: "lane",
  provider: local,
  model: process.env.SPINDLE_TEST_MODEL ?? "claude-haiku-5-5",
})
