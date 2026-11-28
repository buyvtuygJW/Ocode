import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { ShellSelect } from "@opencode/core/shell/select"
import { toolIdentity } from "../lib/tool"
import { Expected } from "../lib/session-message"
import { hasNoFilesystemEffects } from "../../src/personalize/shell-permission"

type Fixture = Pick<typeof import("../tool-shell.test"),
  "Cause" | "permissionIt" | "withScanner" | "runPermissionCommand" | "isWindows">
const sessionApproval = { scope: "session", policy: "Unknown=S" } as const
const completed = { _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } }

// The scanner scenarios remain end-to-end. Saved shell globs are still inspected,
// but cannot substitute for v12's explicit unknown-effect consent.
export function shellRunnerScenarios({ Cause, permissionIt, withScanner, runPermissionCommand, isWindows }: Fixture) {
  describe("ShellTool scanner permissions", () => {
    const test = isWindows || !Bun.which("sh") ? permissionIt.live.skip : permissionIt.live
    test("declarations and substitutions retain explicit reject/once/session behavior", () =>
      withScanner((registry, fixture) => Effect.gen(function* () {
        const saved = yield* PermissionSaved.Service
        const location = yield* Location.Service
        yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["printf *"] })
        const marker = path.join(fixture.active, "marker")
        const declaration = "export SCAN_TEST=hello; unset SCAN_TEST; printf hello > marker"
        const approved = yield* runPermissionCommand(registry, declaration, marker, ["once"])
        expect(approved.requests).toMatchObject([{
          action: "shell", metadata: { filesystemEffects: "unknown", unknownCommand: declaration },
        }])
        expect(approved.exit).toMatchObject(completed)
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
        expect((yield* saved.list()).map((item) => item.resource)).toEqual(["printf *"])
        yield* Effect.forEach(yield* saved.list(), (item) => saved.remove(item.id))
        const command = 'export SCAN_TEST=$(printf hello); printf %s "$SCAN_TEST" > marker'
        const prompts: Permission.Request[] = []
        for (const reply of ["reject", "once", sessionApproval, undefined] as const) {
          yield* Effect.promise(() => fs.rm(marker, { force: true }))
          const result = yield* runPermissionCommand(registry, command, marker, reply ? [reply] : [])
          prompts.push(...result.requests)
          if (reply === "reject") {
            expect(Exit.isFailure(result.exit)).toBe(true)
            if (Exit.isFailure(result.exit)) expect(result.exit.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
            )).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
          } else {
            expect(result.exit).toMatchObject(completed)
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
          }
          // Unknown=S is conversation-local, never a project-wide shell glob.
          expect(yield* saved.list()).toEqual([])
        }
        expect(prompts).toHaveLength(3)
        for (const request of prompts) expect(request).toMatchObject({
          action: "shell", resources: ["printf hello", 'printf %s "$SCAN_TEST" > marker'],
          save: ["printf *", "printf *"],
          metadata: { filesystemEffects: "unknown", unknownCommand: command },
        })
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [{ action: "shell", resource: "printf hello", effect: "deny" }]
        }))
        yield* Effect.promise(() => fs.rm(marker))
        const denied = yield* runPermissionCommand(registry, command, marker, [])
        expect(denied.exit).toMatchObject({
          _tag: "Success", value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
        })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      })))

    test("unanalyzable commands require unknown consent even under allow-all rules", () =>
      withScanner((registry, fixture) => Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
        }))
        const marker = path.join(fixture.active, "marker")
        const command = "alias p=true; printf hello > marker"
        const result = yield* runPermissionCommand(registry, command, marker, ["once"])
        expect(result.requests).toMatchObject([{ action: "shell", metadata: {
          filesystemEffects: "unknown", unknownCommand: command,
        } }])
        expect(result.exit).toMatchObject(completed)
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
      })))

    test("unanalyzable commands are denied when a shell deny rule could be bypassed", () =>
      withScanner((registry, fixture) => Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [
            { action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "rm *", effect: "deny" },
          ]
        }))
        const marker = path.join(fixture.active, "marker")
        const result = yield* runPermissionCommand(registry, "alias p=true; printf hello > marker", marker, [])
        expect(result.requests).toEqual([])
        expect(result.exit).toMatchObject({ _tag: "Success", value: { status: "error", error: {
          message: expect.stringContaining("Portable shell scanner cannot analyze command: dynamic-execution. A shell deny rule is configured"),
        } } })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      })))

    test("unanalyzable commands ask for the exact command and any directory without saving", () =>
      withScanner((registry, fixture) => Effect.gen(function* () {
        const saved = yield* PermissionSaved.Service
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [
            { action: "shell", resource: "alias *", effect: "allow" },
            { action: "external_directory", resource: path.join(fixture.outside, "*"), effect: "allow" },
          ]
        }))
        const marker = path.join(fixture.active, "marker")
        const command = "alias p=true; printf hello > marker"
        const approved = yield* runPermissionCommand(registry, command, marker, ["always", "once"])
        expect(approved.requests).toMatchObject([
          { action: "external_directory", resources: ["*"] },
          { action: "shell", resources: [command], metadata: { filesystemEffects: "unknown" } },
        ])
        expect(approved.exit).toMatchObject(completed)
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [{ action: "external_directory", resource: "*", effect: "allow" }]
        }))
        yield* Effect.promise(() => fs.rm(marker))
        const asked = yield* runPermissionCommand(registry, command, marker, ["once"])
        expect(asked.requests).toMatchObject([
          { action: "shell", resources: [command], metadata: { reason: "dynamic-execution" } },
        ])
        expect(asked.requests.map((request) => request.save)).toEqual([undefined])
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
        expect(yield* saved.list()).toEqual([])
        yield* Effect.promise(() => fs.rm(marker))
        const repeat = yield* runPermissionCommand(registry, command, marker, ["reject"])
        expect(repeat.requests).toHaveLength(1)
        expect(Exit.isFailure(repeat.exit)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      })))

    test("pipeline redirect keeps the redirect target visible to exact approval and denial", () =>
      withScanner((registry, fixture) => Effect.gen(function* () {
        const saved = yield* PermissionSaved.Service
        const location = yield* Location.Service
        yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["printf hello", "cat"] })
        const marker = path.join(fixture.active, "marker")
        const command = "printf hello | cat > marker"
        const rejected = yield* runPermissionCommand(registry, command, marker, ["reject"])
        expect(rejected.requests).toMatchObject([
          { action: "shell", resources: ["printf hello", "cat > marker"], save: ["printf *", "cat *"] },
        ])
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        for (const resources of [["cat > marker"], ["printf *", "cat *"]]) {
          yield* saved.add({ projectID: location.project.id, action: "shell", resources })
          const result = yield* runPermissionCommand(registry, command, marker, ["once"])
          expect(result.requests).toMatchObject([{ action: "shell", metadata: { unknownCommand: command } }])
          expect(result.exit).toMatchObject(completed)
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
          yield* Effect.promise(() => fs.rm(marker))
        }
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [{ action: "shell", resource: "* > marker", effect: "deny" }]
        }))
        const denied = yield* runPermissionCommand(registry, command, marker, [])
        expect(denied.requests).toEqual([])
        expect(denied.exit).toMatchObject({ _tag: "Success", value: {
          status: "error", error: { message: expect.stringContaining("Permission denied: shell") },
        } })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      })))

    test("external-directory rejection stops execution before a workspace marker is written", () =>
      withScanner((registry, fixture) => Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [{ action: "shell", resource: "*", effect: "allow" }]
        }))
        const marker = path.join(fixture.active, "marker")
        const command = `cd '${fixture.outside}' && pwd -P && printf reached > '${marker}'`
        for (const reply of ["reject", "once"] as const) {
          const result = yield* runPermissionCommand(registry, command, marker, reply === "reject" ? [reply] : [reply, "once"])
          expect(result.requests[0]).toMatchObject({
            action: "external_directory", resources: [path.join(fixture.outside, "*")],
          })
          expect(result.requests).toHaveLength(reply === "reject" ? 1 : 2)
          if (reply === "reject") {
            expect(Exit.isFailure(result.exit)).toBe(true)
            if (Exit.isFailure(result.exit)) expect(result.exit.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
            )).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
          } else {
            expect(result.requests[1]).toMatchObject({ action: "shell", metadata: { unknownCommand: command } })
            expect(result.exit).toMatchObject({ ...completed, value: {
              ...completed.value, content: [{ type: "text", text: `${fixture.outside}\n` }],
            } })
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
          }
        }
      })))

    test("a numeric symlink operand requires explicit unknown consent before reaching outside", () =>
      withScanner((registry, fixture) => Effect.gen(function* () {
        yield* Effect.promise(() => fs.symlink(fixture.outside, path.join(fixture.active, "123")))
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [
            { action: "shell", resource: "*", effect: "allow" },
            { action: "external_directory", resource: "*", effect: "deny" },
          ]
        }))
        const marker = path.join(fixture.active, "marker")
        const command = `cd 123 && pwd -P && printf reached > '${marker}'`
        const rejected = yield* runPermissionCommand(registry, command, marker, ["reject"])
        expect(Exit.isFailure(rejected.exit)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        const result = yield* runPermissionCommand(registry, command, marker, ["once"])
        expect(result.requests).toMatchObject([{ action: "shell", metadata: { unknownCommand: command } }])
        expect(result.exit).toMatchObject({ ...completed, value: {
          ...completed.value, content: [{ type: "text", text: `${fixture.outside}\n` }],
        } })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
      })))

    test("a continued directory operand resolves to the destination and enforces external-directory deny", () =>
      withScanner((registry, fixture) => Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [
            { action: "shell", resource: "*", effect: "allow" },
            { action: "external_directory", resource: path.join(fixture.outside, "*"), effect: "deny" },
          ]
        }))
        const marker = path.join(fixture.active, "marker")
        const denied = yield* runPermissionCommand(registry, `cd ../out\\\nside && pwd -P && printf reached > '${marker}'`, marker, [])
        expect(denied.requests).toEqual([])
        expect(denied.exit).toMatchObject({ _tag: "Success", value: { status: "error", error: {
          message: expect.stringContaining("Permission denied: external_directory"),
        } } })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      })))
  })

  describe("ShellTool conditional process substitution", () => {
    const test = isWindows || !Bun.which("bash") ? permissionIt.live.skip : permissionIt.live
    test("a nested deny prevents the substitution from running", () =>
      withScanner((registry, directory) => Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [
            { action: "shell", resource: "*", effect: "allow" },
            { action: "shell", resource: "printf *", effect: "deny" },
          ]
        }))
        const marker = path.join(directory.active, "marker")
        const result = yield* runPermissionCommand(registry, '[[ -n <(printf reached > marker) ]]; wait "$!"', marker, [])
        expect(result.exit).toMatchObject({ _tag: "Success", value: { status: "error", error: {
          message: expect.stringContaining("Permission denied: shell"),
        } } })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }), "bash"))
    for (const reply of ["reject", sessionApproval] as const) {
      test(`conditional substitutions respect ${reply === "reject" ? "reject" : "Unknown=S"}`, () =>
        withScanner((registry, directory) => Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const location = yield* Location.Service
          yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["wait *"] })
          const marker = path.join(directory.active, "marker")
          const command = '[[ -n <(printf reached > marker) ]]; wait "$!"'
          const result = yield* runPermissionCommand(registry, command, marker, [reply])
          expect(result.requests).toMatchObject([
            { action: "shell", resources: ["printf reached > marker", 'wait "$!"'], save: ["printf *", "wait *"] },
          ])
          if (reply === "reject") {
            expect(Exit.isFailure(result.exit)).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
            return
          }
          expect(result.exit).toMatchObject(completed)
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
          yield* Effect.promise(() => fs.unlink(marker))
          const repeat = yield* runPermissionCommand(registry, command, marker, [])
          expect(repeat.requests).toEqual([])
          expect(repeat.exit).toMatchObject(completed)
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(true)
        }), "bash"))
    }
  })

  describe("ShellTool compound syntax approval compatibility", () => {
    for (const fixture of [
      { shell: "zsh", command: 'for value ($(printf a)) do printf %s "$value"; done', output: "a", saved: ["printf *"] },
      { shell: "bash", command: 'printf %s "$(probe() case value in (value) printf hello;; esac; probe)"',
        output: "hello", saved: ["printf *", "probe *"] },
    ]) {
      const test = isWindows || !Bun.which(fixture.shell) ? permissionIt.live.skip : permissionIt.live
      test(`${fixture.shell}: ${fixture.command}`, () =>
        withScanner((registry, directory) => Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const location = yield* Location.Service
          yield* saved.add({ projectID: location.project.id, action: "shell", resources: fixture.saved })
          const result = yield* runPermissionCommand(registry, fixture.command, path.join(directory.active, "marker"), ["once"])
          expect(result.requests).toMatchObject([{ action: "shell", metadata: { unknownCommand: fixture.command } }])
          expect(result.exit).toMatchObject({ ...completed, value: {
            ...completed.value, content: [{ type: "text", text: fixture.output }],
          } })
        }), fixture.shell))
    }
  })

  describe("ShellTool ordinary shell syntax", () => {
    for (const shell of ["bash", "zsh"]) {
      const test = isWindows || !Bun.which(shell) ? permissionIt.live.skip : permissionIt.live
      for (const fixture of [
        { name: "heredoc substitution", command: "cat <<EOF\n$(printf hello)\nEOF", output: "hello\n", saved: ["cat *", "printf *"] },
        { name: "function and case", command: 'greet() { case "$1" in a) printf hello;; *) printf other;; esac; }; greet a',
          output: "hello", saved: ["greet *", "printf *"] },
        { name: "arithmetic statement", command: 'count=1; ((count += 1)); printf %s "$count"',
          output: "2", saved: ["((count += 1)) *", "printf *"] },
      ]) {
        test(`${shell}: ${fixture.name} reuses exact session approval, not shell globs`, () =>
          withScanner((registry, directory) => Effect.gen(function* () {
            const saved = yield* PermissionSaved.Service
            const location = yield* Location.Service
            yield* saved.add({ projectID: location.project.id, action: "shell", resources: fixture.saved })
            const marker = path.join(directory.active, "marker")
            for (const replies of [["once"], [sessionApproval], []] as const) {
              const result = yield* runPermissionCommand(registry, fixture.command, marker, replies)
              expect(result.requests).toHaveLength(replies.length)
              if (replies.length) expect(result.requests[0]).toMatchObject({
                action: "shell", metadata: { unknownCommand: fixture.command },
              })
              expect(result.exit).toMatchObject({ ...completed, value: {
                ...completed.value, content: [{ type: "text", text: fixture.output }],
              } })
            }
          }), shell))
      }
      test(`${shell}: a loop body deny prevents execution`, () =>
        withScanner((registry, directory) => Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [
              { action: "shell", resource: "*", effect: "allow" },
              { action: "shell", resource: "printf *", effect: "deny" },
            ]
          }))
          const marker = path.join(directory.active, "marker")
          const result = yield* runPermissionCommand(registry, "for value in a; do printf body > marker; done", marker, [])
          expect(result.exit).toMatchObject({ _tag: "Success", value: { status: "error", error: {
            message: expect.stringContaining("Permission denied: shell"),
          } } })
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }), shell))
    }
    const pwsh = process.env.SHELL_SCAN_PWSH ?? Bun.which("pwsh") ?? Bun.which("powershell")
    const test = pwsh ? permissionIt.live : permissionIt.live.skip
    for (const command of [
      'Write-Output "$(Write-Output hello)"',
      "function Show-Value { Write-Output hello }; Show-Value",
      "Write-Output @'\nhello\n'@",
    ]) {
      test(`PowerShell: ordinary syntax requires explicit unknown approval: ${command}`, () =>
        withScanner((registry, directory) => Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const location = yield* Location.Service
          yield* saved.add({ projectID: location.project.id, action: "shell",
            resources: ["Write-Output *", "Show-Value *"] })
          const result = yield* runPermissionCommand(registry, command, path.join(directory.active, "marker"), ["once"])
          expect(result.requests).toMatchObject([{ action: "shell", metadata: { unknownCommand: command } }])
          expect(result.exit).toMatchObject(completed)
          if (Exit.isSuccess(result.exit))
            expect(result.exit.value.content?.[0]).toEqual(Expected.text(isWindows ? "hello\r\n" : "hello\n"))
        }), pwsh ?? "pwsh"))
    }
    for (const [command, pattern] of [
      ["Write-Output\thello", "Write-Output\t*"],
      ["& 'Write-Output' hello", "& 'Write-Output' *"],
      ["Write-Output `\n  hello", "Write-Output *"],
    ]) {
      test(`PowerShell: session approval covers repeat execution and preserves exact deny: ${command}`, () =>
        withScanner((registry, directory) => Effect.gen(function* () {
          const marker = path.join(directory.active, "marker")
          const shell = yield* (yield* ShellSelect.Service).resolve({ priority: "compat" })
          const reply = hasNoFilesystemEffects(command, shell) ? "always" : sessionApproval
          const first = yield* runPermissionCommand(registry, command, marker, [reply])
          expect(first.requests).toMatchObject([{ action: "shell", resources: [command], save: [pattern] }])
          expect(first.exit).toMatchObject(completed)
          const repeat = yield* runPermissionCommand(registry, command, marker, [])
          expect(repeat.requests).toEqual([])
          expect(repeat.exit).toMatchObject(completed)
          const agents = yield* Agent.Service
          yield* agents.transform((editor) => editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [{ action: "shell", resource: command, effect: "deny" }]
          }))
          const denied = yield* runPermissionCommand(registry, command, marker, [])
          expect(denied.exit).toMatchObject({ _tag: "Success", value: { status: "error", error: {
            message: expect.stringContaining("Permission denied: shell"),
          } } })
        }), pwsh ?? "pwsh"))
    }
  })
}
