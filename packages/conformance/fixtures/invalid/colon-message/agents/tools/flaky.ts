// The error text of user code is a message, not a list of field issues. Only the definition helpers of
// @standardagents/spec, such as defineAgent, throw "<path>: <message>" lines (index.js defineAgent).
throw new Error("timeout: the upstream did not answer")
