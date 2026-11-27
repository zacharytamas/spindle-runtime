import { defineTool } from "@standardagents/spec"

export default defineTool({
  description: "Returns the endpoint key and a short token",
  variables: [{ name: "SHORT_TOKEN", type: "secret", required: true, description: "A short token" }],
  execute: async (state) => ({
    status: "success",
    result: `key ${await state.env("SPINDLE_TEST_API_KEY")} token ${await state.env("SHORT_TOKEN")}`,
  }),
})
