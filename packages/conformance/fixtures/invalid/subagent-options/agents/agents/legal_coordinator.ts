// Every option of subagents.md:12-30 with a legal value, in both forms of immediate.
export default {
  name: "legal_coordinator",
  sideA: {
    prompt: "coordinator",
    subagents: [
      {
        agent: "helper",
        as: "full_helper",
        description: "Asks the helper",
        maxInstances: 2,
        immediate: { nameEnv: "HELPER_NAME", descriptionEnv: "HELPER_DESCRIPTION", scopedEnv: ["HELPER_KEY"] },
        blocking: true,
        parentCommunication: "explicit",
        scopedEnv: ["HELPER_KEY"],
        initUserMessageProperty: "request",
        initAttachmentsProperty: "files",
        initAgentNameProperty: "title",
        optional: "HELPER_ENABLED",
        hidden: false,
      },
      { agent: "helper", as: "eager_helper", immediate: true, blocking: false, parentCommunication: "implicit" },
      { agent: "helper", as: "hidden_helper", hidden: true, immediate: false, scopedEnv: [] },
    ],
  },
  sideB: { human: true },
}
