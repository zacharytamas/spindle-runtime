import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "forecaster",
  toolDescription: "Answers weather questions with a tool",
  model: "lane",
  prompt:
    "You answer questions about the weather. Always call get_weather for the city first, then answer in one sentence that quotes the forecast.",
  tools: ["get_weather"],
})
