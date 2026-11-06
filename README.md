# @dumbmice/pi-todo-loop

[![npm version](https://img.shields.io/npm/v/@dumbmice/pi-todo-loop)](https://www.npmjs.com/package/@dumbmice/pi-todo-loop)
[![license](https://img.shields.io/npm/l/@dumbmice/pi-todo-loop)](https://github.com/DumbMice/pi-todo-loop/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@dumbmice/pi-todo-loop)](https://github.com/DumbMice/pi-todo-loop/blob/main/package.json)
[![tests](https://github.com/DumbMice/pi-todo-loop/actions/workflows/test.yml/badge.svg)](https://github.com/DumbMice/pi-todo-loop/actions/workflows/test.yml)

Keeps the [pi coding agent](https://pi.dev) working while its todo list still has open tasks.

`rpiv-todo` gives the agent a task list and shows it to you. It never asks pi for another turn, so the
agent still stops halfway and hands control back. This extension adds the turn: while tasks are open it
keeps the agent going, and stops when you clear the list — or when the agent tells you it needs a
person. It never writes the list into your prompt: the agent reads it with its own todo tool.

## Quick start

```bash
pi install npm:@juicesharp/rpiv-todo    # the list this reads (skip if installed)
pi install npm:@dumbmice/pi-todo-loop
```

Then start a session and ask for something with several steps:

```text
Use the todo tool to plan this, then work through it: make the reports page
export CSV, add tests, and update the docs.
```

There is nothing else to configure. `/todoloop` shows what it is doing; `touch
~/.pi/agent/todo-loop-off` turns it off.

## What it looks like

```text
you:  make the whole sequence web-editable, then expose it in the browser

pi:   [todo: 12 tasks created, first marked in_progress]
pi:   T5 backend is in and verified. Committing a report of the state …
      ← without this extension the run ends here, with 11 tasks open.

pi:   [todo: T5 completed, T6 in_progress]
pi:   T6 audio/face lanes wired. T7 per-camera PNG export next …

pi:   [todo: all 12 completed]
pi:   All 12 tasks are complete; here is what was verified …
      ← the list is clear, so the loop stops and stays stopped.
```

It stops for one of these reasons, and `/todoloop` always says which:

| Why it stopped | What you see |
|---|---|
| the list is clear | `stopped: list is clear` — the normal ending |
| the model said it needs a person | `waiting for you: waiting on Dana's review` — it called `todo_loop_block`; your next message resumes |
| a configured cap is reached | `stopped: 12 continuations used, 3 tasks still open` — only when `maxRounds` is set; if it ends with `the agent may need you`, ask what it is waiting on |
| the turn failed | `stopped: turn outcome was error` — the provider failed, or you aborted it |

## When it helps

- Long, multi-step work where the agent summarises and hands back halfway.
- Sessions long enough to be compacted — the list survives on disk; the nudge is what gets the model to
  read it again.
- A model that runs tools but rarely updates its list. It will still be nudged, and with no cap by
  default it keeps going until the list clears.

## When it does not

- **No todo tool installed.** The extension is inert: nothing continues.
- **You want an autonomous agent that invents its own goals.** This drives the list you have; nothing
  here adds work you did not ask for.
- **You want a hard ceiling on cost.** There is no continuation cap by default — set `maxRounds` if you
  want one, otherwise a model that keeps stopping will keep costing turns. `/todoloop` says `(no limit)`
  and warns every tenth stall that changes nothing.
- **You want the continuations visible.** They are silent by design.
- **You want the agent to keep going after you said stop.** Your instruction wins; a model that reads
  "stop" as final can say so with `todo_loop_block`, and that stops the loop immediately.

It buys *liveness*, not work. A model can satisfy the loop by closing tasks, including deleting
placeholders, and a list that is never updated looks the same as one that is finished. Clearing the list
is the only thing that stops it, so the list has to mean something to you.

The extension never edits your prompt. The only *variable* text it gives the model is a one-line nudge —
*continue, and read or update the list with the todo tool* — plus one constant tool declaration and the
prompt entry pi derives from it (`todo_loop_block`; neither carries task state), so the list stays the
agent's to maintain and the conversation stays yours.

## Configuration

Optional, at `~/.pi/agent/todo-loop.json`:

```json
{
  "maxRounds": null
}
```

| Key | Default | What it does |
|---|---|---|
| `maxRounds` | `null` | continuations allowed per message; `null` means no limit, a number caps it |

A missing or broken file falls back to these values; a bad config never fails a turn.

## Commands

| Command | What it does |
|---|---|
| `/todoloop` | status: mode, how often it has been asked to continue, replies since the todo list last changed, open tasks, whether it waits for you, why it last stopped, config path |
| `/todoloop pause` | stop continuing until you resume or restart |
| `/todoloop resume` | allow the next turn to continue again |
| `/todoloop reset` | clear the counters, the list signature and any pending `todo_loop_block` |

**Kill switch** — checked before every decision:

```bash
touch ~/.pi/agent/todo-loop-off     # everywhere
touch .pi/todo-loop-off             # this project only
```

## Is it working?

After a response that made no tool calls while tasks are open, `/todoloop` should read something like:

```
todo-loop active
asked to continue: 1 (no limit)
replies since the todo list last changed: 0
tasks open: 2 of 5
counting from: your message 4f3c1a2e — a new message restarts the count
last: continuing: 2 tasks still open, continue 1
config ~/.pi/agent/todo-loop.json
```

To count continuations in a session file:

```bash
grep -c 'todo-loop:continue' ~/.pi/agent/sessions/<project>/*.jsonl
```

## Troubleshooting

| Symptom | What to do |
|---|---|
| Nothing continues | Check `/todoloop`: `DISABLED` means a kill-switch file exists, `PAUSED` means you paused it. `last: stopped: no list` with `tasks open: 0 of 0` means the model has not created a list in this session; if the open count is non-zero the tool is writing a shape this extension does not read |
| The model asked for a person | It called `todo_loop_block` with a reason, so the loop is stopped until your next message. The reason appears in `/todoloop` as `waiting for you: …` |
| It stopped at the round cap | Only happens when `maxRounds` is set: the number of continuations for that message is spent; send another message. `no todo change for N replies` means it was working without updating the list; `the agent may need you` means it stopped on a stall — ask what it is waiting on |
| Rounds jump by two, or continuations appear twice | Two continuation extensions are installed; `pi list` shows them, remove one, then `/reload` |
| The list is stale | The extension nudges, it does not write statuses. Nothing here fabricates progress |
| A warning says tasks were deleted | The list was emptied by a turn whose only tool was `todo`, and that turn deleted tasks rather than completing them. Check the work before trusting it |

## Uninstall

```bash
pi remove npm:@dumbmice/pi-todo-loop
rm -f ~/.pi/agent/todo-loop.json
rm -f ~/.pi/agent/todo-loop-off .pi/todo-loop-off
```

Then `/reload`. Nothing was ever written to your working tree, and old session files keep only the
hidden continuation entries.

## Requirements

- **pi 1.5.0** (tested; needs the `turn_end` boundary).
- **A todo tool** named `todo` that stores its list in the session — tested with
  `@juicesharp/rpiv-todo` 2.15.0.
- **Node 22.19+**, the floor pi itself requires. The extension has no dependencies.

Last verified 2026-11-04; the exact table and what was checked is in
[docs/pi-api-alignment.md](docs/pi-api-alignment.md).

Install only one continuation extension: a second one that also requests turns makes the counters and
the budget meaningless.

## Further reading

- **How it behaves, precisely** — counters, markers, stalls, cost:
  [docs/behaviour.md](docs/behaviour.md)
- **pi API alignment** — the deliberate workarounds: [docs/pi-api-alignment.md](docs/pi-api-alignment.md)
- **Working on the repository**: [AGENTS.md](AGENTS.md)
- **Changes by version**: [CHANGELOG.md](CHANGELOG.md)
- **Why it exists** — the upstream issues:
  [rpiv-mono#159](https://github.com/juicesharp/rpiv-mono/issues/159),
  [#222](https://github.com/juicesharp/rpiv-mono/issues/222),
  [#259](https://github.com/juicesharp/rpiv-mono/issues/259)

## License

MIT. Source and issues: <https://github.com/DumbMice/pi-todo-loop>.
