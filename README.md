# pi-todo-loop

[![npm version](https://img.shields.io/npm/v/pi-todo-loop)](https://www.npmjs.com/package/pi-todo-loop)
[![license](https://img.shields.io/npm/l/pi-todo-loop)](https://github.com/DumbMice/pi-todo-loop/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/pi-todo-loop)](https://github.com/DumbMice/pi-todo-loop/blob/main/package.json)
[![tests](https://github.com/DumbMice/pi-todo-loop/actions/workflows/test.yml/badge.svg)](https://github.com/DumbMice/pi-todo-loop/actions/workflows/test.yml)

An extension for the [pi coding agent](https://pi.dev) that keeps the agent working while an
[`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) list
still has open tasks, and keeps that list in front of the model across compaction. `rpiv-todo` renders
and stores the list; it never asks pi for another turn. This adds the turn.

## Example

```text
you:  make the whole sequence web-editable, then expose it in the browser
      rpiv-todo: 12 tasks, first marked in_progress

pi:   T5 backend is in and verified; committing a report of the state …
      ← normally the run ends here. Two tasks are still open, so pi-todo-loop
        requests one more turn; the list is injected at the tail of the request.

pi:   T6 audio/face lanes wired. T7 per-camera PNG export next …
      ← tasks updated as it goes, so the loop keeps going

pi:   All 12 tasks are complete. Everything below is verified: …
      ← list is clear → the loop stops and stays stopped
```

## When to use it

- Long, multi-step work where the agent tends to summarise and hand back control halfway.
- Sessions that get compacted: the list survives in the session branch, but the **model** loses it,
  because the snapshot lives in entry `details` and pi does not send that to the LLM.
- Models that need reminding to keep a task list current — see
  [rpiv-mono#259](https://github.com/juicesharp/rpiv-mono/issues/259), where DeepSeek models display a
  list but never update it.

## When not to use it

- You do not use `rpiv-todo`. Without a list there is nothing to continue; the extension is inert.
- You want unattended overnight loops against an acceptance criterion. This drives an existing task
  list; it does not invent goals, and it stops after `maxRounds` (default 12).
- You want the agent's continuations to be visible in the transcript. They are deliberately hidden.

## Install

```bash
# from npm
pi install npm:pi-todo-loop

# straight from the repository
pi install git:github.com/DumbMice/pi-todo-loop
```

Then `/reload` (or restart) and ask for something with several steps.

Requirements:

| | |
|---|---|
| pi | 1.5.0 verified; needs the `turn_end` boundary with `continue` and draft `entries` |
| rpiv-todo | 2.15.0 verified; any version that persists `rpiv-todo-state` custom entries or `todo` toolResult `details.tasks` |
| Node | >= 22.6 for the test runner; the extension has no runtime dependencies |

**Install one copy only.** A development checkout in `~/.pi/agent/extensions/todo-loop/` alongside the
npm package makes both register a `turn_end` handler, and each will request its own continuation.

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
| `/todoloop pause` | stop continuing in this session |
| `/todoloop resume` | continue again |
| `/todoloop reset` | clear the round and strike counters |

**Kill switch**, checked before every decision:

```bash
touch ~/.pi/agent/todo-loop-off     # all projects
touch .pi/todo-loop-off             # this project
```

## Behaviour to expect

- **Continuation is silent.** Each request adds one `custom_message` with `display: false` (~40
  characters) to the session, and that message is stripped from the provider request. Nothing appears
  in the transcript.
- **The task list is injected on every request** while tasks are open, as a `<todo_loop_state>` block
  at the tail: the open tasks with their ids and statuses, and an instruction to work the list rather
  than ask whether to continue. It is not persisted, so compaction cannot remove it.
- **One continuation per human message.** The budget resets when you send a message, not when the
  agent continues.
- **A no-progress turn is not continued twice.** A turn that ran no tool and left the list unchanged
  spends a strike; the second consecutive strike stops the loop instead of nagging.
- **Errors are not continued.** A turn that ends `error` or `aborted` stops the loop immediately.
- **It costs one small walk of the branch per request**, plus the injected block (~150 tokens) while
  tasks are open. Set `injectState: false` to trade that block for the model having to call `list`.
- **It never writes to your working tree.** The only file it reads is the optional config; state lives
  in the session.

## Troubleshooting

- **Nothing continues.** Check `/todoloop`. `DISABLED` means a kill-switch file exists; `PAUSED` means
  `/todoloop pause`; `no list` means the agent never called `todo`. A list whose tasks are all
  `completed` or `deleted` is clear by definition.
- **It continues, then stops after two turns.** That is the strike budget: the agent produced no tool
  call and did not touch the list twice. Either the work is actually done, or it is stuck — raise
  `maxStrikes` only if you want more attempts.
- **It stops after 12 continuations.** `maxRounds`. The status line reports `round cap`.
- **Continuations appear twice / rounds jump by two.** Two copies are installed. `pi list` shows the
  sources; remove one, then `/reload`.
- **The agent still does not update the task list.** It is being continued and told the list is
  authoritative, but marking progress is the model's job. A weaker model may keep the list stale;
  nothing here fabricates status on its behalf.

## Further reading

- **pi extension API notes and deliberate workarounds** —
  [docs/pi-api-alignment.md](https://github.com/DumbMice/pi-todo-loop/blob/main/docs/pi-api-alignment.md)
- **Working on this repository** — layout, invariants, tests, release process:
  [AGENTS.md](https://github.com/DumbMice/pi-todo-loop/blob/main/AGENTS.md)
- **Changes by version**:
  [CHANGELOG.md](https://github.com/DumbMice/pi-todo-loop/blob/main/CHANGELOG.md)
- **Why this exists** — the upstream issues it closes:
  [rpiv-mono#159](https://github.com/juicesharp/rpiv-mono/issues/159),
  [#222](https://github.com/juicesharp/rpiv-mono/issues/222),
  [#259](https://github.com/juicesharp/rpiv-mono/issues/259)

## License

MIT. Source and issues: <https://github.com/DumbMice/pi-todo-loop>.
