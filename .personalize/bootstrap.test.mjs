import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = fileURLToPath(new URL("../", import.meta.url))
const source = (name) => JSON.stringify(path.join(root, name).replaceAll("\\", "/"))
const effect = createRequire(new URL("../packages/core/package.json", import.meta.url)).resolve("effect")

function run(body, env = {}) {
  const parent = path.join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(path.join(parent, "bootstrap-native-"))
  try {
    const filename = path.join(directory, "probe.mjs")
    writeFileSync(filename, body)
    const result = spawnSync("bun", ["run", filename], {
      cwd: root, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, OPENCODE_TEST_HOME: directory,
        XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"),
        XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state"),
        ...env },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("actual Bun builds normalize the stock version through define, without intercepting its exports", () => run(`
  import assert from "node:assert/strict"
  import { writeFileSync } from "node:fs"
  import path from "node:path"
  import { fileURLToPath } from "node:url"
  import { build, loadManifest } from ${source(".personalize/build.mjs")}
  const root = ${JSON.stringify(root)}
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const manifest = [...loadManifest(root).values()]
  for (const file of ["packages/cli/src/version.ts", "packages/util/src/observability.ts"])
    assert.equal(manifest.some(entry => entry.target === path.resolve(root, file)), false)
  const entry = path.join(directory, "version.ts")
  writeFileSync(entry, ${JSON.stringify(`import { OPENCODE_CHANNEL, OPENCODE_LOCAL } from ${source("packages/cli/src/version.ts")}
console.log(JSON.stringify({ channel: OPENCODE_CHANNEL, local: OPENCODE_LOCAL }))
`)})
  let index = 0
  async function compile(compile, definition) {
    const options = { entrypoints: [entry], target: "bun", write: false,
      define: definition === undefined ? {} : { OPENCODE_CHANNEL: definition } }
    const before = JSON.stringify(options.define)
    const result = await compile(options)
    assert.equal(result.success, true, result.logs.map(String).join("\\n"))
    assert.equal(JSON.stringify(options.define), before, "caller options must not be mutated")
    const output = path.join(directory, "version-" + index++ + ".mjs")
    await Bun.write(output, result.outputs[0])
    const child = Bun.spawnSync([process.execPath, output])
    assert.equal(child.exitCode, 0, child.stderr.toString())
    return JSON.parse(child.stdout.toString())
  }
  // Positive control: the pristine module does not normalize these strings itself.
  assert.deepEqual(await compile(options => Bun.build(options), "'undefined'"), { channel: "undefined", local: false })
  for (const [definition, channel] of [
    ["'undefined'", "local"], ["' null '", "local"], ["' invalid/channel '", "local"],
    ["' custom '", "custom"], ['"dev"', "dev"], ["undefined", "local"], [undefined, "local"],
  ]) assert.deepEqual(await compile(options => build(options, { root }), definition),
    { channel, local: channel === "local" })
`))

test("bootstrap disables stock telemetry through its environment inputs without replacing Observability", () => run(`
  import ${source("packages/cli/src/personalize/bootstrap.ts")}
  import assert from "node:assert/strict"
  import path from "node:path"
  import { Effect } from ${JSON.stringify(effect.replaceAll("\\", "/"))}
  import { Observability } from ${source("packages/util/src/observability.ts")}
  import { Otlp } from ${source("packages/util/src/observability/otlp.ts")}
  import { Global } from ${source("packages/util/src/global.ts")}
  const app = { client: "bootstrap-test", version: "test", channel: "local" }
  const options = { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT, headers: process.env.OTEL_EXPORTER_OTLP_HEADERS, ...app }
  assert.equal(process.env.OPENCODE_DISABLE_AUTOUPDATE, "1")
  assert.equal(process.env.OTEL_SDK_DISABLED, "true")
  for (const key of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"])
    assert.equal(process.env[key], undefined, key)
  // A positive control proves the actual upstream logger would enable exporting.
  assert.equal(Otlp.loggers({ endpoint: "http://127.0.0.1:9" }, app).length, 1)
  assert.equal(Otlp.loggers(options, app).length, 0)
  const relative = path.relative(process.env.OPENCODE_TEST_HOME, Global.Path.log)
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "logs must stay in the disposable fixture")
  let requests = 0
  globalThis.fetch = () => { requests++; throw new Error("telemetry must not make a request") }
  for (const layer of [Observability.layer(), Observability.layer(options)])
    await Effect.runPromise(Effect.logInfo("bootstrap regression").pipe(Effect.provide(layer), Effect.scoped))
  assert.equal(requests, 0)
`, {
  OPENCODE_DISABLE_AUTOUPDATE: "0", OTEL_SDK_DISABLED: "false",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
  OTEL_EXPORTER_OTLP_HEADERS: "test=fixture",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:9/traces",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:9/metrics",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:9/logs",
}))
