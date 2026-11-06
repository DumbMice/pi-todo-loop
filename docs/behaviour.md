# How it behaves, precisely

The mechanics behind [README](../README.md). Read this when you are debugging behaviour, deciding
whether to change a default, or wondering why the loop did something. It assumes you know that a
**settle** is a model response with no tool calls — the only turn that can end a run.

The rule the whole design follows: **the extension never edits your prompt.** It appends one hidden
nudge at a stop and otherwise keeps out of the conversation. Reading and updating the list is the
agent's job, through the todo tool it already has.

## The turn it adds

`rpiv-todo` renders and stores the list but never asks pi for another turn. Pi ends a run when the model
answers with no tool calls. This extension hooks that boundary: while the branch has open tasks it
requests one more turn, so the model continues instead of handing control back.

Two consequences follow from that being the only mechanism available:

- **A continuation is a persisted entry.** pi has no "resume without appending anything", so each
  continuation writes one `custom_message` with `display: false` and one of two constant bodies:
  *"Continue with the open todo tasks; use the todo tool to read and update the list. If the human's
  latest instruction says to stop or limits what to do, do that instead."* It is invisible in the TUI,
  but it is in the session file, it is what the model reads, and it is the only text this extension
  ever adds.
- **Only a settle spends a round.** `turn_end` fires after every assistant response, including one that
  ended in a tool call; those already cause pi's next request, so they cost nothing and write no marker.
  A round, a stall and a marker therefore always concern a turn that would otherwise have ended the run.

## Markers and role alternation

A marker sits between two assistant turns, which is what keeps the conversation alternating: a request
that contained `assistant → assistant` in a row is rejected by alternation-requiring providers.

The `context` hook may remove a marker and nothing else. It drops one when either non-marker neighbour
is user-role — next to your own message, or in a run of markers — because that position would project to
`user → user`. A marker at the tail always stays: it is the nudge, and dropping it would leave the
continuation request ending on an assistant turn, which is the shape pi refuses to continue from.

The hook returns `undefined` when nothing needs removing, so an ordinary request is passed through as
the object it already was — not re-built, not extended.

## Stalls, and the block tool

Nothing here stops the loop for being quiet. A model that keeps answering without moving the list is
kept alive — until the list clears, the agent asks for a person, you stop it, or a cap you configured
is reached — because "stuck" and "waiting for a person" look identical from the outside, and one of them
must not be punished. Without a cap that means it keeps costing turns; every tenth settle that changes
nothing raises a warning so it does not do so invisibly.

- A **settle** whose task signature is unchanged increments `stalled`; a settle that changed the list
  resets it. The counter has no cap: it decides *when to ask*, not when to give up.
- On the first settlement since progress that finds `stalled >= 1` — one stop that did not move the
  list — the nudge is the variant that adds *"If you cannot proceed without a person, call
  `todo_loop_block` with the reason."* It is offered **once per stall**; tool work re-arms it, so a
  second, separate stall after real progress is a new question.
- A **tool turn** clears `stalled`. Work is progress even when the list was not touched.
- **`todo_loop_block`** is the agent's own exit. It is advertised in the prompt from the first turn —
  pi lists it in `<tools>` and carries its guideline in `<rules>`, because the tool declares a
  `promptSnippet` — and the nudge is the timed offer, not the only way to learn it exists. It takes a
  reason, stores `{reason, anchor}` in memory and stops continuations for that message. The human is notified, `/todoloop` shows
  `waiting for you: <reason>`, and the human's next message is a new anchor, so the block clears itself
  — there is no unblock call.
- A block with an empty reason is refused, and the loop keeps running: the reason is the whole point.
  The tool also refuses while the loop is paused or a kill switch is present, and says so, so a
  disabled extension never notifies or writes state.
- **`staleSettles`** counts settles since the list last changed; a tool turn that leaves the list
  unchanged does not clear it. It
  never injects anything and never stops anything: it only decorates the reason string
  (`, list unchanged for N settles`) so a burn to a configured cap does not read like healthy work.
- **A list cleared by `todo` calls alone is announced.** If every task goes from open to closed in a
  turn whose only tool results were `todo`, a warning says so once. The loop's success state and its
  failure state are the same observable.

## Counters

| Counter | Meaning | Reset by |
|---|---|---|
| `rounds` | continuations spent for the current human message | a new human message, `/todoloop reset`, a new process |
| `stalled` | settles in a row that left the list unchanged — no cap; it decides when the block hint is offered | the list changing, a completed tool turn, a new human message |
| `staleSettles` | settles since the list last changed | the list changing, a new human message |

- **One budget per human message.** A user-role message carrying a `customType` (this extension's
  marker, another extension's hidden message) is skipped when choosing the anchor, so it does not reset
  the budget; `/todoloop` prints the anchor it is using.
- **A stop keeps the budget shut.** Hitting the cap does not clear the counters, so
  another extension's continuation or a provider retry under the same message cannot re-arm the budget.
  A queued human message is a new anchor and resets the budget the ordinary way.
- **A stale list stops on the cap when one is set**, never earlier: any tool turn clears the stall.
  That is why the cap reason appends `, list unchanged for N settles`.
- **Errors do not close the budget.** A turn that ends `error` or `aborted` stops the loop for that turn
  and spends no round; the counters are left as they are, so the next settle under the same message can
  continue — which is what a provider retry hits.
- **A stop is announced** once, when the reason changes, so a run cannot end silently on a cap.
- **Counters live in memory.** `/reload`, a restart or a resumed session starts a new budget and
  re-reads the list; a pause does not survive either.

### Reason strings

`/todoloop` prints one of these as `last:`. They are also announced when they change.

| `last:` | Meaning |
|---|---|
| `continuing: round 1, 2 open` | working as intended (`round 1/12` when `maxRounds` is set) |
| `stopped: list is clear` | every remaining task is `completed`; a list whose tasks are all `deleted` reports `no list` instead |
| `stopped: no list` | no recognised todo state on the branch — see the five causes below |
| `waiting for you: waiting on Dana's review` | the agent called `todo_loop_block`; your next message resumes |
| `stopped: round cap 12 reached, 2 open` | the budget is spent; `, list unchanged for N settles` means it worked without updating the list, `, the agent stalled and may need a person` means the last round was one stop that did not move the list |
| `stopped: turn outcome was error` / `aborted` | the provider failed, or you aborted the turn |
| `paused by user` | `/todoloop pause`; `/todoloop resume` or restart |
| `resumed by user` | `/todoloop resume`, or the human's next message clearing a pending block; the next settle may continue |
| `counters reset` | `/todoloop reset` cleared the rounds, stalls, list signature and any pending block |
| `idle` | nothing has run yet in this process |

## Where the list comes from

The list is read from the session branch on every turn, never cached: a `rpiv-todo-state` custom
entry's `data.tasks`, or a `todo` toolResult's `details.tasks`, whichever is newer.

That is deliberate. A cache would owe invalidation on session switch, branch, compaction, process start
and fork; and a resumed session with an open list would report `no list` until the model happened to
call `todo` — the failure this package exists to prevent. The cost is one backward walk of the branch,
sub-millisecond on thousands of entries.

Two deviations follow from it:

- **The branch is not the model's context.** After a compaction the model's context drops older
  entries, but the reader still walks the whole branch, so `/todoloop` can report open work the model
  has no list for. This is the hole the removed injection used to paper over: a model that has been
  compacted may not know the list exists until it calls `todo` or is nudged. The nudge is the reminder;
  the tool is the source.
- **A newer malformed entry is skipped** in favour of an older valid one, so after a shape change the
  reader serves the list as of that change. Reading an errored `todo` call as "list clear" would be
  worse.

`no list` therefore has five causes: the model never called the `todo` tool in this session, no todo
tool installed, a tool that is not named `todo`, a shape this extension does not recognise, or every
task `deleted`.

## Scope

- **A delegated child session runs its own loop.** Each session has its own list and counters, so a
  subagent that loads this extension can continue independently of its parent; markers do not
  interleave, but the work can.
- **`/todoloop` needs an interactive session.** In `pi -p` and `--mode json` the loop runs, but there is
  no UI for the status or the stop notification; the only signal is the marker count in the session
  file and the model's final message.
- **`.pi/todo-loop-off` stops every session started in that directory**; `~/.pi/agent/todo-loop-off`
  stops all projects; the config file is global and re-read on every request, so editing it affects
  running sessions.
- **Nothing is written to your working tree.** The reads are the config, the two kill-switch paths and
  the session branch.

## Configuration limits

Invalid config never fails a turn: missing, unreadable or invalid values fall back to the defaults.
`maxRounds` is `null` by default, which means no limit: the loop ends when the list clears, the agent
blocks, or you stop it. Set a number to bound what one message of yours can cost; it is clamped so a
typo cannot defeat it (`maxRounds` ≤ 1000), and a value below 1 stays unlimited rather than becoming
"never continue".

## Cost

- A continuation is a normal model turn: the whole conversation is sent again, so cost scales with the
  number of continuations × session size — and each continuation lengthens the conversation the next
  one re-sends, so a runaway grows faster than that product suggests. With the default there is no
  continuation cap, so a model
  that keeps stopping without moving the list keeps costing turns until the list clears or you stop
  it; set `maxRounds` if you want a hard bound. Tool turns are pi's own and unbounded either way, so a
  long tool-heavy stretch can be many turns for one round.
- The extension adds one short marker per continuation (~40 tokens), plus one constant tool declaration
  and the prompt entries pi derives from it — `<tools>` line, `<rules>` guideline, description and
  schema, roughly 700 characters together, in every request. None of it carries task state, and there
  is no per-request block. Neither the snippet nor the guideline is gated by the kill switch or
  `/todoloop pause`; only the hooks and the call itself are. Whatever the model needs it reads with the `todo` tool, and that result
  is part of its own conversation rather than a parallel copy.
- `context` walks the branch and returns `undefined` unless a marker actually has to be removed, so on
  a normal turn it costs one projection pass. `turn_end` reads the config, probes the kill switches and
  walks the branch on every turn.

## More

- [pi extension API alignment](pi-api-alignment.md) — the deliberate workarounds, with the pi version
  each was verified against.
- [AGENTS.md](../AGENTS.md) — layout, invariants, tests, release process.
