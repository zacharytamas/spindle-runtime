// biome-ignore-all format: the file is the spec's Hello, World example, kept as written
// agents/prompts/assistant.ts
import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'assistant',
  toolDescription: 'General-purpose assistant',
  model: 'conversational',
  prompt: 'You are a helpful assistant. Be concise and accurate.',
  includeChat: true,
});
