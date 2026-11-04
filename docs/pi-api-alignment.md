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
calls pi internals; item 1 nonetheless depends on behaviour pi documents nowhere, which is why it is
listed below rather than assumed.

What is unusual is not the API use but the *shape* of it: this extension exists to perform a
continuation that pi does not expose as a single operation. Each client-side workaround is listed in
full. Items that produce no signal in the transcript are marked _(silent)_.

1. **One hidden entry per continuation.** `turn_end` accepts `continue: true`, but the proposed
   projection must end on a message whose role is not `assistant` — otherwise the boundary reports an
   invalid continuation and drops it. pi offers no `resume()` that appends nothing, so a continuation
   is always expressed as *one* appended entry. We append a `custom_message` with `display: false`:
   invisible in the TUI, about 120 bytes per continuation in the journal _(silent in the transcript)_.
2. **Every marker is stripped from every request.** Markers are persisted, one per continuation, so the
   `context` hook removes every message whose `customType` is `todo-loop:continue` before
   serialization — not only the newest one. Leaving them in would grow the request prefix by one
   user-role block per continuation for the rest of the session, and the model would read `n="k"`
   markers implying the loop is still running. With the kill switch set the hook does nothing at all,
   because a disabled extension must not rewrite the request.
3. **Two different tails are in play, and only one of them is constrained.** pi's boundary checks the
   *persisted projection* when `turn_end` proposes `continue: true`; the appended marker is what makes
   that projection end non-assistant (`_buildBoundaryContext().canContinue`). The *provider request*
   built by the `context` hook is a different list, and it may legitimately end on the assistant
   message — that is a normal continuation of the assistant turn, and it is the mechanism used by
   pi-invisible-continue's `/continue`. Conflating the two is the mistake this item exists to prevent.
4. **With `injectState: false` the marker is stripped and nothing replaces it.** The request then ends
   on the assistant message, which is accepted by the providers tested here; the model receives no
   `todo_loop_state` block and must call the todo tool's `list` action to learn the list. This is the
   one configuration where the extension asks the model for compliance instead of enforcing state.
5. **Task state is read from the branch on every request, not cached in memory.** Loop state (counters,
   anchor, pause) is in memory and therefore resets with the process. No `session_compact`
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
10. **No dependency on `@earendil-works/pi-coding-agent`, and no peer declaration for it.** Nothing
    here imports the package: the boundary is typed `pi: any` and contexts are typed structurally
    (`SessionContext`), so the only manifest link to the host is `pi.extensions`. A `peerDependencies`
    entry would assert a module dependency that does not exist and would have no effect regardless —
    managed installs pass `--omit=peer` and disable peer resolution, and the loader performs no
    compatibility check. The trade-off of dropping the type import: the compiler does not check event
    payload shapes, so `npm test` and a real `pi -e` run carry that weight, and the tested pi version
    is recorded in the table above rather than enforced.
11. **A declared dependency on rpiv-todo's *persisted shape*, which is not its public API** (checked
    against `@juicesharp/rpiv-todo` 2.15.0; the symbols named below are that version's). This
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
