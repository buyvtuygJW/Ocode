// A failed registered server is not repaired by one health/event request per
// second. Keep automatic recovery observable, but cap this specific retry loop.
const failedBoot = (error: unknown) => error instanceof Error && error.message === "Background service failed to start"

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const cancel = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve() }, ms)
    signal.addEventListener("abort", cancel, { once: true })
  })
}

export function decorate(stock: typeof import("../solid/connection")) {
  const createClientConnection: typeof stock.createClientConnection = (api, options) => {
    if (!options.reconnect) return stock.createClientConnection(api, options)
    const reconnect = options.reconnect
    let failures = 0
    return stock.createClientConnection(api, {
      ...options,
      reconnect: async (signal) => {
        if (failures) await wait(Math.min(30_000, 2_000 * 2 ** Math.min(failures - 1, 4)), signal)
        try {
          const next = await reconnect(signal)
          failures = 0
          return next
        } catch (error) {
          failures = failedBoot(error) ? Math.min(failures + 1, 5) : 0
          if (failures === 1) options.log?.info?.("Background service boot failed; slowing retries. Inspect the server log.", {
            retryDelayMs: 2_000,
          })
          throw error
        }
      },
    })
  }
  return { createClientConnection }
}
