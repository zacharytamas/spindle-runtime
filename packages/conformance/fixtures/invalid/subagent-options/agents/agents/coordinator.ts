// Each relationship below is legal except for one option, whose type subagents.md:12-30 declares
// (the SubagentRelationship interface; the same types are in SubagentRelationship of @standardagents/spec).
export default {
  name: "coordinator",
  sideA: {
    prompt: "coordinator",
    subagents: [
      // subagents.md:15 description?: string
      { agent: "helper", as: "bad_description", description: 5 },
      // subagents.md:17 immediate?: boolean | { ... }
      { agent: "helper", as: "bad_immediate", immediate: "now" },
      // subagents.md:18 immediate.nameEnv?: string
      { agent: "helper", as: "bad_name_env", immediate: { nameEnv: 7 } },
      // subagents.md:20 immediate.scopedEnv?: string[]
      { agent: "helper", as: "bad_immediate_scoped_env", immediate: { scopedEnv: "HELPER_KEY" } },
      // subagents.md:22 blocking?: boolean
      { agent: "helper", as: "bad_blocking", blocking: "yes" },
      // subagents.md:23 parentCommunication?: 'implicit' | 'explicit'
      { agent: "helper", as: "bad_parent_communication", parentCommunication: "sometimes" },
      // subagents.md:24 scopedEnv?: string[]
      { agent: "helper", as: "bad_scoped_env", scopedEnv: "HELPER_KEY" },
      // subagents.md:25 initUserMessageProperty?: string
      { agent: "helper", as: "bad_init_user_message", initUserMessageProperty: 1 },
      // subagents.md:26 initAttachmentsProperty?: string
      { agent: "helper", as: "bad_init_attachments", initAttachmentsProperty: ["files"] },
      // subagents.md:27 initAgentNameProperty?: string
      { agent: "helper", as: "bad_init_agent_name", initAgentNameProperty: false },
      // subagents.md:28 optional?: string, the name of an environment flag
      { agent: "helper", as: "bad_optional", optional: true },
      // subagents.md:29 hidden?: boolean
      { agent: "helper", as: "bad_hidden", hidden: "true" },
    ],
  },
  sideB: { human: true },
}
