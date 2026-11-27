import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Get today's forecast for a city",
  args: z.object({ city: z.string().describe("The city name") }),
  execute: async (_state, { city }) => ({ status: "success", result: `${city}: light rain, 14 degrees Celsius` }),
})
