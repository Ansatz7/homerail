# Scoped Worker workspace write boundaries

A workflow `workspace_access` is an execution boundary, not only an after-run
check. Manager passes the normalized policy through Worker provisioning and the
Node lifecycle request (`spec.workspace_access`). Node binds `/workspace` read
only, binds each declared writable target read/write, and overlays protected
entries read only. Scoped dispatch cannot use an unprovisioned generic Worker.
Manager, Node and Worker must all include this implementation when building a
runtime. Existing services are not updated merely by building this repository.

## Supported policy

```yaml
workspace_access:
  writable_paths:
    - source/android-shell/plugins/example
    - source/android-shell/vendor/example/lib/host-plugin.js
    - source/android-shell/vendor/example/ANDROID-PATCHES.md
  readonly_paths:
    - input
    - source/docs
    - source/android-shell/plugins/example/protected.txt
```

* Up to 32 disjoint, non-root writable paths; each must already exist as a
  regular file or directory when Node creates the container. For a new file,
  the supervisor must explicitly pre-create an empty file during trusted
  workspace preparation. Node refuses missing targets instead of guessing their
  type or opening their parent. Static validation checks shape; filesystem checks
  run on Node before `provider.create`.
* A directory grant permits new files and directories within that directory.
  A file grant supports reads, truncation and in-place writes. Renaming over,
  deleting, or replacing a file bind mount is unsupported (typically EBUSY).
  Configure an editor to write in place or explicitly select the parent strategy
  below. HomeRail never widens the grant automatically after an editor error.
* The workspace root, input, source siblings and receipts stay read only. Existing
  `AGENTS.md`, `.git`, `node_modules`, `receipts`, and `.homerail-runtime` entries
  inside a writable directory receive read-only overlays regardless of the legacy
  `git_metadata_read_only` flag. `/workspace/.homerail-runtime` itself remains a
  separate **trusted runtime telemetry** write mount; never put authoritative
  inputs or receipts there. It is not a model output grant or a secret store.
* Existing protected file contents and mount points cannot be overwritten or
  unlinked. Intermediate directories containing a read-only protection are also
  bind-mounted within the existing write grant, so renaming a parent cannot
  replace the protected pathname. A directory grant still allows creating new names: it cannot provide
  a kernel deny-by-basename rule for every future `AGENTS.md` or `.git` entry.
  Worker rejects protected-path changes at handoff, including creation/removal of
  a previously absent excluded Git root. If the requirement is OS-level denial
  of all new names, select existing **file** grants instead of a directory grant.
* A read-only path **inside** a writable directory is a protection and wins in
  both mounts and Worker policy. A read-only ancestor of (or identical to) a
  writable path is rejected. Do not combine `readonly_paths: [source]` with a
  source subtree write grant: the implicit read-only root already protects the
  rest of source. Duplicate/nested write grants are rejected. A narrower
  read-only protection must exist before dispatch; a missing one is rejected.
* Backslashes, one leading `./`, and trailing slashes normalize consistently.
  Absolute paths, drive-qualified paths, traversal, empty/internal-dot segments,
  unsupported characters (allowed segments: letters, digits, `.`, `_`, `-`),
  protected write roots and root `.` are rejected. Fanout placeholders are checked
  symbolically during compilation and concretely after expansion at dispatch.
* Bind-source ancestors cannot be symlinks. Write grants cannot contain symlinks
  or multiply-linked writable files. Workspace symlinks cannot escape the root,
  alias protected metadata, or point into/above a write grant. Checks are bounded
  to 100,000 workspace entries and 256 total mounts; exceeding a limit fails
  closed. Workspaces must remain under trusted host control during provisioning;
  these checks are not a lock against another host process replacing files.
* No extra capabilities, Docker socket or remount permission are granted. The
  legacy `workspace_writable_subpath` API remains accepted. If both APIs are
  supplied, the old value must match the sole new write grant, otherwise creation
  fails. New Manager requests always carry a read-only root; an older Node that
  ignores the new multi-path field cannot turn that root writable, but it also
  cannot fulfill the write grants. Rebuild all components for supported operation.

## Explicit minimum-parent alternative for atomic editors/new files

If both `vendor/example/lib/host-plugin.js` and a new
`vendor/example/ANDROID-PATCHES.md` must be written with atomic rename, their
smallest common directory is `vendor/example`. A supervisor may explicitly grant
that directory and list **every existing unrelated entry** as a narrower
read-only protection. For a fixture containing only `lib/host-plugin.js` and
`lib/neighbor.js`, this policy is sufficient:

```yaml
workspace_access:
  writable_paths:
    - source/android-shell/plugins/example
    - source/android-shell/vendor/example
  readonly_paths:
    - input
    - source/android-shell/vendor/example/lib/neighbor.js
```

For a real vendor tree, inventory its entries first: add each unrelated top-level
file/directory and each unrelated file in `lib` to `readonly_paths` (except
automatically protected `.git`, `.homerail-runtime` and `node_modules`, which
remain reserved and must not be explicitly listed). Do not list
`lib` itself when `lib/host-plugin.js` must be writable. Existing protected
metadata is overlaid automatically. A changed tree requires a fresh inventory.
If the 128 explicit read-only paths / 256 mounts limit is exceeded, use file
binds and in-place editing or stop with a configuration blocker.

**Tradeoff:** new temporary files and other new names can be created anywhere
under this explicitly writable parent except existing read-only submounts. This
is a bounded directory grant, not equivalent to the original two-file allowlist.
Use file binds when that wider creation scope is unacceptable. No fallback can
silently select this strategy, and `/workspace` remains read only in either case.

## Reusable verification

`homerail_manager/tests/workspace-mount-chain.test.ts` exercises a real database
workflow/profile and model resolver, ChangeOrchestrator, WsDispatchAdapter,
provision lifecycle wire serialization, Node handler and mount policy, and Worker
snapshot verification. Only control-plane socket I/O and the external provider
are fixtures; no model is called. It checks that a generic Worker cannot bypass
scoped provisioning and that invalid filesystem boundaries fail before creation.

From `homerail_manager`, opt into independent Docker file-permission checks using
an already installed Alpine image:

```sh
HOMERAIL_TEST_DOCKER_IMAGE=alpine:3.20 \
  ./node_modules/.bin/vitest run tests/workspace-mount-chain.test.ts
```

The tests use fresh temporary workspaces, the exact Node-produced mount list,
`--network=none`, no credentials, no capabilities, no Docker socket, read-only
container rootfs, and the host fixture owner's UID/GID. They never contact a
Manager, start a Worker harness, or manipulate a deployed service. Both file-bind
and explicit-parent cases verify allowed writes and denied protected writes;
file-bind rename must fail and parent-directory atomic rename must succeed.
`HOMERAIL_TEST_EVIDENCE_DIR` can point to an existing local directory to retain
small permission logs. Container operations use `--rm` and `--pull=never`.
