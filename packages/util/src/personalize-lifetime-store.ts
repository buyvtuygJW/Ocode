import fs from "node:fs"
import path from "node:path"
import { Global } from "./global"
import { defaults, type Settings, type Stop } from "./personalize-lifetime"

// Small settings/sleep files beside the existing service registration. These
// are data only: no service, scheduler, autostart, polling, or process creation.
const serviceFile = () => process.env.OPENCODE_SERVICE_FILE ?? path.join(Global.Path.state, "service.json")

function read(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return undefined }
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value))
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function settings(): Settings {
  const value = read(`${serviceFile()}.lifetime.json`)
  if (!value || typeof value !== "object") return { ...defaults }
  const result = { ...defaults }
  for (const key of ["hardMs", "softMs"] as const) {
    const ms = Reflect.get(value, key)
    if (Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647) result[key] = ms
  }
  return result
}

export function save(value: Settings) { write(`${serviceFile()}.lifetime.json`, value) }

export function sleeping(kind: Stop) {
  write(`${serviceFile()}.sleep.json`, { at: Date.now(), pid: process.pid, kind })
}

export function sleptAfter(time: number) {
  const value = read(`${serviceFile()}.sleep.json`)
  return !!value && typeof value === "object" && Number(Reflect.get(value, "at")) > time
}

export function evictSelf() {
  const file = serviceFile()
  const value = read(file)
  if (value && typeof value === "object" && Reflect.get(value, "pid") === process.pid)
    fs.rmSync(file, { force: true })
}
