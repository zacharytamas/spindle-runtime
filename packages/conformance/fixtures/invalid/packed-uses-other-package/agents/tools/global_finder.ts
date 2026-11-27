// An unpacked tool belongs to no package, so Packaging's rule that a package includes its tool dependencies does not
// apply. Global code sees packed entry agents (Packaging, Visibility Rules), so this uses target is legal.
export default {
  description: "Asks the entry agent of standardagent-callee",
  execute: async () => ({ status: "success", result: "" }),
  uses: ["standardagent-callee/finder"],
}
