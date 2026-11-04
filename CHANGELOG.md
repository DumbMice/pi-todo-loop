# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-04

Initial release.

### Added

- `turn_end` continuation while a todo list has open tasks — anything not `completed` or
  `deleted` — with a per-human-message round cap (`maxRounds`, default 12) and a
  no-progress strike budget (`maxStrikes`, default 2). A stop keeps the counters: only a
  new human message starts a new budget.
- Per-request injection of the authoritative open-task list through the `context` hook,
  never persisted, closing the post-compaction context hole
  ([rpiv-mono#222](https://github.com/juicesharp/rpiv-mono/issues/222)) and the "model
  never calls the todo tool's `list` action" failure ([rpiv-mono#159](https://github.com/juicesharp/rpiv-mono/issues/159)).
- Hidden continuation marker (`custom_message`, `display: false`, 27-character body) that
  is stripped from the provider request on the path that appends the state block. When
  `injectState` is false, when no task is open, or when the kill switch is set, the marker
  is kept and serves as the non-assistant tail.
- Task state read from `rpiv-todo-state` custom entries with a `todo` toolResult
  `details.tasks` fallback, the newer of the two winning; never throws inside a turn
  boundary, and a task with an unusable id falls back to its position instead of vanishing.
- `/todoloop` command: `status`, `pause`, `resume`, `reset`.
- Kill switch: `~/.pi/agent/todo-loop-off` or `.pi/todo-loop-off`.
- Config at `~/.pi/agent/todo-loop.json`; invalid values fall back to defaults.
- 44 tests, runnable with no dependencies: decision policy, state reader, injection
  renderer, config loader, the pi-facing hooks through a stub `pi`, and a documentation
  test that pins the tested-version table, the verification date and README link targets.

[0.1.0]: https://github.com/DumbMice/pi-todo-loop/releases/tag/v0.1.0
