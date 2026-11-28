// These adapter tests depend on Node's module hooks. Keep them in ordinary Bun
// discovery, but run their unchanged assertions in the runtime they exercise.
if (process.versions.bun) {
  const { test, expect } = await import("bun:test")
  const { fileURLToPath } = await import("node:url")
  test("Node permission service adapters (complete suite)", async () => {
    const child = Bun.spawn([
      "node", "--import", fileURLToPath(new URL("../../../../.personalize/node-typescript.mjs", import.meta.url)),
      "--experimental-transform-types", "--test", "--test-reporter=tap",
      fileURLToPath(new URL("./service.node-suite.mjs", import.meta.url)),
    ], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Node permission suite failed (${code})\n${stdout}\n${stderr}`)
    expect(stdout).toMatch(/# fail 0/)
  }, 60000)
} else {
  await import("./service.node-suite.mjs")
}
