# pi extension API alignment

How this extension's use of pi's extension API relates to the documented contract, and which exact
versions that was established against.

| Component | Tested version | Recorded in |
|---|---|---|
| `@earendil-works/pi-coding-agent` | **1.5.0** | `PI_API_SNAPSHOT` in `src/index.ts` |
| `@juicesharp/rpiv-todo` | **2.15.0** | this file (item 11) |
| Node | 22.23.2 | README *Tested against* |

Last verified **2026-11-04**. Bump a row here, its constant where one exists, and the README table in
the same commit as the change that depends on it.

The contract is followed where it is documented: `turn_end` boundary proposals, draft entry types,
`context` hook ownership of the message list, `display: false`, and `registerCommand`. Nothing here
reaches into pi internals beyond the public extension surface.

What is unusual is not the API use but the *shape* of it: this extension exists to perform a
continuation that pi does not expose as a single operation. Each client-side workaround is listed in
full. Items that produce no signal in the transcript are marked _(silent)_.

1. **One hidden entry per continuation.** `turn_end` accepts `continue: true`, but the proposed
   projection must end on a message whose role is not `assistant` — otherwise the boundary reports an
   invalid continuation and drops it. pi offers no `resume()` that appends nothing, so a continuation
   is always expressed as *one* appended entry. We append a `custom_message` with `display: false`:
   invisible in the TUI, ~40 characters in the journal _(silent in the transcript)_.
2. **The marker is stripped from the provider request.** The `context` hook removes any message whose
   `customType` is `todo-loop:continue` before serialization, so the model never sees the marker.
3. **Stripping the marker alone would be wrong.** Removing it leaves the request ending on an
   assistant message, which some providers reject. Whenever the marker is stripped, the authoritative
   task block is appended as a user-role message instead, so the tail is always non-assistant. The two
   operations are coupled by construction; do not implement one without the other.
4. **With `injectState: false` the marker is kept rather than stripped.** The marker then carries the
   continuation and the tail, at the cost of the model seeing `<todo_loop n="1" open="2"/>`
   _(silent in the TUI, visible in context)_.
5. **State is read from the branch on every request, not cached in memory.** No `session_compact`
   resync handler is needed, and a branch switch cannot leak another branch's tasks. The cost is one
   backward walk of the active branch per request.
6. **The marker `customType` is a stable literal, not a constant keyed to the package version.**
   Sessions written by earlier builds keep filtering correctly after an upgrade.
7. **Malformed session entries degrade to "no list".** A boundary handler that throws is reported and
   the turn continues, but the loop would silently stop continuing; failing soft keeps the extension
   inert instead of noisy.
8. **`sendUserMessage` and `Agent.prompt` are deliberately not used.** `sendUserMessage` would add a
   visible user-role message per continuation and pollute the transcript; calling the agent directly
   bypasses `AgentSession` lifecycle handling (busy state, queuing, retry, abort).
9. **The kill switch is checked in both hooks, not once at load.** Removing it or creating the file
   takes effect on the next request, without `/reload`.
10. **No pi type import; `pi: any` at the registration boundary.** The extension is imported by pi at
    runtime, and importing `@earendil-works/pi-coding-agent` for one signature would make it a
    dependency of a package that is meant to have none. Contexts this file reads are typed
    structurally (`SessionContext`) rather than nominally. The trade-off: the compiler does not check
    event payload shapes, so `npm test` and a real `pi -e` run carry that weight.
11. **A declared dependency on rpiv-todo's *persisted shape*, which is not its public API.** This
    extension imports nothing from `@juicesharp/rpiv-todo` and therefore declares no dependency on it,
    but it reads two representations the package writes: `custom` entries with
    `customType: "rpiv-todo-state"`, and `todo` toolResult `details.tasks`. The package's own issues
    describe `details` as extension-specific session data, so a change to that shape is not
    guaranteed to appear in its semver. Consequences, accepted deliberately:
    - the reader is written defensively (both shapes tried, `subject`/`content` accepted, malformed
      entries treated as "no list") so a drift degrades to inert rather than throwing in a boundary;
    - the tested version is recorded above, not enforced;
    - the parser is duplicated rather than imported. `@juicesharp/rpiv-todo/state/replay.ts` does
      export `replayFromBranch` and `isTaskDetails`, but a peer import would resolve to nothing under
      pi's `--omit=peer` installs, and a declared dependency would make pi install a second nested
      copy of the extension — which registers a duplicate `todo` tool.
    - failure is currently indistinguishable from "the agent never called `todo`": both report
      `stopped: no list` in `/todoloop`. Making those cases distinguishable is the next diagnostic
      improvement, not a compatibility fix.
