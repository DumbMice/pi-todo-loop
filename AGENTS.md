# Working on this repository

Instructions for anyone — human or coding agent — changing `pi-todo-loop`. For what the extension
does and how to install it, read [README.md](README.md).

## Layout

```
src/index.ts              pi wiring: the context hook, the turn_end hook, /todoloop
src/loop.ts               the pure decision policy (rounds, strikes, anchor reset)
src/state.ts              reads rpiv-todo state off the session branch
src/inject.ts             renders the per-request <todo_loop_state> block
src/config.ts             config load and coercion, defaults on any failure
test/loop.test.ts         decision policy: caps, strikes, anchor reset, error outcomes
test/state.test.ts        branch reader: both shapes, recency preference, malformed input
test/inject.test.ts       renderer and config coercion
test/index.test.ts        the pi-facing half through a stub `pi`: tail handling, kill switch, caps
test/state-machine.test.ts the counters as a table of event sequences (the suite to extend)
test/helpers/harness.ts   the stub `pi`, mutable branch and scripted context those two share
test/fixture.test.ts      the same hooks over real captured lines (test/fixtures/branch.jsonl)
test/docs.test.ts         pins the version table, invariant map, reason table, config table, links
scripts/check-pack.mjs    asserts the published tarball contains what package.json promises
docs/pi-api-alignment.md  every deliberate workaround over pi's documented extension API
README.md                 user-facing documentation
AGENTS.md                 this file
CONTRIBUTING.md           four-line pointer to this file (GitHub convention)
CHANGELOG.md              Keep a Changelog format, released and unreleased entries
package.json              scripts, engines, the files allow-list, pi.extensions entry point
tsconfig.json             the strict / noEmit settings used by typecheck
.github/workflows/        test.yml (Node 22.6, 22 and 24: ci, test, typecheck, pack)
```

## Requirements and commands

Node >= 22.6 (`engines`; the entry point is TypeScript and the test runner uses
`--experimental-strip-types`). devDependencies stay limited to `typescript` and `@types/node`; the test
workflow installs with `npm ci`.

```bash
npm install        # devDependencies only: typescript, @types/node
npm test           # node:test, no model, no key, no network
npm run typecheck  # tsc -p tsconfig.json, strict
npm run pack:check # asserts src, docs, tsconfig, README, AGENTS, CONTRIBUTING, LICENSE, CHANGELOG ship

# one file, while iterating
node --experimental-strip-types --no-warnings --test test/loop.test.ts
```

There is no pi install and no build step: the source is TypeScript that pi loads directly, and
`npm run typecheck` resolves no pi types because the extension imports none.

## Design decisions worth preserving

These are the invariants the suite protects. Changing one means changing its test, any affected
README text, the matching `docs/pi-api-alignment.md` item (or marking that item inapplicable), and
adding a `CHANGELOG.md` line — all in the same commit.

- **Merge only into a `user` or `custom` tail.** pi rebuilds `bashExecution`/`branchSummary`/
  `compactionSummary` content from their own fields and ignores `content`, so merging into those would
  delete the block; they get a separate message and a documented adjacency (register item 15).
- **A `todo`-only clear is announced, not policed.** The loop's success and failure states are the same
  observable; a warning is the most it may do about it.
- **Task text is model-authored, so it is sanitised, not interpolated.** `sanitizeLabel` collapses
  flattens every Unicode line terminator, escapes `<`, drops controls/bidi/unpaired surrogates and
  truncates by code point, because a subject can come from a fetched page and is rendered at the end of
  a request inside a tag. **`status` is task-authored too** and gets the same treatment. Never render a
  task field raw.
- **A marker is kept only where it separates two assistant turns.** There it is the alternation glue;
  removing it exposes consecutive assistant messages that alternation-requiring providers reject. Any
  other marker — at the tail, or followed by a human message — is dropped, because it would duplicate a
  real user turn. The test `no returned request ever contains two adjacent user-role messages` is the
  general statement; if you change the filter, run it first.
- **The marker body is constant** (`<todo_loop_continue/>`). It carries no round counter, because a
  persisted marker must not claim the loop is on round `n` long after that chain ended. Counters live in
  memory and are reported by `/todoloop`.
- **The injection is conditional; the marker is not.** The block is appended only when `injectState` is
  on and tasks are open. The non-assistant constraint is pi's `turn_end` projection check, not the
  request (register item 3) — do not re-derive a coupling between the two.
- **One entry per continuation is a floor, not a choice.** pi has no `resume()` that appends nothing.
  Do not try to reach zero entries; keep the single `custom_message` with `display: false`.
- **The marker `customType` is a stable literal.** The tail check must keep recognising markers written
  by earlier builds; do not derive it from the package name or version.
- **Task state is read from the branch on every request.** No in-memory cache of the list, no
  `session_compact` resync handler: memory would drift across forks and compaction. Loop state
  (counters, anchor, pause) *is* in memory, and a restart necessarily starts a new budget.
- **The decision is a pure function.** `decide()` in `src/loop.ts` takes a value and returns a value.
  It must stay free of pi, filesystem and time so the caps can be tested exhaustively.
- **Only a settle spends a round.** `turn_end` fires for every assistant response, including one that
  ended in a tool call; those already cause pi's next request, so the hook returns before deciding. A
  round, a marker and a strike are therefore always about a turn that would have ended the run.
- **A tool turn clears a strike and spends no round** — except a tool turn that ends `error`/`aborted`,
  which records the stop and leaves the strike budget alone. Tool turns already cause pi's next request, so
  they must not consume the budget; but they are work, so they reset `strikes`. Without that, a model
  that runs tools and never updates the list collects two strikes across its settles and stops claiming
  "no progress" while it was working.
- **A stop keeps the counters; only a new human message resets them.** Clearing `rounds` / `strikes` on
  stop re-arms a full budget on the next `turn_end` under the same anchor (another extension's
  continuation, a provider retry). The anchor comparison is the only *automatic* reset;
  `/todoloop reset` and process start clear the counters explicitly. A queued human message is a
  new anchor, so it resets the budget the ordinary way.
- **Open means "not finished".** `CLOSED_STATUSES` is an exclusion list (`completed`, `deleted`), not an
  allow-list: a status the todo tool adds later must not make a task vanish and the loop report the
  list clear while work remains.
- **The newer of the two shapes wins.** Custom entry and toolResult fallback are compared by branch
  position, not by type preference; preference by type would serve a stale list forever if the tool
  stopped writing custom entries partway through a session.
- **No runtime dependencies.** The only imports are `node:` builtins. Argument validation, config
  parsing and rendering are hand-written for that reason.
- **Fail soft at the boundary.** Parsing a branch, a config file or an entry never throws: malformed
  input degrades to "no list" or to defaults. A thrown boundary handler is reported and the turn
  continues, but the loop would then stop silently — inert is better than loud.
- **Nothing is written.** No files, no network, no process execution. The only reads are the optional
  config, the two kill-switch paths and the session branch.
- **The kill switch is checked in both hooks.** Disabling takes effect on the next request, without
  `/reload`.
- **No pi type import; `pi: any` at the registration boundary.** Contexts the file reads are typed
  structurally (`SessionContext`). Adding the pi types would make a dependency out of a package that
  deliberately has none.

## Invariant → test map

Find the invariant you are touching, run the case that pins it, and add a neighbour if your change
introduces an edge.

| Invariant | Pinned by |
|---|---|
| continues only while items are open | `continues while work is open and the turn did work`, `stops when the list is clear`, `stops when there is no list at all` |
| error and aborted outcomes never continue | `never continues on an error or aborted turn` |
| a no-progress turn spends a strike, the second stops | `a text-only turn that changes nothing spends a strike, then stops` |
| the first sighting of a list is progress, not a strike | `the first sighting of a list counts as progress, not a strike` |
| a list change resets strikes even with no tool call | `a list change counts as progress even with no tool results` |
| the round cap stops the loop | `round cap stops the loop`, `config caps are honoured` |
| a new human message resets the budget | `a new human message resets the budget` |
| a stop keeps the counters for the anchor, and a new message clears them | `a stop keeps the counters, so a cap stays shut for the same anchor`, `a new human message after a stop starts a fresh budget`, `the round cap is sticky for one human message` |
| the newest custom entry wins over older ones | `reads the newest rpiv-todo custom entry` |
| the toolResult fallback works and loses to the custom entry | `falls back to todo toolResult details`, `prefers the custom entry over the toolResult fallback` |
| the anchor is the newest `role:"user"` message without a `customType` — not assistant, toolResult, our own marker, or another extension's custom user message | `anchor is the newest human message id, ignoring assistant and toolResult`, `our own projected marker never becomes the anchor`, `a user message without an id anchors on its position` |
| `deleted` tasks leave list, open set and signature | `deleted tasks are excluded from tasks, open and signature` |
| malformed entries degrade to the empty snapshot | `malformed or missing state degrades to the empty snapshot` |
| config defaults survive garbage; fields are coerced | `missing or malformed config falls back to defaults`, `valid fields override, invalid ones are ignored` |
| model-authored task text is sanitised before it enters a request | `a hostile task subject cannot break out of the tag` |
| the injection shows open tasks only, bounded, `activeForm` for in_progress | `injection lists open tasks with their status`, `injection is bounded and reports the overflow`, `injection uses activeForm only for in_progress`, `injection tolerates an empty subject` |
| a status change moves the signature | `signature changes when a status changes` |
| a record with neither a label nor a status is not a task, and arrays are not tasks | `a record with neither a label nor a status is not a task`, `an array element is not a task` |
| only a `todo` tool's own shapes are read | `a foreign custom entry or toolResult carrying tasks is ignored` |
| an unknown status counts as open, and status text is normalised | `an unknown status counts as open, not as done`, `status is normalised, so a differently-cased value still closes` |
| ids are made distinct: a synthetic or colliding id moves to a free number, a unique real id is never renumbered | `a positional id never shadows a real one`, `duplicate ids in the source are made distinct`, `a synthetic id never renumbers a real one, even when it comes first` |
| a task without a usable id falls back to its position | `a task without a usable id falls back to its position, not to being dropped`, `a null or empty id falls back to the position instead of colliding on 0` |
| the newer shape wins, in either order | `the newer of a custom entry and a toolResult wins, in either order` |
| the block is appended only when injecting, replacing a tail marker | `context strips the marker and appends the state block when tasks are open`, `a tail marker is replaced by the block, never followed by it`, `the block is appended when the tail is an assistant turn`, `the request never ends with two user-role messages` |
| history markers are left in place; they are the alternation glue | `history markers are left alone when nothing is injected`, `history markers are left alone when injection is disabled` |
| a malformed context payload is not rewritten | `context leaves a malformed payload alone instead of rewriting it` |
| a task subject cannot break out of the injection tag | `a hostile task subject cannot break out of the tag` |
| the block ends on the concession, not on a call to act | `the block ends on the concession, not on a call to act` |
| pause stops the block as well as the continuation | `pause stops both the continuation and the steering block` |
| either kill switch disables both hooks | `the global kill switch disables both hooks`, `the project-local kill switch disables both hooks` |
| only a settle spends a round: tool turns cost nothing | `a turn that ran tools spends no round and appends no marker` |
| a tool turn clears a pending strike | `tool turns clear a pending strike but never spend a round` |
| a continuation appends one hidden `custom_message` with a constant body and preserves prior proposals | `turn_end requests one turn with a hidden marker when work is open` |
| a user-role tail receives the block instead of a second message (marker first dropped) | `a human-role tail receives the block instead of a second user message`, `a marker after a human message still yields one user-role tail` |
| a malformed event payload does not throw | `turn_end tolerates a malformed event payload instead of throwing` |
| clamped and invalid config values fall back | `numbers are clamped so a typo cannot defeat the cap it configures`, `a value below 1 is treated as invalid, not as zero` |
| an errored or aborted turn is never continued | `turn_end stops on an errored or aborted turn and does not spend a round` |
| the cap and pause gate the loop at the hook level | `the round cap is sticky for one human message`, `pause stops both the continuation and the steering block` |
| the docs match the code | `the pi snapshot constant appears in the README and the register`, `the verification date appears in the README and the register`, `the tested rpiv-todo version is recorded in both places`, `the CHANGELOG documents the version in package.json`, `every README link target inside the repository exists`, `every test name the invariant map cites actually exists`, `every stop reason the code can report appears in the README table`, `the README configuration table states every default, not just the numbers` |

## Adding or changing a continuation rule

1. Put the logic in `decide()` (`src/loop.ts`), not in the hook. The hook only adapts events and
   applies the returned state. Add a row to `SCENARIOS` in `test/state-machine.test.ts` for the new
   behaviour before touching prose.
2. Add the field to `LoopState` or `DecisionInput` if new information is needed, and make it
   default-safe: a session recorded by an older build must still decide sensibly.
3. Add cases to `test/loop.test.ts`: the new rule, its boundary, and the ordering against the reset
   and cap rules. Order matters — the anchor reset runs before every other check.
4. Add a user-visible line to the `/todoloop` status if an operator needs to see it.
5. Update the README *Behaviour to expect* list and `CHANGELOG.md` under `[Unreleased]`.

## Fragile areas

Ranked by how easily a small change breaks them.

1. **Two different tails.** A continuation whose *persisted projection* ends on an assistant message is
   rejected by pi (`canContinue`); the *request* has no such constraint but must keep role alternation.
   Conflating the two produced the round-2 marker leak. `test/index.test.ts` pins both shapes.
2. **Counter lifecycle.** `rounds`, `strikes` and `anchor` are mutated in one place and reset in three
   (anchor change, `/todoloop reset`, process start). A missing reset either loops forever or refuses to
   continue after one bad turn; a reset in the wrong place (inside `stop()`) silently re-arms the cap.
3. **The anchor.** It must be human-authored and never empty. `#<index>` is the fallback when an entry
   carries no id; returning `""` would make "no anchor yet" and "this entry had no id"
   indistinguishable, freezing the per-message reset. A branch switch that lands on a sibling branch
   with the same newest user entry keeps the spent budget — deliberate, so a fork cannot refill it.
4. **State shape drift in the todo tool.** Both shapes are read defensively; keep `normalizeTask`
   tolerant of renamed fields (`content` vs `subject`) and of unusable ids, and keep `withUniqueIds` in
   `snapshotFrom` — it moves only synthetic or *colliding* ids, never a unique one the payload supplied,
   because that number is what the model must use to update the task.
5. **Branch walking.** The reader stops once it holds a list in *either* shape and the anchor. It walks
   newest-first, so a toolResult newer than the custom entry is already in hand; the extra walking is to
   reach the anchor, which is older than the newest list entry. Breaking out on the list alone leaves
   `anchor` empty, which makes every turn look like a new human message and re-arms the full budget each
   time.

## Tests

`test/*.test.ts` uses `node:test` and imports the source directly; nothing needs a model, a key or a
network. `test/state-machine.test.ts` is the one to extend when you touch the counters: it replays sequences in
the vocabulary pi actually produces — `settle` (a response with no tool calls), `tool` (a response that
ended in tool calls), `edit` (the list changed), `human` (a new message), plus pause/resume/reset/
error/abort/kill-switch — and asserts the whole outcome at once: continuations, markers, rounds,
strikes, the reason `/todoloop` prints and its header. Every release-blocking defect in this repository's
history lived in that interaction, so a new rule belongs there as a row in `SCENARIOS` before it belongs
in prose.

`test/index.test.ts` fakes pi's surface (an object with `on` and `registerCommand`, plus a
`SessionContext` over a hand-built branch) and asserts the hook *return values*; it is the only place
the tail coupling is checked. `test/docs.test.ts` reads the repository's own Markdown, which is how the
tested-version table is enforced. When fixing a bug, add the failing case first. Run `npm test` before every commit; CI repeats
it on Node 22 and 24 together with `npm run typecheck` and `npm run pack:check`.

### Try a change locally

There is no build step: pi loads `src/index.ts` through `package.json` → `pi.extensions`.

```bash
pi -e /absolute/path/to/pi-todo-loop    # one session, straight from the working copy
```

A live check needs `rpiv-todo` installed and an agent that creates a task list. Ask for two tasks and
then tell it to stop; with the loop active you should see it continue, and `/todoloop` should report
`round 1/12`. To watch the hidden machinery:

```bash
grep -c 'todo-loop:continue' ~/.pi/agent/sessions/<project>/*.jsonl   # one per continuation
```

## Documentation conventions

- `README.md` is for users of the extension: when to use it, install, configuration, commands,
  observable behaviour, troubleshooting. No implementation inventories, no CI or release steps.
- `docs/pi-api-alignment.md` is the register of deliberate workarounds over pi's documented extension
  API, and the record of which versions those were established against. Add an item when behaviour
  deviates; items with no output signal are marked _(silent)_. The tested-version table at the top,
  `PI_API_SNAPSHOT` in `src/index.ts`, and the README *Tested against* table move together in the
  same commit as the change that depends on them, and `test/docs.test.ts` fails if the constant, the
  date or the tested rpiv-todo version goes missing from either file. Note that `@juicesharp/rpiv-todo`
  is a *shape* dependency only (register item 12): it is never imported, so it has no `package.json`
  entry, and its tested version lives in that table rather than in a constant.
- `CHANGELOG.md` follows Keep a Changelog. Put unreleased work under `[Unreleased]` with
  Added/Changed/Fixed headings; add the version heading when the release is tagged. `test/docs.test.ts`
  fails if the published version has no entry, so this one is enforced.
- `AGENTS.md` (this file) holds contributor, architecture and release material.

## Release canary

The one failure this suite cannot see is pi changing how a `display: false` `custom_message` projects,
or tightening `canContinue`. Drafts are committed before the continuation is validated, so that change
would persist a marker, drop the continuation, and leave `/todoloop` reporting `continuing: round n/12`
until it reports `round cap` with zero continuations — while every test here stays green, because the
harness drives a stub `pi`.

Before every version bump, on the *new* pi, run the documented live check once:

```bash
pi -e . -p "create two todos 'a' and 'b', then reply ok" --tools todo
grep -c 'todo-loop:continue' ~/.pi/agent/sessions/--<project>--/*.jsonl   # 0 is a failure
```

and read the pi changelog for `custom_message`, `display`, `canContinue`, plus rpiv-todo's for
`reminder` (upstream PR #190 would put a second task block in the request).

## Known limitations to revisit

- **The decision is at `turn_end`, one boundary early.** pi 1.5.0 documents `agent_before_settle` as
  the final actionable boundary that can append entries and request one continuation, and at
  `turn_end` the hook has to reconstruct "the run would otherwise end" from `toolResults.length === 0`.
  The consequence is a bounded wasted round when a human message is queued mid-turn, and the strike
  reset lives in the adapter rather than in `decide()`. Moving the decision is the 0.2.0 change; it must
  ship with a CHANGELOG line because it changes which turns spend a round.
- **`getBranch()` is not the model-visible context** (register item 16): after compaction the panel can
  show work the model has no list for.

## Release process

**0.1.0 is published manually** — there is no publish workflow in this repository, so trusted
publishing and provenance are not available yet. Run `npm login`, then `npm publish`; `prepublishOnly`
runs the suite, the typecheck and the pack check first, so a publish cannot ship a tarball nothing
verified. When a publish workflow lands, switch it to [trusted
publishing](https://docs.npmjs.com/trusted-publishers): the workflow exchanges a GitHub OIDC token for
a short-lived credential, no `NPM_TOKEN` is needed, and npm attaches a provenance attestation
automatically on a public repository.

```bash
npm version patch --no-git-tag-version    # or minor/major; the working tree must be clean
VERSION="$(node -p "require('./package.json').version")"
# add the CHANGELOG.md entry for this version, then:
git add -A                                 # include any new docs; -am skips untracked files
git commit -m "chore: release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
```

`--follow-tags` pushes only **annotated** tags, which is why the recipe uses `git tag -a`; a
lightweight tag would stay local and publish nothing.

**There is no publish workflow in this repository.** `.github/workflows/test.yml` runs the suite,
typecheck and pack check only. After pushing the tag, publish from the tagged commit in a clean tree:
`npm publish` (its `prepublishOnly` repeats those three checks). If a trusted-publishing workflow is
added later, it must also refuse to publish when the tag and `package.json` version disagree. Until
then, the tag is a bookmark, not a release.

## Commits and security

- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`); release commits are
  `chore: release vX.Y.Z`.
- Style: tabs and double quotes, no formatter or linter in the repository. Do not reformat untouched
  lines.
- Report vulnerabilities through GitHub's private advisory form (Security → Report a vulnerability),
  not a public issue.
- Contributions are accepted under the MIT license (see [LICENSE](LICENSE)).
