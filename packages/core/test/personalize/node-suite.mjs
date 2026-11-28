import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

// Keep Node-hook regressions in Bun's complete discovery without installing
// their process-global hooks in the Bun runner or dropping any assertions.
export async function nodeSuite(suite) {
  const { test } = await import("bun:test")
  test(`Node adapters: ${fileURLToPath(suite)}`, async () => {
    const child = Bun.spawn([
      "node", "--import", fileURLToPath(new URL("../../../../.personalize/node-typescript.mjs", import.meta.url)),
      "--experimental-transform-types", "--test", "--test-reporter=tap", fileURLToPath(suite),
    ], { stdout: "pipe", stderr: "pipe" })
    const deadline = setTimeout(() => child.kill("SIGKILL"), 50_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      assert.equal(code, 0, `Node suite failed (${code})\n${stdout}\n${stderr}`)
      assert.match(stdout, /# tests [1-9]\d*/)
      assert.match(stdout, /# fail 0\b/)
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }, 60_000)
}
