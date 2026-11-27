import { z } from "zod"

export default ["Send a reminder", z.object({ to: z.string(), body: z.string() }), async () => {}]
