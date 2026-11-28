import { Effect, Option } from "effect"
import { HttpServer } from "effect/http"
import { PersonalizeBoot } from "@opencode/util/personalize-boot"
import { OPENCODE_VERSION } from "../version"

export function decorate(stock: typeof import("../services/service-registration")) {
  const register: typeof stock.register = (options) => Effect.gen(function* () {
    const boot = yield* Effect.serviceOption(PersonalizeBoot)
    // Publish before the stock registration becomes visible and before the
    // synchronous database bootstrap can block HTTP. Preserve the stock lease,
    // ownership monitor, shutdown, and returned cleanup without alteration.
    if (Option.isSome(boot)) yield* Effect.sync(() => boot.value.register?.({
      id: options.id, pid: process.pid, url: HttpServer.formatAddress(options.address),
      version: OPENCODE_VERSION, password: options.password,
    }))
    return yield* stock.register(options)
  })
  return { register }
}
