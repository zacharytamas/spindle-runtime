// biome-ignore-all format: the file is the spec's Hello, World example, kept as written
// agents/models/conversational.ts
import { defineModel } from '@standardagents/spec';
import openrouter from '../providers/spindle_test.ts';

export default defineModel({
  name: 'conversational',
  provider: openrouter,
  model: process.env.SPINDLE_TEST_MODEL ?? 'anthropic/claude-sonnet-5',
});
