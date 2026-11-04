# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-04

Initial release.

### Added

- `turn_end` continuation while an `rpiv-todo` list has `pending` or `in_progress` tasks,
  with a per-human-message round cap (`maxRounds`, default 12) and a no-progress strike
  budget (`maxStrikes`, default 2).
- Per-request injection of the authoritative open-task list through the `context` hook,
  never persisted, closing the post-compaction context hole
  ([rpiv-mono#222](https://github.com/juicesharp/rpiv-mono/issues/222)) and the "model
  never calls `list`" failure ([rpiv-mono#159](https://github.com/juicesharp/rpiv-mono/issues/159)).
- Hidden continuation marker (`custom_message`, `display: false`, ~40 chars) that is
  stripped from the provider request.
- Task state read from `rpiv-todo-state` custom entries with a `todo` toolResult
  `details.tasks` fallback; never throws inside a turn boundary.
- `/todoloop` command: `status`, `pause`, `resume`, `reset`.
- Kill switch: `~/.pi/agent/todo-loop-off` or `.pi/todo-loop-off`.
- Config at `~/.pi/agent/todo-loop.json`; invalid values fall back to defaults.
- 25 unit tests over the decision policy, state reader, injection renderer and config
  loader, runnable with no dependencies.

[0.1.0]: https://github.com/yangbangcheng/pi-todo-loop/releases/tag/v0.1.0
