import { choices, isPolicyReply, policyDraft, policyError, unknownShell, type Choice, type RequestLike } from "./permission-policy.js"

/** Kept independent of the generated client, whose stock reply type lacks policy. */
export type CompactPolicy = { readonly scope: "session"; readonly policy: string }
export type PermissionDecision = "once" | "session_read" | "always" | "reject" | CompactPolicy
export type PresenterRequest = RequestLike & { readonly id: string; readonly sessionID: string }
export type PermissionReply = {
  readonly sessionID: string
  readonly requestID: string
  readonly decision: PermissionDecision
  readonly message?: string
}
export type PresenterStage = "permission" | "policy" | "always" | "reject"
export type PresenterStatus = "idle" | "submitting" | "awaiting-event" | "resolved"
export type PresenterState = {
  readonly request: PresenterRequest
  readonly stage: PresenterStage
  readonly status: PresenterStatus
  readonly message: string
  readonly error?: string
  readonly generation: number
  readonly attempt: number
}

export type PresenterCallbacks = {
  /** Must reject on backend errors; adapters for result-returning SDKs must unwrap them. */
  readonly send: (reply: PermissionReply) => Promise<unknown> | unknown
  readonly changed?: (state: PresenterState) => void
  /** Receives the original backend error, in addition to state.error for inline display. */
  readonly report?: (error: unknown) => void
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * One presenter instance owns one current request. Bind changed to the local store;
 * call replaceRequest on request changes and resolved only for permission.replied.
 * No successful HTTP response is itself treated as a permission.replied event.
 */
export function createPermissionController(request: PresenterRequest, callbacks: PresenterCallbacks) {
  let state: PresenterState = {
    request, stage: "permission", status: "idle", message: "", generation: 0, attempt: 0,
  }
  let disposed = false
  const publish = (next: PresenterState) => {
    state = next
    callbacks.changed?.(state)
  }
  const active = (generation: number, attempt: number) =>
    !disposed && state.generation === generation && state.attempt === attempt && state.status === "submitting"

  function submit(decision: PermissionDecision, message?: string): boolean {
    if (disposed || state.status !== "idle") return false
    const option: Choice = typeof decision === "object" ? "policy" : decision
    if (!choices(state.request).includes(option)) return false
    if (typeof decision === "object") {
      const error = policyError(decision.policy, unknownShell(state.request), state.request)
      if (error !== undefined) {
        publish({ ...state, error })
        return false
      }
      decision = { scope: "session", policy: decision.policy.trim() }
    }
    const reply: PermissionReply = {
      sessionID: state.request.sessionID,
      requestID: state.request.id,
      decision,
      ...(message?.trim() ? { message: message.trim() } : {}),
    }
    const generation = state.generation
    const attempt = state.attempt + 1
    publish({ ...state, status: "submitting", error: undefined, attempt })
    // A synchronous subscriber may have replaced or resolved the request.
    if (!active(generation, attempt)) return false
    const succeeded = () => {
      if (!active(generation, attempt)) return
      publish({
        ...state,
        status: isPolicyReply(decision) ? "idle" : "awaiting-event",
        stage: "permission",
        message: "",
        error: undefined,
      })
    }
    const failed = (error: unknown) => {
      if (!active(generation, attempt)) return
      publish({ ...state, status: "idle", error: errorText(error) })
      // A subscriber may have changed the request during publication.
      if (!disposed && state.generation === generation && state.attempt === attempt && state.status === "idle")
        callbacks.report?.(error)
    }
    try {
      Promise.resolve(callbacks.send(reply)).then(succeeded, failed)
    } catch (error) {
      failed(error)
    }
    return true
  }

  return {
    getState: () => state,
    choices: () => choices(state.request),
    /** Replacing even the same ID starts a new generation and invalidates old completions. */
    replaceRequest(next: PresenterRequest) {
      if (disposed) return
      publish({
        request: next, stage: "permission", status: "idle", message: "",
        generation: state.generation + 1, attempt: 0,
      })
    },
    /** Route event stream notifications here, including those from another client. */
    resolved(sessionID: string, requestID: string) {
      if (disposed || state.request.sessionID !== sessionID || state.request.id !== requestID ||
        state.status === "resolved") return
      publish({ ...state, status: "resolved", error: undefined })
    },
    setMessage(message: string) {
      if (disposed || state.status !== "idle") return
      publish({ ...state, message, error: undefined })
    },
    open(stage: PresenterStage) {
      if (disposed || state.status !== "idle") return
      if (stage !== "permission" && !choices(state.request).includes(stage)) return
      publish({ ...state, stage, message: "", error: undefined })
    },
    submit,
    submitPolicy(text = state.message) {
      if (disposed || state.status !== "idle" || state.stage !== "policy") return false
      const policy = policyDraft(text, unknownShell(state.request))
      if (policy) return submit({ scope: "session", policy })
      publish({ ...state, stage: "permission", message: "", error: undefined })
      return false
    },
    dispose() {
      disposed = true
    },
  }
}
