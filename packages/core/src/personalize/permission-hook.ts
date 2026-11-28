import { Context } from "effect"
import type { Permission } from "../permission.js"

export interface Invocation {
  readonly input: Permission.AssertInput
  readonly consume: boolean
}

/** Scoped to an individual stock call, never shared between concurrent fibers. */
export const CurrentPermission = Context.Reference<Invocation | undefined>("@personalize/PermissionInvocation", {
  defaultValue: () => undefined,
})
