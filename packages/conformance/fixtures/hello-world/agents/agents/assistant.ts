// biome-ignore-all format: the file is the spec's Hello, World example, kept as written
// agents/agents/assistant.ts
import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'assistant',
  sideA: {
    prompt: 'assistant',
    stopOnResponse: true,
  },
  sideB: { human: true },
});
