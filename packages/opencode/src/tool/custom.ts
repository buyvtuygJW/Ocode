import { Effect } from "effect"
import * as Tool from "./tool"
import { DistillTool } from "./distill"
import { ScheduleTool } from "./schedule"
import { CouncilTool } from "./council"

// Personalization tools compiled into the binary (distill / schedule / council).
// Isolated in ONE owned file so the upstream registry.ts patch stays a fixed
// 2-line delta -- adding a tool changes only this file, never the registry hunk.
export const builtin = Effect.gen(function* () {
  const distilltool = yield* DistillTool
  const scheduletool = yield* ScheduleTool
  const counciltool = yield* CouncilTool
  return yield* Effect.all([Tool.init(distilltool), Tool.init(scheduletool), Tool.init(counciltool)])
})
