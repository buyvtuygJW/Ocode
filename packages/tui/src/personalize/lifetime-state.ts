import { WakeGate } from "@opencode/util/personalize-lifetime"
import { sleptAfter } from "@opencode/util/personalize-lifetime-store"

export const wake = new WakeGate(sleptAfter)
