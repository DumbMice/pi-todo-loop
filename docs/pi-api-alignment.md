# pi extension API alignment

How this extension's use of pi's extension API relates to the documented contract, and which exact
versions that was established against.

| Component | Tested version | Recorded in |
|---|---|---|
| `@earendil-works/pi-coding-agent` | **1.5.1** | `PI_API_SNAPSHOT` in `src/index.ts` |
| `@juicesharp/rpiv-todo` | **2.15.0** | this file (item 12) |
| Node | 22.23.2 | README *Requirements* (which states the floor, 22.19+) |

Last verified **2026-11-10**. Bump a row here, its constant where one exists, and the README table in
the same commit as the change that depends on it.

The contract is followed where it is documented: `turn_end` boundary proposals, draft entry types,
`context` hook ownership of the message list, `display: false`, `registerCommand`, and `registerTool`
with a hand-written JSON-schema `parameters` object (pi validates any JSON Schema; the `typebox`
import in the docs is a convenience, and avoiding it keeps this package dependency-free). Nothing here
calls pi internals; item 1 nonetheless depends on behaviour pi documents nowhere, which is why it is
listed below rather than assumed.

What is unusual is not the API use but the *shape* of it: this extension exists to perform a
continuation that pi does not expose as a single operation. Each client-side workaround is listed in
full. Items that produce no signal in the transcript are marked _(silent)_.

1. **One hidden entry per continuation, and only on a settle.** `turn_end` fires for every assistant
   response, including one that ended in a tool call; such a turn already causes pi's next request, so
   the hook returns early and spends nothing. `continue: true` is proposed only when the run would
   otherwise end, and the proposed
   projection must end on a message whose role is not `assistant` — otherwise the boundary reports an
   invalid continuation and drops it. pi offers no `resume()` that appends nothing, so a continuation
   is always expressed as *one* appended entry. We append a `custom_message` with `display: false`:
   invisible in the TUI, about 220 bytes per continuation in the journal _(silent in the transcript)_.
2. **Markers stay in history and are not stripped.** They sit between two assistant turns, so they are
   what keeps the conversation alternating: `assistant → marker(user) → assistant`. Removing them
   exposes runs of consecutive assistant messages, which alternation-requiring providers reject — a
   stricter risk than the one marker-per-round growth they cost (about 200 bytes each, bounded by
   `maxRounds` per human message — and only when `maxRounds` is set, since the default is no cap, and they accumulate across messages). Their body is one of two fixed sentences (the plain nudge, or the plain nudge plus the
   `todo_loop_block` clause), so a marker left in
   history cannot claim the loop is on some other round. With the kill switch set the hook rewrites
   nothing, because a disabled extension must not touch the request.
3. **Two different tails are in play, and only one of them is constrained.** pi's boundary checks the
   *persisted projection* when `turn_end` proposes `continue: true`; the appended marker is what
   satisfies that check for this extension (`_buildBoundaryContext().canContinue`, computed from the
   committed drafts — any non-assistant final projected message would do, including a queued one). The
   *provider request* built by the `context` hook is a different list: pi documents no constraint on its
   final role, and a request ending on the assistant message is a normal continuation — the mechanism
   used by `pi-invisible-continue`'s `/continue`
   (<https://github.com/monotykamary/pi-invisible-continue>, not re-tested here). Conflating the two is
   the mistake this item exists to prevent.
4. **The `context` hook only ever removes messages.** It returns a different list in exactly one
   case: a marker of ours sits next to a human message, where it would project to `user → user`. Every
   other request is passed through untouched (`undefined`), including the human's own message and every
   tool turn, so the prompt a human sends is the prompt the model reads. Earlier versions appended a
   state block to each request; that was removed because it rewrote the human's prompt on turns the
   loop did not cause.
5. **Returning a changed list rebuilds the request head.** pi documents that a `context` handler which
   returns a different message list causes it to replay the current prompt sections and tool
   declarations into one leading system message ahead of the returned list. The rebuild is lossless
   (content appended, sections patched, tools resolved) but the head is not byte-identical to the
   previous request, so a prompt cache keyed on the head can miss. Observed while reading pi 1.5.0's
   extension runner; not measured in this repository.
6. **Task state is read from the branch on every request, not cached in memory.** Loop state (counters,
   anchor, pause) is in memory and therefore resets with the process. No `session_compact`
   resync handler is needed, and a branch switch cannot leak another branch's tasks. The cost is one
   backward walk of the active branch per request.
7. **The marker `customType` is a stable literal, not a constant keyed to the package version.**
   Sessions written by earlier builds keep filtering correctly after an upgrade.
8. **Malformed session entries degrade to "no list".** A boundary handler that throws is reported and
   the turn continues, but the loop would silently stop continuing; failing soft keeps the extension
   inert instead of noisy.
9. **`sendUserMessage` and `Agent.prompt` are deliberately not used.** `sendUserMessage` would add a
   visible user-role message per continuation and pollute the transcript; calling the agent directly
   bypasses `AgentSession` lifecycle handling (busy state, queuing, retry, abort).
10. **The kill switch is checked in both hooks and in the block tool, not once at load.** It cannot
    withdraw the tool's prompt entry: pi renders `<tools>`/`<rules>` from the registration, so a
    disabled session still shows an exit whose call is then refused with "not running". Removing it
    would need `pi.setActiveTools` from a hook — a new coupling we did not take for this. Removing it or creating the file
   takes effect on the next request, without `/reload`.
11. **No dependency on `@earendil-works/pi-coding-agent`, and no peer declaration for it.** Nothing
    here imports the package: the boundary is typed `pi: any` and contexts are typed structurally
    (`SessionContext`), so the only manifest link to the host is `pi.extensions`. A `peerDependencies`
    entry would assert a module dependency that does not exist and would have no effect regardless —
    managed installs pass `--omit=peer` and disable peer resolution, and the loader performs no
    compatibility check. The trade-off of dropping the type import: the compiler does not check event
    payload shapes, so `npm test` and a real `pi -e` run carry that weight, and the tested pi version
    is recorded in the table above rather than enforced.
12. **A declared dependency on rpiv-todo's *persisted shape*, which is not its public API** (checked
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
      improvement, not a compatibility fix;
    - a *newer* entry whose `tasks` is malformed is skipped in favour of an older valid one, so after a
      shape change the reader serves the list as of the change. Not treated as authoritative-empty on
      purpose: an errored `todo` call carries no `tasks`, and reading that as "list clear" would stop the
      loop on a failed tool call.

13. **The anchor skips user-role messages that carry a `customType`** _(silent)_. `anchorFromEntry`
    ignores any `role: "user"` message with a string `customType`, which covers this extension's own
    marker, another continuation extension's hidden resume message, and a command expansion that carries
    one. The alternative — narrowing the skip to our own marker type — would let another extension's
    hidden message move the anchor on every continuation and re-arm the budget each round, which defeats
    the cap; the cost of the broad skip is that such a message does not reset the budget either. That is
    one budget for one message, self-healing on the next plain message and visible in
    `/todoloop`'s `anchor` line.

14. **The loop's counters are not reconstructible from the session file** _(silent)_. A `turn_end`
    handler is handed `outcome`, `entries` and `continue`; what a `-p`/JSON run persists for the event
    carries only `{type, message, toolResults}`. A session file therefore shows which continuations happened and
    when, not how many rounds or stalls were left, nor why the loop stopped; that is only visible live
    through `/todoloop`. Two runs that end for different reasons can look identical on disk.

15. _(Inapplicable since the state block was removed.)_ Three user-role tails —
    `bashExecution`, `branchSummary`, `compactionSummary` — cannot take a merged `content`, because pi
    rebuilds those from their own fields. Nothing is merged into them now: the only text this
    extension adds is a standalone marker message, which needs no merge and creates no adjacency.
16. **The reader walks `getBranch()`, which is not the model-visible context.** pi's compaction-aware
    projection is `buildContextEntries()`, and a `context_edit` can hide an entry from future model
    context while it stays on the branch. Reading the branch therefore means the extension can report a
    task list the model cannot see — after a compaction, or after another extension edited context. Kept
    deliberately: the newest persisted todo state is the right answer for the loop's counters, and
    reading the projected context instead would make the list vanish mid-run, which is the failure this
    package exists to prevent.
