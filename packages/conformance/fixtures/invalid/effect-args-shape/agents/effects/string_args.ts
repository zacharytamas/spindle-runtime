import { z } from "zod"

// effects.md:95-101 and ToolArgs in @standardagents/spec (index.d.ts:275-282): a Zod string schema is not ToolArgs.
export default ["Send a reminder", z.string(), async () => {}]
