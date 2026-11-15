# Approved permission shorthand and council requirements

## Permission syntax

- CRUD concerns local filesystem resources by default.
- `=1`: allow one request at the displayed scope.
- `=S`: allow for the conversation family, persisted across application/server restart until revoked or the conversation is deleted.
- `=D`: deny; in a session permission prompt this becomes a session-scoped denial.
- `*` after the value applies the decision recursively through the displayed directory subtree, e.g. `RU=S* CD=D*`.
- `R=-1` / `R=-S`: allow only listing the parent directory, once / for the session. These do not permit reading parent files or sibling subtrees.
- Negative scope is valid only for R and cannot combine with recursion: reject `U=-1`, `R=-S*`, contradictory groups and unknown tokens.
- Invalid input applies nothing and reopens the prompt with the exact error.
- Rules omitted from the shorthand retain existing behavior; do not silently grant omitted operations.
- A session grant covers the selected conversation and its existing/future subagents, not unrelated conversations.
- Explicit configured or session denies remain effective. Reads/updates previously granted must not prompt again; undecided operations still ask.
- `RU=S* CD=D*` allows reading/appending/updating existing files; creating/deleting files is denied. Moves require all corresponding source/destination operations.
- Authorization refers to semantic user-file operations; internal atomic replacement must not be mistaken for permission to create/delete unrelated files.

## Independent tool-availability axis

- `MCP:=playwright` means only that configured MCP server is enabled among MCP servers; native-tool permissions remain separate.
- `:=` is an exact-selection / ONLY operator, not contextual English.
- An available MCP tool does not gain local filesystem permissions merely by being MCP.
- Reuse existing MCP settings and permission maps; a shorthand compiler is not a new permission engine.
- Unmediated external tool effects cannot be certified by names or advisory annotations. State actual enforcement limits; do not promise a universally uncheatable agent.
- `ALL:CRUD=D` is a proposed future all-resource policy, not an implemented local-filesystem guarantee. Unsupported universal enforcement must be rejected clearly rather than partially applied.

## Council/delegation

- Two explicit interaction modes: independent and collaborative.
- Ordered equal-tier reviewer slots preserve repeated models (e.g. Terra, Terra, Astra), followed by a separate judge/tester/executor.
- Independent mode passes no parent conversation or sibling answers to reviewers; a separate fresh judge receives anonymized completed submissions.
- Tool-capability inspection/preflight prevents assigning execution or council orchestration to a worker missing those tools.
- Expose complete mode/strategy catalog via tool enums and a no-inference help/list action.
- Council access must be explicit for intended reviewer agents; it is a native tool, not an MCP exception.

## Delivery constraints

- Preserve unrelated work and previous handoff history.
- Source changes and offline checks only: no Bun invocation, builds, binary replacement, installs, live provider probes, restarts, commits, pushes or CI.
- Do not claim unrun generated-client checks or runtime deployment succeeded.
