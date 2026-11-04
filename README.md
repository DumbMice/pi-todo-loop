# pi-todo-loop

Continuation for [pi](https://github.com/earendil-works/pi-coding-agent) driven by an
[`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) list.

While the list still has open tasks, pi keeps working instead of handing back control.
The list is also injected at the tail of every request, so it survives compaction and a
model that never thinks to call `list`.

```
you:  make the whole sequence web-editable …          → 12 tasks created
pi:   T5 backend is in and verified; committing …      ← would normally stop here
      (nudged, 2 tasks still open)
pi:   T6 audio lanes wired, T7 export …                ← continues
      (all tasks completed)
      done.                                             ← stops
```

## Why this exists

`rpiv-todo` is a display: it renders the list and stores it. It never asks pi for another
turn. That shows up as three filed issues on the rpiv tracker:

| Issue | Symptom this extension closes |
|---|---|
| [#159](https://github.com/juicesharp/rpiv-mono/issues/159) | no stale/reminder mechanism — a task sat `in_progress` for **507 messages**; longest gap between two `todo` calls: **1,126 messages** |
| [#222](https://github.com/juicesharp/rpiv-mono/issues/222) | post-compaction context hole — the snapshot lives in entry `details`, which pi does **not** send to the LLM, so after compaction the model cannot see a list that still renders on screen |
| [#259](https://github.com/juicesharp/rpiv-mono/issues/259) | "looks dumb with deepseek models" — the list displays but is never updated, because nothing puts it back in front of the model |

The fix that exists upstream ([PR #190](https://github.com/juicesharp/rpiv-mono/pull/190), stale
reminders + compaction resync) has been open since 2026-08-26. This package is a sibling
extension instead, so it works with whatever rpiv-todo version you run.

## Install

```sh
pi install npm:pi-todo-loop
```

Or from git / a local checkout:

```sh
pi install git:github.com/yangbangcheng/pi-todo-loop
pi install ./pi-todo-loop
```

Run `/reload` (or restart) afterwards, then ask for something with several steps.

**Install exactly one copy.** If a development copy also sits in
`~/.pi/agent/extensions/todo-loop/`, both register a `turn_end` handler and each will
request its own continuation.

## Requirements

| | |
|---|---|
| pi | 1.5.0 verified; needs the `turn_end` boundary (`continue` + draft `entries`) |
| rpiv-todo | 2.15.0 verified; any version that persists `rpiv-todo-state` custom entries or `todo` toolResult `details.tasks` |
| Node | ≥ 22.18 (only for the test runner; the extension itself has no runtime dependencies) |

Without rpiv-todo the extension is a no-op: no list, nothing to continue.

## How it works

Two hooks, one command, no patching.

**`context`** (before every LLM request, non-destructive):

1. strips this extension's hidden continuation marker from the request;
2. appends the authoritative open-task list at the tail:

```xml
<todo_loop_state>
2 tracked task(s) are still open on this branch:
  2. [pending] write the report
  3. [in_progress] running the tests
The list is authoritative. Keep working it; do not ask whether to continue.
</todo_loop_state>
```

That block is never persisted — it is per-request context, so it costs nothing in history
and cannot be lost by compaction. It is also what keeps the request from ending on an
assistant message once the marker is stripped (see *Design notes*).

**`turn_end`**: decides whether to request another turn. The whole policy is a pure
function in [`src/loop.ts`](src/loop.ts), unit-tested:

| Situation | Result |
|---|---|
| turn ended in `error` / `aborted` | stop |
| no open tasks | stop (`list is clear` / `no list`) |
| new human message since the last decision | budget resets, then evaluate |
| turn ran a tool, or the list changed | continue |
| no tool and no list change, once | continue (`strike 1`) |
| no tool and no list change, again | stop (`no progress`) |
| `rounds >= maxRounds` | stop (`round cap`) |

**`/todoloop`** — `status` (default), `pause`, `resume`, `reset`.

## Configuration

`~/.pi/agent/todo-loop.json`, all optional:

```json
{
  "maxRounds": 12,
  "maxStrikes": 2,
  "injectState": true,
  "maxInjectedTasks": 6
}
```

| Key | Default | Meaning |
|---|---|---|
| `maxRounds` | `12` | max consecutive continuations per human message |
| `maxStrikes` | `2` | consecutive no-progress turns tolerated |
| `injectState` | `true` | append the task list to each request |
| `maxInjectedTasks` | `6` | rows rendered before `... and N more` |

Invalid or unreadable config falls back to the defaults — this extension is never the
reason a turn fails.

**Kill switch**, checked before every decision:

```sh
touch ~/.pi/agent/todo-loop-off     # global
touch .pi/todo-loop-off             # this project only
```

## Compatibility and failure modes

- **rpiv-todo changes its persisted shape** → `readSnapshot` falls back to the `todo`
  toolResult `details`, then to "no list" (a no-op). It never throws inside a turn boundary.
- **Compaction** → nothing to resync: the list is read from the branch on every request,
  not from in-memory state.
- **Branches and forks** → state is derived from the *active branch*, so an abandoned
  branch's tasks do not leak into the current one.
- **Another extension also returns `continue`** → boundary handlers compose: `entries` are
  chained and `continue` is OR-ed by pi, so both proposals survive.
- **`injectState: false`** → the marker is kept instead of stripped, so continuations still
  work without the per-request block; the model then has to call `list` itself.

## Design notes

**Why not a fork of rpiv-todo.** It is a 15k-line, 15-package monorepo publishing ~140
versions in seven months. Nothing in its todo logic needs to change; this layer only reads
what it persists. A fork would inherit that churn and lose upstream fixes.

**Why one hidden entry per continuation.** pi's `turn_end` boundary requires the proposed
projection to end on a non-assistant message
(`_buildBoundaryContext().canContinue`), so a continuation cannot be expressed with zero
entries. One `custom_message` with `display: false` is the minimum: invisible in the TUI,
~40 characters in the journal, and stripped from the provider request. There is no public
`resume()` API that appends nothing.

**Why the marker and the injection are coupled.** Stripping the marker alone would leave
the request ending on an assistant message, which some providers reject. So whenever the
marker is stripped, the state block is appended to carry the user-role tail. Do not remove
one without the other.

## Development

No build step, no runtime dependencies.

```sh
npm test          # node --experimental-strip-types --test test/*.test.ts
npm run typecheck # tsc --noEmit (needs `npm i -D typescript @types/node`)
pi -e ./          # load this checkout for one invocation
```

Layout:

```
src/index.ts   pi wiring: context hook, turn_end hook, /todoloop
src/loop.ts    pure decision policy (fully unit-tested)
src/state.ts   reads rpiv-todo state off the session branch
src/inject.ts  renders the per-request task block
```

## Security

Extensions execute in the pi process. This one reads the session branch, reads one opt-in
JSON config, and writes nothing — no files, no network, no process execution, no
model-visible text beyond the task block above.

## License

MIT
