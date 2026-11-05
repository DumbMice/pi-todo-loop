# How it behaves, precisely

The mechanics behind [README](../README.md). Read this when you are debugging behaviour, deciding
whether to change a default, or wondering why the loop did something. It assumes you know that a
**settle** is a model response with no tool calls — the only turn that can end a run.

## The turn it adds

`rpiv-todo` renders and stores the list but never asks pi for another turn. Pi ends a run when the model
answers with no tool calls. This extension hooks that boundary: while the branch has open tasks it
requests one more turn, so the model continues instead of handing control back.

Two consequences follow from that being the only mechanism available:

- **A continuation is a persisted entry.** pi has no "resume without appending anything", so each
  continuation writes one `custom_message` with `display: false` and a constant body that states the
  instruction (`Continue with the open todo tasks…`). It is invisible in the TUI, but it is in the
  session file and, when no block is injected, it is what the model reads.
- **Only a settle spends a round.** `turn_end` fires after every assistant response, including one that
  ended in a tool call; those already cause pi's next request, so they cost nothing and write no marker.
  A round, a strike and a marker therefore always concern a turn that would otherwise have ended the run.

## Markers and role alternation

A marker sits between two assistant turns, which is what keeps the conversation alternating: a request
that contained `assistant → assistant` in a row is rejected by alternation-requiring providers.

The `context` hook therefore keeps a marker only where it separates two assistant turns, and drops it
when either neighbour is user-role: at the tail, immediately before your own message, or in a run of
markers. The block replaces a marker tail, merges into a `user`/`custom` tail, and is appended after an
assistant or toolResult tail.

One exception is documented: `bashExecution`, `branchSummary` and `compactionSummary` tails cannot take
a merge — pi rebuilds those from their own fields and ignores `content` — so the block becomes a
separate message there and the request briefly holds two user-role messages. Losing the list on a
compaction summary would be worse.

## The injected block

While tasks are open, every request ends with an ephemeral `<todo_loop_state>` block: the open tasks with
their ids and statuses, and an instruction that yields to you. It is never persisted, which is why
compaction cannot remove it.

- **The block is user-role text and the last thing in the request.** It sits after your newest message
  and says that your latest instruction outranks it. Models vary in how readily they take that
  concession: one that reads your "stop" as authoritative will refuse, and those refusals cost up to
  `maxRounds` turns. That is the same reason `injectState: false` exists.
- **Task text is sanitised, not interpolated.** Subject, `activeForm` and `status` are model-authored —
  possibly from a fetched page or a repo file — so every Unicode line terminator flattens, `<` is
  escaped, controls/bidi/zero-width characters and unpaired surrogates are dropped, and labels truncate
  by code point. Without this, a task subject could close the tag and forge a directive.
- **The ids are the todo tool's own**, except where the stored list supplies an unusable or duplicate
  id: that row moves to a free number so each row can be addressed, which means a `todo` call using the
  shown number can fail when the tool wrote the list that way.
- **The block escalates once.** On the first request of a chain it only asks for status
  moves; from the first continuation onwards it adds a reconciliation clause — *"if this
  list has drifted from the work, reconcile it now: update statuses, add what is missing,
  and remove what no longer applies"* — with removal last. A first sighting should not
  invite reshaping the list; after a nudge that left the list untouched, a drifted list is
  the likelier explanation. Verified: 115 tests, including both sides of the gate.
- **A list cleared by `todo` calls alone is announced.** If every task goes from open to closed in a
  turn whose only tool results were `todo`, a warning says so once. The loop's success state and its
  failure state are the same observable.

## Counters

| Counter | Meaning | Reset by |
|---|---|---|
| `rounds` | continuations spent for the current human message | a new human message, `/todoloop reset`, a new process |
| `strikes` | settles in a row that left the list unchanged | the list changing, a completed tool turn, a new human message |
| `staleSettles` | settles since the list last changed | the list changing, a new human message |

- **One budget per human message.** A user-role message carrying a `customType` (this extension's
  marker, another extension's hidden message) is skipped when choosing the anchor, so it does not reset
  the budget; `/todoloop` prints the anchor it is using.
- **A stop keeps the budget shut.** Hitting the cap or the strike limit does not clear the counters, so
  another extension's continuation or a provider retry under the same message cannot re-arm 12 rounds.
  A queued human message is a new anchor and resets the budget the ordinary way.
- **A stale list stops on the cap, not on strikes**, because any tool turn clears the strike budget.
  That is why the cap reason appends `, list unchanged for N settles` — so a stale burn does not read
  like healthy work.
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
| `continuing: round 1/12, 2 open` | working as intended |
| `stopped: list is clear` | every remaining task is `completed`; a list whose tasks are all `deleted` reports `no list` instead |
| `stopped: no list` | no recognised todo state on the branch — see the four causes below |
| `stopped: 2 consecutive turns with no progress, 2 open` | the last two settles ran no tool and left the list unchanged |
| `stopped: round cap 12 reached, 2 open` | the budget is spent; with `, list unchanged for N settles` appended, the model worked without updating the list |
| `stopped: turn outcome was error` / `aborted` | the provider failed, or you aborted the turn |
| `paused by user` | `/todoloop pause`; `/todoloop resume` or restart |
| `resumed by user` | `/todoloop resume`; the next settle may continue |
| `counters reset` | `/todoloop reset` cleared the rounds, strikes and list signature |
| `idle` | nothing has run yet in this process |

## Where the list comes from

The list is read from the session branch on every request, never cached: a `rpiv-todo-state` custom
entry's `data.tasks`, or a `todo` toolResult's `details.tasks`, whichever is newer.

That is deliberate. A cache would owe invalidation on session switch, branch, compaction, process start
and fork; and a resumed session with an open list would report `no list` until the model happened to
call `todo` — the failure this package exists to prevent. The cost is one backward walk of the branch,
sub-millisecond on thousands of entries.

Two deviations follow from it:

- **The branch is not the model's context.** After a compaction the model's context drops older
  entries, but the reader still walks the whole branch, so `/todoloop` can report open work the model
  has no list for. The panel and the model can disagree.
- **A newer malformed entry is skipped** in favour of an older valid one, so after a shape change the
  reader serves the list as of that change. Reading an errored `todo` call as "list clear" would be
  worse.

`no list` therefore has four causes: no todo tool installed, a tool that is not named `todo`, a shape
this extension does not recognise, or every task `deleted`.

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
That includes values below `1` — `"maxRounds": 0` means "use 12", not "never continue". Numbers are
clamped so a typo cannot defeat the cap it configures: `maxRounds` ≤ 1000, `maxStrikes` ≤ 100,
`maxInjectedTasks` ≤ 50.

## Cost

- A continuation is a normal model turn: the whole conversation is sent again, so cost scales with the
  number of continuations × session size. `maxRounds` caps continuations, not turns — tool turns are
  pi's own and unbounded, so a long tool-heavy stretch can be many turns for one round. That, not the
  block, is the dominant term.
- `context` reads the config and probes the kill switch, and walks the branch only when it is going to
  inject. `turn_end` does all three on every turn. While tasks are open the block adds ~100 tokens at
  the tail; `injectState: false` adds none and leaves the model to call the todo tool's `list` action.
- One small measurement on `deepseek-flash` (a 2.7k-token session, five turns): ~1,050 uncached input
  tokens per turn with injection on against ~405 with `injectState: false`, and cache reads occurred in
  both runs (16.0k vs 36.1k total). The block does not disable the prompt cache, but it and the head
  rebuild cost a few hundred uncached tokens per request. An order of magnitude, not a benchmark — the
  two runs took different trajectories.

## More

- [pi extension API alignment](pi-api-alignment.md) — the deliberate workarounds, with the pi version
  each was verified against.
- [AGENTS.md](../AGENTS.md) — layout, invariants, tests, release process.
