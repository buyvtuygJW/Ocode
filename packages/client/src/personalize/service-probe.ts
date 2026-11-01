import type { Info } from "../service"

export function decorate(stock: typeof import("../service-probe")) {
  const decide: typeof stock.decide = (service, options) => {
    const state = service && typeof service === "object" ? Reflect.get(service, "state") : undefined
    return state === "waiting" || state === "retrying" ? { _tag: "wait" } : stock.decide(service, options)
  }
  const probeResult: typeof stock.probeResult = async (info: Info, timeout) => {
    const result = await stock.probeResult(info, timeout)
    if (result.service || result.timedOut) return result
    // A registered owner must not be killed merely because the published version
    // changes while that same PID is starting. All other stock health rules stay intact.
    const endpoint = { url: info.url, auth: info.password === undefined ? undefined : {
      type: "basic" as const, username: "opencode", password: info.password,
    } }
    try {
      const response = await fetch(new URL("/api/info", info.url), {
        headers: stock.headers(endpoint), signal: AbortSignal.timeout(timeout ?? 1000),
      })
      if (response.status !== 503) return result
      const body: unknown = await response.json()
      if (!body || typeof body !== "object" || !("pid" in body) || body.pid !== info.pid ||
          !("version" in body) || typeof body.version !== "string") return result
      return { timedOut: false, service: { info, endpoint, version: body.version,
        state: "waiting" as const, compatible: true } }
    } catch { return result }
  }
  return { decide, probeResult }
}
