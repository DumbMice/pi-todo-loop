# pi-todo-loop

[![npm version](https://img.shields.io/npm/v/pi-todo-loop)](https://www.npmjs.com/package/pi-todo-loop)
[![license](https://img.shields.io/npm/l/pi-todo-loop)](https://github.com/DumbMice/pi-todo-loop/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/pi-todo-loop)](https://github.com/DumbMice/pi-todo-loop/blob/main/package.json)
[![tests](https://github.com/DumbMice/pi-todo-loop/actions/workflows/test.yml/badge.svg)](https://github.com/DumbMice/pi-todo-loop/actions/workflows/test.yml)

An extension for the [pi coding agent](https://pi.dev) that keeps the agent working while a todo list
written by [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
still has open tasks, and keeps that list in front of the model across compaction. `rpiv-todo` renders
and stores the list; it never asks pi for another turn. This adds the turn.

## Example

An ideal run — the model keeps the list current, so the loop has something to follow:

```text
you:  make the whole sequence web-editable, then expose it in the browser

pi:   [calls todo: 12 tasks created, first marked in_progress]
pi:   T5 backend is in and verified; committing a report of the state …
      ← normally the run ends here. Two tasks are still open, so pi-todo-loop
        requests one more turn and injects the open list at the tail.

pi:   [calls todo: T5 completed, T6 in_progress]
pi:   T6 audio/face lanes wired. T7 per-camera PNG export next …

pi:   [calls todo: all 12 completed]
pi:   All 12 tasks are complete. Everything below is verified: …
      ← list is clear → the loop stops and stays stopped
```

That is the happy path. The other two are just as common, and the counters decide them:

```text
pi:   T5 backend is in and verified; committing a report …
      ← open tasks remain, but the model answered in prose and did not touch
        the list: strike 1, one more turn.

pi:   The work is done as far as I can tell.
      ← still no tool call and no list change: strike 2 → stopped:
        2 consecutive turns with no progress, 2 open

pi:   [after every turn: tool calls, but todo is never updated]
      ← rounds advance on tool activity alone, so the loop spends the full
        maxRounds (12) and then reports: stopped: round cap 12 reached
```

## When to use it

- Long, multi-step work where the agent summarises and hands control back halfway.
- Sessions that get compacted: the list survives in the session branch, but the **model** loses it,
  because the snapshot lives in entry `details` and pi does not send that to the LLM.
- A model that runs tools but rarely updates the list. Expect what the counters predict: a model that
  answers in prose only gets **two** continuations before the strike budget stops it; a model that runs
  tools but leaves the list stale keeps the loop alive for the full `maxRounds` per message, with the
  injected statuses as stale as the list. See
  [rpiv-mono#259](https://github.com/juicesharp/rpiv-mono/issues/259), where DeepSeek models display a
  list but do not update it.

## When not to use it

- You have no todo tool installed. Without a list there is nothing to continue; the extension is inert.
- You want an autonomous loop against an acceptance criterion. This drives an existing task list; it
  does not invent goals, and it stops after `maxRounds` (default 12) per human message.
- You want the continuations visible in the transcript. They are hidden by design.
- You dislike the model being steered while work is open. The injected block is an instruction, and it
  is the last thing in the request — see [Behaviour to expect](#behaviour-to-expect).

## Install

```bash
# from npm
pi install npm:pi-todo-loop

# straight from the repository
pi install git:github.com/DumbMice/pi-todo-loop
```

Then `/reload` (or restart).

Requirements:

| | |
|---|---|
| pi | tested on **1.5.0**; needs the `turn_end` boundary with `continue` and draft `entries`. Older versions are unverified |
| todo tool | any tool named `todo` that persists `rpiv-todo-state` custom entries or `todo` toolResult `details.tasks`; tested with `@juicesharp/rpiv-todo` **2.15.0**. Not declared in the manifest on purpose — see [docs/pi-api-alignment.md](docs/pi-api-alignment.md) item 11 |
| Node | `>= 22.6` for the test runner; the extension has no runtime dependencies |

Tested against, not merely required:

| Component | Version | What was verified |
|---|---|---|
| `@earendil-works/pi-coding-agent` | **1.5.0** | boundary `continue` + `entries`, `display: false`, marker handling through the `context` hook, `/todoloop` registration, resume after a continuation |
| `@juicesharp/rpiv-todo` | **2.15.0** | `rpiv-todo-state` custom entry shape, `todo` toolResult `details.tasks`, branch replay after `/reload` and compaction |
| Node | 22.23.2 | `npm test`, `npm run typecheck`, `pi -e` smoke runs |

Last verified **2026-11-04**. The same table, and the rule that it moves together with
`PI_API_SNAPSHOT`, is in [docs/pi-api-alignment.md](docs/pi-api-alignment.md).

**One continuation extension at a time.** Two copies of this extension, or this one plus another
extension that returns `turn_end` continuations, both request turns and make the counters and the
budget meaningless. `pi list` shows the installed sources; remove one, then `/reload`.

### Confirm it is running

After a turn that ends with open tasks, `/todoloop` should read:

```
todo-loop active
rounds 1/12 · strikes 0/2
open 2/5 tracked · inject on
last: continuing: round 1/12, 2 open
```

To count continuations in the session file:

```bash
grep -c 'todo-loop:continue' ~/.pi/agent/sessions/<project>/*.jsonl
```

### Uninstall

```bash
pi remove npm:pi-todo-loop          # or: pi remove git:github.com/DumbMice/pi-todo-loop
rm -f ~/.pi/agent/todo-loop.json    # optional config
rm -f ~/.pi/agent/todo-loop-off .pi/todo-loop-off   # optional kill switches
```

Then `/reload`. Existing `todo-loop:continue` entries stay in old session files, hidden and inert;
nothing was written to your working tree.

## Configuration

`~/.pi/agent/todo-loop.json`, every key optional:

```json
{
  "maxRounds": 12,
  "maxStrikes": 2,
  "injectState": true,
  "maxInjectedTasks": 6
}
```

| Key | Default | Notes |
|---|---|---|
| `maxRounds` | `12` | consecutive continuations allowed per human message |
| `maxStrikes` | `2` | consecutive turns that neither ran a tool nor changed the list before stopping |
| `injectState` | `true` | append the authoritative task list to each request |
| `maxInjectedTasks` | `6` | rows rendered before `… and N more` |

Missing, unreadable or invalid values fall back to the defaults: a bad config never fails a turn.

## Commands

| Command | Effect |
|---|---|
| `/todoloop` | status: mode, rounds, strikes, open count, why it last stopped, config path |
| `/todoloop pause` | stop continuing until you resume or restart |
| `/todoloop resume` | continue again |
| `/todoloop reset` | clear the round and strike counters and forget the list signature |

**Kill switch**, checked before every decision:

```bash
touch ~/.pi/agent/todo-loop-off     # all projects
touch .pi/todo-loop-off             # this project
```

## Behaviour to expect

- **Continuation is silent.** Each continuation appends one `custom_message` with `display: false`
  (a 27-character body, under 40 including the marker) and requests one more turn. Nothing is added to
  the visible transcript.
- **The marker is stripped only on the path that appends the state block.** When `injectState` is
  false, when no tasks are open, or when the kill switch is set, the marker is left in place — it is
  then the tail that keeps the request off an assistant message, and the model sees
  `<todo_loop n="1" open="2"/>`.
- **The task list is injected on every request** while tasks are open, as a `<todo_loop_state>` block:
  open tasks with ids and statuses, plus an instruction to work the list rather than ask whether to
  continue. It is not persisted, so compaction cannot remove it.
- **The injected block is the last thing in the request.** It is user-role text, so it competes with
  your own newest message: while tasks are open the model is told the list is authoritative. That is
  why it is one bounded paragraph, and why `injectState: false` exists.
- **One budget per human message.** Up to `maxRounds` continuations (12 by default) run before the loop
  stops; the budget resets when you send a message, not when the agent continues.
- **A stop keeps the budget shut.** Hitting the cap or the strike limit does not clear the counters —
  a queued message or a provider retry under the same user message will not re-arm 12 more rounds.
- **A no-progress turn is not continued twice.** A turn that ran no tool and left the list unchanged
  spends a strike; the second consecutive strike stops the loop instead of nagging.
- **Errors are not continued.** A turn that ends `error` or `aborted` stops the loop immediately.
- **It never writes to your working tree.** The only reads are the optional config, the two
  kill-switch paths and the session branch. Counters, the pause flag and the last stop reason live in
  memory: `/reload`, a restart or a resumed session starts a new budget and re-reads the list from the
  branch, and a pause does not survive either.
- **`no list` is one status for three causes:** the agent never called a tool named `todo`, the tool it
  called writes a shape this extension does not recognise, or the list is empty. Only the first is a
  configuration problem, and the status cannot currently tell them apart.

## Cost and limits

- A continuation is a normal model turn: the whole conversation is sent again, so cost scales with
  `maxRounds` × session size. That, not the block, is the dominant term.
- Every request also pays one backward walk of the branch, and — while tasks are open — the injected
  block (~150 tokens). The block is appended at the tail, so the cached prefix is unaffected;
  `injectState: false` removes it and leaves the model to call `list`.
- Bounds: `maxRounds` per human message, `maxStrikes` consecutive no-progress turns, and no continuation
  at all on `error` / `aborted`. There is no absolute session ceiling; a resumed session starts a new
  budget.

## Troubleshooting

Reason strings from `/todoloop`, and what they mean:

| `last:` | Meaning |
|---|---|
| `continuing: round 1/12, 2 open` | working as intended |
| `stopped: list is clear` | every task is `completed` or `deleted` |
| `stopped: no list` | no recognised todo state on the branch — see the three causes above |
| `stopped: 2 consecutive turns with no progress, 2 open` | the model stopped touching the list and stopped running tools; raise `maxStrikes` only if you want more attempts |
| `stopped: round cap 12 reached, 2 open` | the budget is spent; send a message to start a new one |
| `stopped: turn outcome was aborted` | you aborted the turn |
| `paused by user` | `/todoloop pause`; `/todoloop resume` or restart |
| `idle` | nothing has run yet in this process, e.g. straight after `/reload` |

- **Nothing continues.** Check `/todoloop` for `DISABLED` (a kill-switch file exists) or `PAUSED`.
- **Continuations appear twice, or rounds jump by two.** More than one continuation extension is
  installed. `pi list` shows the sources; remove one, then `/reload`.
- **The agent keeps working but the list stays stale.** It is being continued and told the list is
  authoritative, but marking progress is the model's job. Nothing here fabricates status on its behalf.

## Further reading

- **pi extension API notes and deliberate workarounds** —
  [docs/pi-api-alignment.md](docs/pi-api-alignment.md)
- **Working on this repository** — layout, invariants, tests, release process:
  [AGENTS.md](AGENTS.md)
- **Changes by version**: [CHANGELOG.md](CHANGELOG.md)
- **Why this exists** — the upstream issues it closes:
  [rpiv-mono#159](https://github.com/juicesharp/rpiv-mono/issues/159),
  [#222](https://github.com/juicesharp/rpiv-mono/issues/222),
  [#259](https://github.com/juicesharp/rpiv-mono/issues/259)

## License

MIT. Source and issues: <https://github.com/DumbMice/pi-todo-loop>.
