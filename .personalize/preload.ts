import path from "node:path"
import { PersonalizeBuild } from "./build.mjs"

const root = path.resolve(import.meta.dirname, "..")
const solidPath = Bun.resolveSync("@opentui/solid/bun-plugin", path.join(root, "packages/cli"))
const { createSolidTransformPlugin } = await import(solidPath)
for (const plugin of PersonalizeBuild.plugins([createSolidTransformPlugin()])) Bun.plugin(plugin)
