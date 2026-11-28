import { Data, DateTime, Effect } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SessionEvent } from "../session/event.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"

// User-approved local creation time; never substitute UTC or the rename time.
export const dateTitle = (created: DateTime.Utc) => {
  const date = new Date(DateTime.toEpochMillis(created))
  const two = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`
}

class TitleChanged extends Data.TaggedError("SessionTitle.TitleChanged") {}

// Share the rename transaction between creation and title generation without
// requiring callers that already hold the services to construct another layer.
export const createTitleRenamer = (deps: {
  bus: Bus.Interface
  store: SessionStore.Interface
  db: Database.Interface["db"]
  conflict?: () => { readonly _tag: "SessionTitle.TitleChanged" }
}) => Effect.fn("Personalize.renameIfUnchanged")(function* (
  session: SessionSchema.Info,
  title: string,
) {
  const { bus, store, db } = deps
  while (true) {
    const expected = (yield* Bus.latestSequence(db, session.id)) + 1
    const current = yield* store.get(session.id)
    if (!current || current.title !== session.title) return false
    if (current.title === title) return true
    const committed = yield* bus.publish(SessionEvent.Renamed, { sessionID: session.id, title }, {
      commit: (sequence) => sequence === expected ? Effect.void : Effect.fail(
        deps.conflict ? deps.conflict() : new TitleChanged(),
      ),
    }).pipe(
      Effect.as(true),
      Effect.catchTag("SessionTitle.TitleChanged", () => Effect.succeed(false)),
    )
    if (committed) return true
    // An unrelated event must not strand an unnamed session. Re-read the title
    // before retrying; a real rename or deletion still wins.
  }
})

// The projection and event roll back if anything wins the race before commit.
export const renameIfUnchanged = Effect.fn("Personalize.renameIfUnchanged")(function* (
  session: SessionSchema.Info,
  title: string,
) {
  const bus = yield* Bus.Service
  const store = yield* SessionStore.Service
  const { db } = yield* Database.Service
  return yield* createTitleRenamer({ bus, store, db })(session, title)
})
