# pi extension API alignment

How this extension's use of pi's extension API relates to the documented contract, verified against
**pi 1.5.0** (`PI_API_SNAPSHOT` in `src/index.ts`).

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
