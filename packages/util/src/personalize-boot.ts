import { Context, Effect, Option } from "effect"

export interface BootState {
  retry: Effect.Effect<void>
  release: Effect.Effect<void>
}
export class PersonalizeBoot extends Context.Service<PersonalizeBoot, BootState>()("@personalize/Boot") {}

export const updateBoot = (kind: "retry" | "release") => Effect.serviceOption(PersonalizeBoot).pipe(
  Effect.flatMap((state) => Option.isSome(state) ? state.value[kind] : Effect.void),
)

export function sqliteBusy(input: unknown): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === null || value === undefined || seen.has(value)) return false
    seen.add(value)
    if (typeof value === "string") return /SQLITE_(?:BUSY|LOCKED)|database (?:is )?(?:locked|busy)/i.test(value)
    if (typeof value !== "object") return false
    const record = value as Record<string, unknown>
    if ([record.message, record.code, record.errno].some((part) => typeof part === "string" && visit(part))) return true
    return [record.cause, record.error, record.reason, record.reasons, record.left, record.right]
      .some((part) => Array.isArray(part) ? part.some(visit) : visit(part))
  }
  return visit(input)
}
