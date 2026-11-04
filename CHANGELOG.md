# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-04

Initial release.

### Added

- `turn_end` continuation while a todo list has open tasks — anything not `completed` or
  `deleted` — with a per-human-message round cap (`maxRounds`, default 12) and a
  no-progress strike budget (`maxStrikes`, default 2). Only a settle spends a round: a turn
  that ended in a tool call already causes pi's next request and costs nothing — but it clears a
  pending strike, because it is work. A stop keeps the counters: only a new human message starts a
  new budget.
- Per-request injection of the authoritative open-task list through the `context` hook,
  never persisted, closing the post-compaction context hole
  ([rpiv-mono#222](https://github.com/juicesharp/rpiv-mono/issues/222)) and the "model
  never calls the todo tool's `list` action" failure ([rpiv-mono#159](https://github.com/juicesharp/rpiv-mono/issues/159)).
- Hidden continuation marker (`custom_message`, `display: false`, constant 21-character body
  `<todo_loop_continue/>`, ~200 bytes as a session entry). Markers are kept in history: they sit
  between assistant turns and are what keeps the conversation alternating. A marker at the tail is
  replaced by the state block, so a request never ends on two user-role messages.
- Task state read from `rpiv-todo-state` custom entries with a `todo` toolResult
  `details.tasks` fallback, the newer of the two winning; never throws inside a turn
  boundary, and a task with an unusable id falls back to its position instead of vanishing.
- `/todoloop` command: `status`, `pause`, `resume`, `reset`.
- Kill switch: `~/.pi/agent/todo-loop-off` or `.pi/todo-loop-off`.
- Config at `~/.pi/agent/todo-loop.json`; invalid values fall back to defaults, and numbers are
  clamped (`maxRounds` ≤ 1000, `maxStrikes` ≤ 100, `maxInjectedTasks` ≤ 50).
- Tests, runnable with no dependencies: decision policy, state reader, injection renderer, config
  loader, the pi-facing hooks through a stub `pi`, a captured real branch, and documentation tests
  that pin the tested-version table, the invariant map, the reason table, the configuration table and
  README link targets.
- `test/state-machine.test.ts`: the counters as a table of event sequences in pi's own vocabulary
  (`settle`, `tool`, `edit`, `human`, pause/resume/reset, error/abort, kill switch), asserting
  continuations, markers, rounds, strikes, the `/todoloop` reason and header at once. Re-introducing any
  of the three historical budget defects fails it.
- Task text is sanitised before it enters a request — subject, `activeForm` **and `status`**: every
  Unicode line terminator flattens, `<` is escaped, controls/bidi/zero-width and unpaired surrogates are
  dropped, and labels truncate by code point, so a task subject cannot close the injection tag or forge a directive. Verified against a
  crafted subject that closed the tag and inserted a `SYSTEM:` line — the structure broke before the
  fix and the model refused both times.
- `scripts/check-pack.mjs` as `npm run pack:check`: asserts the published tarball really contains the
  entry point, sources, docs, licence and `tsconfig.json`, and that no dev-only path (`test/`,
  `.github/`) leaks into it (`npm pack --dry-run` exits 0 otherwise).

[0.1.0]: https://github.com/DumbMice/pi-todo-loop/releases/tag/v0.1.0
