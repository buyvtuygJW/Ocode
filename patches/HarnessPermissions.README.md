# Harness permission source patch

**Current status:** Permission changes are embedded in the mandatory `FinalPERSONALIZE.patch` and the autorelease fails if they are missing, altered, fail to apply, or fail their required tests. `HarnessPermissions.base.patch` is the pinned, rebased source segment used to regenerate and verify that mandatory base. Changes remain local and undeployed.

The following records describe the original, separate source patch retained for provenance; it is not the active base segment:

- Patch: `HarnessPermissions.patch`
- Exact file hashes: `HarnessPermissions.manifest.json`
- Base source: `eedb7fb3d0b984a606812adee6eb25d23415882f` reconstruction
- Status: implemented and checked offline; **not deployed**

## Inputs

For a pending filesystem permission request, use the directory-policy input:

```text
RU=S* CD=D*
```

`=1` allows one request, `=S` persists for the conversation family across restart, `=D` denies for that family, and `*` makes the selected directory recursive. `R=-1` / `R=-S` allow only exact parent-directory listing. Invalid or contradictory input changes nothing; omitted operations retain ordinary permission behavior.

MCP selection uses the existing configuration loader:

```json
{
  "experimental": {
    "mcp_selection": "MCP:=playwright"
  }
}
```

Names must already exist in `mcp.servers`. Selected configured servers become enabled; the other configured servers become disabled. Native-tool permissions and each server's other settings remain intact. Higher-priority config selection wins. Invalid selections and filesystem tokens reject before editor changes. Directory permission replies reject MCP tokens; the configuration input rejects filesystem grants.

MCP availability is not filesystem authorization. Unknown MCP effects remain blocked under session filesystem denies. Unknown shell effects require an explicit prompt: allow one, CRUD policy (`Unknown=1` or `Unknown=S`), or deny. `Unknown=S` is bound to the exact session, command, shell, working directory and deny set; `*` is not supported. Approval can bypass filesystem denies, and scripts and dependencies can change. Only a very narrow literal PowerShell output command is currently recognized as effect-free. Separately attached MCP clients are outside configured-server selection; no universal effect sandbox is claimed.

## Storage and revocation

Session grants use reserved permission rules with action `__opencode_filesystem_session_v1` on the root conversation, published through canonical `session.permissions` durable events. Existing rules are preserved; sequence checking rejects stale concurrent merges before commit.

To revoke, read the root session's permissions and remove the relevant reserved entries using the existing session-update API, retaining unrelated rules. Removing the root conversation removes its stored grants. Runtime enforcement resolves the root rather than relying on stale copies inherited by children.

## Evidence

- CRUD helpers/service: 15 Node tests passed, including replay/revocation and stale publication rollback.
- MCP config registration: 4 Node fixtures passed.
- Web permission lifecycle: 2 Node tests passed.
- Shared parser/MCP leaf markers: 9 scratch Node fixtures passed.
- Official client generator executed unmodified under Node with real schema/protocol/codegen and NodeFileSystem. Four changed generated files were copied verbatim; 11 generated files were checked.
- Focused TypeScript API checks: zero diagnostics in selected changed files; full/transitive checking unverified.
- Strict diff parsing and exact forward/reverse reconstruction against the recorded base passed.

After normal dependencies are available, focused repository fixtures can be run from their packages:

```text
# packages/core
node --experimental-transform-types --test test/permission/session-grant.test.mjs test/permission/service.node.test.mjs test/config/mcp-selection.node.test.mjs

# packages/app
node --test src/session/requests/permission-machine.node.test.mjs
```

Scratch validation additionally used `PERSONALIZE_EFFECT` to point to the existing cached Effect runtime; it is not a production setting.

Native SQLite/real Bus integration, actual file-side-effect E2E, browser rendering, the app benchmark, canonical Bun checks, and new git-apply verification were not run. Filesystem containment is lexical, not symlink-proof. No builds, restarts, commits, pushes, or CI runs were performed.
