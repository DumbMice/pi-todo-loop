# @dumbmice/pi-todo-loop

[![npm version](https://img.shields.io/npm/v/@dumbmice/pi-todo-loop)](https://www.npmjs.com/package/@dumbmice/pi-todo-loop)
[![license](https://img.shields.io/npm/l/@dumbmice/pi-todo-loop)](https://github.com/DumbMice/pi-todo-loop/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@dumbmice/pi-todo-loop)](https://github.com/DumbMice/pi-todo-loop/blob/main/package.json)
[![tests](https://github.com/DumbMice/pi-todo-loop/actions/workflows/test.yml/badge.svg)](https://github.com/DumbMice/pi-todo-loop/actions/workflows/test.yml)

Keeps the [pi coding agent](https://pi.dev) working while its todo list still has open tasks.

`rpiv-todo` gives the agent a task list and shows it to you. It never asks pi for another turn, so the
agent still stops halfway and hands control back. This extension adds the turn: while tasks are open it
keeps the agent going, puts the list back in front of the model after a compaction, and stops when you
clear the list.

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

It stops for three reasons, and `/todoloop` always says which:

| Why it stopped | What you see |
|---|---|
| the list is clear | `stopped: list is clear` — the normal ending |
| the model stopped working the list | `stopped: 2 consecutive turns with no progress, 3 open` — two quiet turns in a row |
| the budget is spent | `stopped: round cap 12 reached, 3 open` — 12 continuations for your one message |

## When it helps

- Long, multi-step work where the agent summarises and hands back halfway.
- Sessions long enough to be compacted — the list survives on disk, but the model loses it.
- A model that runs tools but rarely updates its list. It will still be nudged; it may keep working to
  the round cap.

## When it does not

- **No todo tool installed.** The extension is inert: nothing continues, nothing is injected.
- **You want an autonomous agent that invents its own goals.** This drives the list you have; it stops
  after 12 continuations per message by default.
- **You want the continuations visible.** They are silent by design.
- **You want the agent to keep going after you said stop.** Your instruction wins; a model that reads
  "stop" as final will hold, and those refusals cost up to 12 turns.

It buys *liveness*, not work. A model can satisfy the loop by closing tasks, including deleting
placeholders, and a list that is never updated looks the same as one that is finished. Clearing the list
is the only thing that stops it, so the list has to mean something to you.

## Configuration

Optional, at `~/.pi/agent/todo-loop.json`:

```json
{
  "maxRounds": 12,
  "maxStrikes": 2,
  "injectState": true,
  "maxInjectedTasks": 6
}
```

| Key | Default | What it does |
|---|---|---|
| `maxRounds` | `12` | continuations allowed per message to the agent |
| `maxStrikes` | `2` | turns in a row that leave the list unchanged before stopping |
| `injectState` | `true` | put the open-task list into each request; `false` leaves the model to read the list itself |
| `maxInjectedTasks` | `6` | rows shown before `… and N more` |

A missing or broken file falls back to these values; a bad config never fails a turn.

## Commands

| Command | What it does |
|---|---|
| `/todoloop` | status: mode, rounds, strikes, open tasks, why it last stopped, config path |
| `/todoloop pause` | stop continuing and stop injecting, until you resume or restart |
| `/todoloop resume` | allow the next turn to continue again |
| `/todoloop reset` | clear the counters and start the budget over |

**Kill switch** — checked before every decision:

```bash
touch ~/.pi/agent/todo-loop-off     # everywhere
touch .pi/todo-loop-off             # this project only
```

## Is it working?

After a response that made no tool calls while tasks are open, `/todoloop` should read something like:

```
todo-loop active
rounds 1/12 · strikes 0/2
open 2/5 tracked · inject on
anchor 4f3c1a2e
last: continuing: round 1/12, 2 open
config ~/.pi/agent/todo-loop.json
```

To count continuations in a session file:

```bash
grep -c 'todo-loop:continue' ~/.pi/agent/sessions/<project>/*.jsonl
```

## Troubleshooting

| Symptom | What to do |
|---|---|
| Nothing continues | Check `/todoloop`: `DISABLED` means a kill-switch file exists, `PAUSED` means you paused it, `last: stopped: no list` means no todo tool is writing a list |
| It stopped with `no progress` | The model answered twice without running a tool or changing the list. Raise `maxStrikes` if you want more attempts |
| It stopped at the round cap | The budget for that message is spent; send another message. If the reason ends with `list unchanged for N settles`, the model was working without updating the list |
| Rounds jump by two, or continuations appear twice | Two continuation extensions are installed; `pi list` shows them, remove one, then `/reload` |
| The list is stale | The extension nudges, it does not write statuses. Nothing here fabricates progress |
| A warning says the list was cleared by todo alone | Every task closed in a turn with no other tool work. Check the work before trusting it |

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

- **How it behaves, precisely** — counters, markers, the injected block, cost:
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
