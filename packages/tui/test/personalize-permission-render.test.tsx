/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { PermissionRequest } from "@opencode/client"
import type { PermissionReply } from "@opencode/schema/personalize/permission-controller"
import { withFacts } from "@opencode/schema/personalize/permission-policy"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocationProvider } from "../src/context/location"
import { TuiAppProvider } from "../src/context/runtime"
import { StorageProvider } from "../src/context/storage"
import { ThemeProvider } from "../src/context/theme"
import { ToastProvider } from "../src/ui/toast"
import { PermissionPrompt } from "../src/routes/session/permission"
import { RunPermissionBody } from "../src/mini/footer.permission"
import { RUN_THEME_FALLBACK } from "../src/mini/theme"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { createApi, createFetch, directory } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const request = (id = "per_render"): PermissionRequest => ({
  id, sessionID: "ses_render", action: "shell", resources: ["runner"],
  metadata: { filesystemEffects: "unknown", unknownCommand: "runner", unknownCwd: "C:/work", unknownShell: "powershell.exe" },
})
type Surface = "full" | "mini"

async function mount(surface: Surface, state: string) {
  const [current, replace] = createSignal(request())
  const sent: PermissionReply[] = []
  const pending: ReturnType<typeof Promise.withResolvers<void>>[] = []
  const send = (reply: PermissionReply) => {
    sent.push(reply)
    const wait = Promise.withResolvers<void>()
    pending.push(wait)
    return wait.promise
  }
  // Full TUI exercises the real Data/SDK adapter; only the network boundary is
  // controlled. Mini uses its production onReply boundary, not a fake controller.
  const network = createFetch(async (url, req) => {
    const match = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url.pathname)
    if (!match) return
    const body = await req.json() as Pick<PermissionReply, "decision" | "message">
    await send({ ...body, sessionID: match[1]!, requestID: match[2]! })
    return new Response(null, { status: 204 })
  })
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
        <StorageProvider>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <ToastProvider>
                <ClientProvider api={createApi(network.fetch)}>
                  <DataProvider directory={directory}>
                    <LocationProvider>
                      <ThemeProvider mode="dark" source={emptyThemeSource}>
                        {surface === "full" ? <PermissionPrompt request={current()} /> :
                          <RunPermissionBody request={current()} theme={RUN_THEME_FALLBACK.footer}
                            block={RUN_THEME_FALLBACK.block} onReply={send} />}
                      </ThemeProvider>
                    </LocationProvider>
                  </DataProvider>
                </ClientProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </StorageProvider>
      </TuiAppProvider>
    </TestTuiContexts>
  ), { width: 112, height: 30, kittyKeyboard: true })
  const frame = async () => { await app.renderOnce(); return app.captureCharFrame() }
  const buttonColor = (label: string) => {
    const span = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === label)
    if (!span) throw new Error(`Button not visible: ${label}`)
    return span.bg.toInts()
  }
  const enter = async () => { app.mockInput.pressEnter(); await app.renderOnce() }
  const policy = async () => {
    app.mockInput.pressArrow("right") // Custom
    await enter()
    expect(await frame()).toContain("Unknown=1")
  }
  const type = async (text: string) => {
    await app.mockInput.typeText(text)
    await app.renderOnce()
  }
  return { app, sent, pending, replace, frame, buttonColor, enter, policy, type, close() {
    app.renderer.currentFocusedRenderable?.blur()
    app.renderer.currentFocusedEditor?.blur()
    app.renderer.destroy()
  } }
}

for (const surface of ["full", "mini"] as const) {
  test(`${surface}: click Custom, leave blanks unchanged, or fill just Whole=`, async () => {
    await using state = await tmpdir()
    const view = await mount(surface, state.path)
    const clickText = async (text: string, offset: number) => {
      const rows = (await view.frame()).split("\n")
      const y = rows.findIndex((row) => row.includes(text))
      expect(y).toBeGreaterThanOrEqual(0)
      await view.app.mockMouse.click(rows[y]!.indexOf(text) + offset, y)
      await view.frame()
    }
    try {
      const initial = "Unknown= Whole="
      await clickText("Custom", 2)
      expect(view.app.renderer.currentFocusedEditor?.plainText).toBe(initial)
      expect(view.app.renderer.currentFocusedEditor?.cursorOffset).toBe("Unknown=".length)
      await view.enter()
      expect(view.sent).toEqual([])
      expect(await view.frame()).toContain("=Deny")
      await clickText("Custom", 2)
      await clickText(initial, initial.length)
      await view.type("SEA")
      expect(view.app.renderer.currentFocusedEditor?.plainText).toBe("Unknown= Whole=SEA")
      await view.enter()
      await view.app.waitFor(() => view.sent.length === 1)
      expect(view.sent[0]!.decision).toEqual({ scope: "session", policy: "Whole=SEA" })
      view.pending[0]!.resolve()
    } finally { view.close() }
  })

  test(`${surface}: arrows move the visible highlight; Enter sends the selected dotnet decision`, async () => {
    await using state = await tmpdir()
    const view = await mount(surface, state.path)
    const script = [
      "$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'",
      "$env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH='false'",
      "$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'",
      "dotnet run --project tests\\WindowsProcessEvidence",
    ].join("\n")
    try {
      for (const [id, direction, label, decision] of [
        ["per_exact", "right", "=S", { scope: "session", policy: "Unknown=S" }],
        ["per_whole", "right", "Custom", { scope: "session", policy: "Whole=SEA" }],
        ["per_deny", "left", "=Deny", "reject"],
      ] as const) {
        const shell = request(id)
        view.replace({ ...shell, resources: [script], metadata: { ...shell.metadata, unknownCommand: script } })
        const initial = await view.frame()
        expect(initial).toContain("Unknown command policy")
        expect(initial).not.toMatch(/CRUD|Allow \(SE/)
        expect(initial).toContain("=S allows this exact command for this session.")
        expect(initial).not.toContain("Whole=SEA")
        const focused = view.buttonColor("=1")
        expect(view.buttonColor(label)).not.toEqual(focused)
        const before = view.sent.length
        view.app.mockInput.pressArrow(direction)
        if (id === "per_exact") view.app.mockInput.pressArrow(direction)
        await view.frame()
        expect(view.buttonColor(label)).toEqual(focused)
        expect(view.buttonColor("=1")).not.toEqual(focused)
        expect(view.sent.length).toBe(before)
        await view.enter()
        if (id === "per_whole") {
          view.app.mockInput.pressArrow("left")
          view.app.mockInput.pressArrow("right")
          view.app.mockInput.pressArrow("left")
          await view.frame()
          expect(view.app.renderer.currentFocusedEditor?.plainText).toBe("Unknown= Whole=SEA")
          expect(view.sent.length).toBe(before)
          await view.enter()
        }
        await view.app.waitFor(() => view.sent.length === before + 1)
        expect(view.sent[before]).toMatchObject({ requestID: id, decision })
        view.pending[before]!.resolve()
        await view.frame()
      }
    } finally { view.close() }
  })

  test(`${surface}: v11 left/right opens CRUD first and accepts CRUD on shell prompts`, async () => {
    await using state = await tmpdir()
    const view = await mount(surface, state.path)
    try {
      const encoded = withFacts({ ...request("per_crud"), action: "read", metadata: {}, resources: ["C:/work/file"] }, {
        operations: ["read"], paths: ["C:/work/file"], directories: ["C:/work"],
      })
      view.replace({ ...encoded, metadata: JSON.parse(JSON.stringify(encoded.metadata)) })
      await view.frame()
      view.app.mockInput.pressArrow("right")
      view.app.mockInput.pressArrow("left")
      view.app.mockInput.pressArrow("right")
      await view.enter()
      expect(await view.frame()).toContain("Session CRUD policy")
      await view.type("RU=S* CD=D*")
      await view.enter()
      await view.app.waitFor(() => view.sent.length === 1)
      expect(view.sent[0]!.decision).toEqual({ scope: "session", policy: "RU=S* CD=D*" })
      view.pending[0]!.resolve()
      await view.frame()
      const dotnet = "$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'\ndotnet run --project tests\\WindowsProcessEvidence"
      const shell = request("per_shell_crud")
      view.replace({ ...shell, resources: [dotnet], metadata: { ...shell.metadata, unknownCommand: dotnet } })
      await view.frame()
      await view.policy()
      const policyFrame = await view.frame()
      expect(policyFrame).toContain("C:/work")
      expect(policyFrame).toContain("Unknown=S")
      expect(policyFrame).not.toMatch(/CRUD|RU=S\*|Unknown=SE/)
      view.app.mockInput.pressKey("a", { super: true }) // replace the command template with a directory rule
      await view.type("RU=S* CD=D*")
      await view.enter()
      await view.app.waitFor(() => view.sent.length === 2)
      expect(view.sent[1]!.decision).toEqual({ scope: "session", policy: "RU=S* CD=D*" })
      view.pending[1]!.resolve()
    } finally { view.close() }
  })

  test(`${surface}: rendered policy failure stays open and retries only on explicit input`, async () => {
    await using state = await tmpdir()
    const view = await mount(surface, state.path)
    try {
      const initial = await view.frame()
      for (const label of ["=1", "Custom", "=S", "=Deny", "Unknown command policy"]) expect(initial).toContain(label)
      expect(initial).not.toContain("CRUD")
      expect(initial).not.toContain("Always allow")
      await view.policy()
      await view.type("S")
      const field = view.app.renderer.currentFocusedEditor!
      view.app.mockInput.pressArrow("left")
      expect(field.cursorOffset).toBe("Unknown=".length)
      view.app.mockInput.pressArrow("right")
      expect(field.plainText).toBe("Unknown=S Whole=")
      await view.enter()
      await view.app.waitFor(() => view.sent.length === 1)
      expect(view.sent[0]).toMatchObject({ requestID: "per_render", decision: { scope: "session", policy: "Unknown=S" } })
      await view.enter()
      expect(view.sent.length).toBe(1)
      view.pending[0]!.reject(new Error("settlement refused"))
      await view.app.waitFor(async () => (await view.frame()).includes("settlement refused"))
      expect(await view.frame()).toContain("Unknown command policy")
      expect(await view.frame()).toContain("Unknown=S")
      expect(view.sent.length).toBe(1)
      await view.enter()
      await view.app.waitFor(() => view.sent.length === 2)
      expect(view.sent[1]).toEqual(view.sent[0])
      view.pending[1]!.resolve()
      await view.app.waitFor(async () => (await view.frame()).includes("=Deny"))
      expect(view.sent.length).toBe(2)
    } finally { view.close() }
  })

  test(`${surface}: request replacement clears the editor and ignores late failure without resubmission`, async () => {
    await using state = await tmpdir()
    const view = await mount(surface, state.path)
    try {
      await view.frame()
      await view.policy()
      await view.type("1")
      await view.enter()
      await view.app.waitFor(() => view.sent.length === 1)
      view.replace(request("per_renewed"))
      expect(await view.frame()).toContain("=Deny")
      expect(await view.frame()).not.toContain("Unknown=1")
      view.pending[0]!.reject(new Error("stale settlement refused"))
      await view.frame()
      await view.frame()
      expect(await view.frame()).not.toContain("stale settlement refused")
      expect(view.sent.length).toBe(1)
      await view.enter()
      await view.app.waitFor(() => view.sent.length === 2)
      expect(view.sent[1]).toMatchObject({ requestID: "per_renewed", decision: "once" })
      view.pending[1]!.resolve()
      await view.frame()
      await view.enter()
      expect(view.sent.length).toBe(2) // transport success is not a new approval
    } finally { view.close() }
  })

  test(`${surface}: wildcard policy is rejected locally and escape returns without approving`, async () => {
    await using state = await tmpdir()
    const view = await mount(surface, state.path)
    try {
      await view.frame()
      await view.policy()
      await view.type("S*")
      await view.enter()
      expect(view.sent).toEqual([])
      expect(await view.frame()).toContain("Unknown command policy")
      view.app.mockInput.pressEscape()
      expect(await view.frame()).toContain("=Deny")
      expect(view.sent).toEqual([])
      view.app.mockInput.pressEscape()
      await view.app.waitFor(() => view.sent.length === 1)
      expect(view.sent[0]!.decision).toBe("reject")
      view.pending[0]!.resolve()
    } finally { view.close() }
  })
}
