# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Verified against **pi 1.5.1**: `PI_API_SNAPSHOT` and the tested-version table move with it. Nothing in
  the extension needed changing — 1.5.1's breaking changes touch `GrepOperations.readFile` callbacks and
  the `tools: []` field for OpenAI-compatible endpoints, neither of which this package uses. A live
  session on 1.5.1 created a list, wrote two files, closed both tasks and stopped with no nudges, and
  the tool still renders in the prompt's `<tools>` and `<rules>` sections.

## [0.3.0] - 2026-11-06

### Added

- A warning to the human every tenth reply that leaves the todo list unchanged, while the loop keeps
  going: it names the count, the open tasks, and the two brakes (`/todoloop pause`, `maxRounds`). It is
  keyed on `staleSettles`, which tool turns do not clear, so it also catches the model this package
  exists for: tools running, list frozen. With a configured cap it says how many continuations remain.

### Changed

- **Breaking:** `maxRounds` defaults to `null`, so there is no continuation cap. The loop now ends when
  the list clears, the agent calls `todo_loop_block`, an error or abort occurs, or you pause it. Set a
  number to bound what one message of yours can cost; the value is still clamped to ≤ 1000, and a value
  below 1 stays unlimited rather than falling back to a default.
- The "list was cleared by todo alone" warning now counts *calls* rather than snapshot rows: it fires
  when the turn that emptied the list deleted tasks, and names how many. Finishing work and closing
  every task in one turn is the honest ending and no longer warns, and a tombstone from an earlier turn
  is not news. A result with no `action` at all keeps the old, vaguer wording.
- The user-facing text is plain English now: `/todoloop` says `asked to continue: 3 (no limit)`,
  `replies since the todo list last changed: 0`, `tasks open: 2 of 5`,
  `counting from: your message … — a new message restarts the count`; reasons read
  `continuing: 2 tasks still open, continue 3`, and a cap reads
  `stopped: 12 continuations used, 3 tasks still open`. The words "settles", "stalled", "round cap"
  and "hard bound" are gone from `/todoloop`, the stop reasons and the warnings.
- The `todo_loop_block` clause now rides only on the bare stall: the model stopped, got one nudge, and
  stopped again without running a tool and without the list changing (`settleRun === 2`). A stop that
  follows real work gets the plain nudge; the stop after it is asked, so a tool-heavy run with a frozen
  list is still asked. One request per stall, never repeated. `hintSent` is gone with it.

### Upgrade notes

- A session that relied on the old default of 12 now runs unbounded. An explicit `"maxRounds": 12` in
  the config file is honoured exactly as before, so that is the one-line way to keep the old ceiling.
- `"maxRounds": 0` used to mean "use 12"; it now means unlimited, like any value below 1.

## [0.2.1] - 2026-11-05

### Changed

- `todo_loop_block` now declares a `promptSnippet` and a `promptGuidelines` bullet, so pi lists it in the
  system prompt's `<tools>` section and its guideline in `<rules>`. Before this the tool was in the
  request's tool array but absent from the prompt summary, so an agent could only find it through the
  nudge. The guideline also tells the model to pick a reasonable option and state its assumption when a
  choice is its own, rather than asking a person.

## [0.2.0] - 2026-11-05

### Added

- `todo_loop_block`, a tool the agent can call when it cannot proceed without a person. It takes a
  reason, stops continuations for the rest of that message, notifies the human, and shows
  `waiting for you: <reason>` in `/todoloop`. The human's next message resumes the loop; there is no
  unblock call. The nudge offers this tool once per stall — on the first settle since progress that
  did not move the list — which is the shape a blocked agent has. If that settle is the one the round
  cap ends, the stop reason says `the agent stalled and may need a person`, so the hint is not lost.
- `MARKER_BODY_HINT`: the same nudge plus that one clause. Both variants end on the concession that the
  human outranks the loop.

### Removed

- **The injected state block is gone.** The extension no longer writes task state into a request: no
  `<todo_loop_state>` list, no reconciliation clause, no truncation variant, no merge into a `user` or
  `custom` tail. The only variable text it gives the model is the one-sentence nudge appended with each
  continuation, and that nudge now points at the todo tool instead of restating the list. Reading and
  updating the list is the agent's job; the prompt stays the human's.
- `injectState` and `maxInjectedTasks` are gone with it. A config file that still carries them loads
  fine — unknown keys are ignored — so upgrading needs no edit.
- `maxStrikes`. The loop no longer stops for being quiet: two no-progress settles used to end a run, and
  a stalled agent that was waiting for a person was abandoned with "no progress". The counter is now
  `stalled`, uncapped, and it only decides when to offer `todo_loop_block`. A `maxStrikes` key in an
  existing config is ignored.
- The renderer and its sanitiser (`src/inject.ts`, `test/inject.test.ts`). Config coercion moved to
  `test/config.test.ts`, because it outlived the renderer.

### Upgrade notes

- `maxRounds` is now the only cost knob: a model that keeps stopping without moving the list runs to
  the cap instead of stopping at two, and each continuation re-sends the conversation.
- A running session keeps the old build until `/reload` or a restart, and that starts a fresh budget.
- 0.1.1 re-injected the open-task list into every request after a compaction. That is gone: the model
  now sees the list only when it calls `todo` or is nudged, so a long session right after a compaction
  may take one extra turn before the agent knows what is left.

### Changed

- `context` may only *remove* a marker, never add one. It drops a marker whose neighbour is user-role
  (next to a human message, or in a run of markers) and returns `undefined` for every other request, so
  an ordinary turn is passed through as the object pi already built. A marker at the tail always
  survives: it is the nudge, and dropping it would leave the continuation ending on an assistant turn.
- `staleSettles` no longer drives injected wording. It still counts settles since the list last
  changed and still decorates the cap reason (`, list unchanged for N settles`).

### Fixed

- A run of adjacent continuation markers keeps its first marker. Testing only the literal neighbours
  dropped the whole run, leaving two assistant turns adjacent — the alternation the filter exists to
  prevent.
- The publish workflow's release step is idempotent: re-running a tag edits the existing release
  instead of failing on "release already exists".

## [0.1.1] - 2026-11-04

### Added

- The injected block escalates once, from the first continuation of a chain: it asks the model to
  reconcile a drifted list — update statuses, add what is missing, remove what no longer applies — so a
  stale list has an exit short of burning the round cap. (Known issue, fixed in the entry above: the
  clause was armed by the round counter, so it also reached the first request of a new human message.)

### Fixed

- The publish workflow survives a stale registry read: it asks for the version three times before
  concluding it is absent, and treats a `previously published` refusal as success. It also reads
  `npm pack --json` in both shapes (npm 10 returns an array, npm 11 an object keyed by package name),
  which is what failed the first two publish runs before they could upload.

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
- Hidden continuation marker (`custom_message`, `display: false`, a constant instruction body,
  ~220 bytes as a session entry). Markers are kept in history: they sit
  between assistant turns and are what keeps the conversation alternating. A marker at the tail is
  replaced by the state block, so a request never ends on two user-role messages.
- Task state read from `rpiv-todo-state` custom entries with a `todo` toolResult
  `details.tasks` fallback, the newer of the two winning; never throws inside a turn
  boundary, and a task with an unusable id falls back to its position instead of vanishing.
- `/todoloop` command: `status`, `pause`, `resume`, `reset`.
- Kill switch: `~/.pi/agent/todo-loop-off` or `.pi/todo-loop-off`.
- Config at `~/.pi/agent/todo-loop.json`; invalid values fall back to defaults, and numbers are
  clamped (`maxRounds` ≤ 1000, `maxStrikes` ≤ 100, `maxInjectedTasks` ≤ 50).
- The documentation is split: `README.md` is a user-facing page (what it does, quick start, one example,
  configuration, commands, troubleshooting, uninstall), and `docs/behaviour.md` holds the mechanics it
  used to inline — marker lifetime, role alternation, counter semantics, reason strings, scope and cost.
- `scripts/pack-json.mjs` normalises `npm pack --json`, whose shape differs between npm 10
  (array) and npm 11 (object keyed by package name); the publish workflow upgrades npm, so
  both are exercised.
- Tests, runnable with no dependencies: decision policy, state reader, injection renderer, config
  loader, the pi-facing hooks through a stub `pi`, a captured real branch, and documentation tests
  that pin the tested-version table, the invariant map, the reason table, the configuration table and
  README link targets.
- `test/state-machine.test.ts`: the counters as a table of event sequences in pi's own vocabulary
  (`settle`, `tool`, `edit`, `human`, pause/resume/reset, error/abort, kill switch), asserting
  continuations, markers, rounds, strikes, the `/todoloop` reason and header at once. Re-introducing any
  of the three historical budget defects fails it.
- A list that goes open → closed in a turn whose only tool results were `todo` is announced once: the
  loop's success state and its failure state are the same observable.
- A stale-list burn now says so: the round-cap reason appends `, list unchanged for N settles`.
- Task text is sanitised before it enters a request — subject, `activeForm` **and `status`**: every
  Unicode line terminator flattens, `<` is escaped, controls/bidi/zero-width and unpaired surrogates are
  dropped, and labels truncate by code point, so a task subject cannot close the injection tag or forge a directive. Verified against a
  crafted subject that closed the tag and inserted a `SYSTEM:` line — the structure broke before the
  fix and the model refused both times.
- `.github/workflows/publish.yml`: tag-triggered publish through npm Trusted Publishing (OIDC, no
  `NPM_TOKEN`, automatic provenance), gated on the suite, the typecheck, `pack:check`, a tag/version
  match and a packed-manifest assertion; creates the GitHub release from the CHANGELOG section.
- `scripts/check-pack.mjs` as `npm run pack:check`: asserts the published tarball really contains the
  entry point, sources, docs, licence and `tsconfig.json`, and that no dev-only path (`test/`,
  `.github/`) leaks into it (`npm pack --dry-run` exits 0 otherwise).

[0.1.0]: https://github.com/DumbMice/pi-todo-loop/releases/tag/v0.1.0
[0.1.1]: https://github.com/DumbMice/pi-todo-loop/releases/tag/v0.1.1
[0.2.0]: https://github.com/DumbMice/pi-todo-loop/releases/tag/v0.2.0
[0.2.1]: https://github.com/DumbMice/pi-todo-loop/releases/tag/v0.2.1
[0.3.0]: https://github.com/DumbMice/pi-todo-loop/releases/tag/v0.3.0
[Unreleased]: https://github.com/DumbMice/pi-todo-loop/compare/v0.3.0...HEAD
