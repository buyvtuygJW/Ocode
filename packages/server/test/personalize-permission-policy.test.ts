import { expect } from "bun:test"
import { Effect } from "effect"
import type { PermissionReplyInput } from "@opencode/client/promise"
import { it } from "../../core/test/lib/effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { ServerFetch } from "../src/fetch"

it.live("invalid permission policies retain the request and return the standard typed HTTP error without a grant", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped("permission-policy-http-")
    const handler = yield* ServerFetch.make({
      app: { version: "test" }, database: { path: ":memory:" },
      fs: { filewatcher: false }, models: { fetch: false },
      config: { directory: directory.path, project: false, content: "{}" },
    })
    const request = (route: string, method: string, body?: unknown) => Effect.promise(async () => {
      const url = new URL(route, "http://opencode.local")
      url.searchParams.set("location[directory]", directory.path)
      const response = await handler(new Request(url, {
        method, headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }))
      return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
    })
    const created = yield* request("/api/session", "POST", {
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    })
    expect(created.status).toBe(200)
    const sessionID = created.body.data.id
    const route = `/api/session/${sessionID}/permission`
    const command = "& 'C:/Tools/runner.exe' --test 'C:/project/test/a.test.ts'"
    const input = {
      action: "shell", resources: [command],
      metadata: { filesystemEffects: "unknown", unknownCommand: command,
        unknownCwd: "C:/project", unknownShell: "powershell.exe" },
    }
    const ask = yield* request(route, "POST", input)
    expect(ask.status).toBe(200)
    expect(ask.body.data.effect).toBe("ask")
    const requestID = ask.body.data.id
    for (const policy of ["Unknown=S*", "Unknown=SE*", "Unknown=SEA*", "Unknown=E"]) {
      const decision = { scope: "session", policy } satisfies PermissionReplyInput["decision"]
      const failed = yield* request(`${route}/${requestID}/reply`, "POST", { decision })
      expect(failed.status).toBe(400)
      expect(failed.body).toMatchObject({ _tag: "InvalidRequestError", kind: "permission_policy", field: "decision" })
      expect(failed.body.message.length).toBeGreaterThan(0)
      expect((yield* request(`${route}/${requestID}`, "GET")).status).toBe(200)
      const repeated = yield* request(route, "POST", input)
      expect(repeated.body.data.effect).toBe("ask")
      expect((yield* request(`/api/session/${sessionID}`, "GET")).body.data.permissions).toEqual(created.body.data.permissions)
      expect((yield* request("/api/permission/saved", "GET")).body.data).toEqual([])
    }
    // Positive control exercises the same HTTP transport, schema, handler and
    // real permission service; only an explicit valid decision may authorize.
    const decision = { scope: "session", policy: "Unknown=S" } satisfies PermissionReplyInput["decision"]
    expect((yield* request(`${route}/${requestID}/reply`, "POST", { decision })).status).toBe(204)
    expect((yield* request(route, "POST", input)).body.data.effect).toBe("allow")
    expect((yield* request(route, "POST", { ...input, resources: [command + " --watch"],
      metadata: { ...input.metadata, unknownCommand: command + " --watch" } })).body.data.effect).toBe("ask")
  }).pipe(Effect.scoped),
)
