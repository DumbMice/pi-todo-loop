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
test/index.test.ts        the pi-facing half through a stub `pi`: tail coupling, kill switch, caps
test/docs.test.ts         pins the tested-version table, the date and README link targets
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
npm run pack:check # tarball contents: src, docs, README, AGENTS, CONTRIBUTING, LICENSE, CHANGELOG

# one file, while iterating
node --experimental-strip-types --no-warnings --test test/loop.test.ts
```

There is no pi install and no build step: the source is TypeScript that pi loads directly, and
`npm run typecheck` resolves no pi types because the extension imports none.

## Design decisions worth preserving

These are the invariants the suite protects. Changing one means changing its test, any affected
README text, the matching `docs/pi-api-alignment.md` item (or marking that item inapplicable), and
adding a `CHANGELOG.md` line — all in the same commit.

- **The marker and the injection are coupled.** Stripping `todo-loop:continue` from the request
  removes the tail that satisfied pi's non-assistant requirement, so the same handler must append the
  state block. Do not implement one without the other.
- **One entry per continuation is a floor, not a choice.** pi has no `resume()` that appends nothing.
  Do not try to reach zero entries; keep the single `custom_message` with `display: false`.
- **The marker `customType` is a stable literal.** Sessions recorded by earlier builds must keep
  filtering; do not derive it from the package name or version.
- **Task state is read from the branch on every request.** No in-memory cache of the list, no
  `session_compact` resync handler: memory would drift across forks and compaction. Loop state
  (counters, anchor, pause) *is* in memory, and a restart necessarily starts a new budget.
- **The decision is a pure function.** `decide()` in `src/loop.ts` takes a value and returns a value.
  It must stay free of pi, filesystem and time so the caps can be tested exhaustively.
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
| a stop keeps the counters, so the cap stays shut for the same anchor | `a stop keeps the counters, so a cap stays shut for the same anchor`, `a new human message after a stop starts a fresh budget` |
| the newest custom entry wins over older ones | `reads the newest rpiv-todo custom entry` |
| the toolResult fallback works and loses to the custom entry | `falls back to todo toolResult details`, `prefers the custom entry over the toolResult fallback` |
| the anchor is the newest human message: not assistant, toolResult, or our own marker | `anchor is the newest human message id, ignoring assistant and toolResult`, `our own projected marker never becomes the anchor`, `a user message without an id anchors on its position` |
| `deleted` tasks leave list, open set and signature | `deleted tasks are excluded from tasks, open and signature` |
| malformed entries degrade to the empty snapshot | `malformed or missing state degrades to the empty snapshot` |
| config defaults survive garbage; fields are coerced | `missing or malformed config falls back to defaults`, `valid fields override, invalid ones are ignored` |
| the injection shows open tasks only, bounded, `activeForm` for in_progress | `injection lists open tasks with their status`, `injection is bounded and reports the overflow`, `injection uses activeForm only for in_progress`, `injection tolerates an empty subject` |
| a status change moves the signature | `signature changes when a status changes` |
| an unknown status counts as open, and status text is normalised | `an unknown status counts as open, not as done`, `status is normalised, so a differently-cased value still closes` |
| a task without a usable id falls back to its position | `a task without a usable id falls back to its position, not to being dropped`, `a null or empty id falls back to the position instead of colliding on 0` |
| the newer shape wins, in either order | `the newer of a custom entry and a toolResult wins, in either order` |
| every marker is stripped from every request; the block is appended only when injecting | `context strips the marker and appends the state block when tasks are open`, `context strips earlier markers when the list is clear, and appends nothing`, `context strips markers and appends no block when injection is disabled`, `context leaves a malformed payload alone instead of rewriting it` |
| either kill switch disables both hooks | `the global kill switch disables both hooks`, `the project-local kill switch disables both hooks` |
| a continuation appends one hidden `custom_message` with `display: false` and preserves prior proposals | `turn_end requests one turn with a hidden marker when work is open` |
| a malformed event payload does not throw | `turn_end tolerates a malformed event payload instead of throwing` |
| the cap and pause gate the loop at the hook level | `the round cap is sticky for one human message`, `pause and resume gate the loop` |
| the docs match the code | `the pi snapshot constant appears in the README and the register`, `the verification date appears in the README and the register`, `the tested rpiv-todo version is recorded in both places`, `the CHANGELOG documents the version in package.json`, `every README link target inside the repository exists`, `every test name the invariant map cites actually exists`, `every stop reason the code can report appears in the README table`, `the README configuration table states the real defaults` |

## Adding or changing a continuation rule

1. Put the logic in `decide()` (`src/loop.ts`), not in the hook. The hook only adapts events and
   applies the returned state.
2. Add the field to `LoopState` or `DecisionInput` if new information is needed, and make it
   default-safe: a session recorded by an older build must still decide sensibly.
3. Add cases to `test/loop.test.ts`: the new rule, its boundary, and the ordering against the reset
   and cap rules. Order matters — the anchor reset runs before every other check.
4. Add a user-visible line to the `/todoloop` status if an operator needs to see it.
5. Update the README *Behaviour to expect* list and `CHANGELOG.md` under `[Unreleased]`.

## Fragile areas

Ranked by how easily a small change breaks them.

1. **The tail invariant.** A continuation whose projection ends on an assistant message is rejected by
   pi. Every branch of the `context` hook must leave a non-assistant tail; the coupling rule above is
   the guard, and `test/index.test.ts` pins the three branches.
2. **Counter lifecycle.** `rounds`, `strikes` and `anchor` are mutated in one place and reset in three
   (anchor change, `/todoloop reset`, process start). A missing reset either loops forever or refuses to
   continue after one bad turn; a reset in the wrong place (inside `stop()`) silently re-arms the cap.
3. **The anchor.** It must be human-authored and never empty. `#<index>` is the fallback when an entry
   carries no id; returning `""` would make "no anchor yet" and "this entry had no id"
   indistinguishable, freezing the per-message reset.
4. **State shape drift in the todo tool.** Both shapes are read defensively; keep `normalizeTask`
   tolerant of renamed fields (`content` vs `subject`) and of unusable ids.
5. **Branch walking.** The reader breaks early on the newest *custom* entry plus the anchor, and keeps
   walking to find a newer toolResult if it has not seen one. An early return on the list alone can pick
   up a stale anchor and reset the budget mid-run.

## Tests

`test/*.test.ts` uses `node:test` and imports the source directly; nothing needs a model, a key or a
network. `test/index.test.ts` fakes pi's surface (an object with `on` and `registerCommand`, plus a
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
  is a *shape* dependency only (register item 11): it is never imported, so it has no `package.json`
  entry, and its tested version lives in that table rather than in a constant.
- `CHANGELOG.md` follows Keep a Changelog. Put unreleased work under `[Unreleased]` with
  Added/Changed/Fixed headings; add the version heading when the release is tagged. `test/docs.test.ts`
  fails if the published version has no entry, so this one is enforced.
- `AGENTS.md` (this file) holds contributor, architecture and release material.

## Release process

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): the workflow
exchanges a GitHub OIDC token for a short-lived credential, so the repository holds no `NPM_TOKEN` and
no long-lived write token is needed. Because the repository is public, npm attaches a provenance
attestation automatically — no `--provenance` flag.

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

```bash
npm publish
```

If a trusted-publishing workflow is added later, it must run those three checks and refuse to publish
when the tag and `package.json` version disagree. Until then, the tag is a bookmark, not a release.

## Commits and security

- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`); release commits are
  `chore: release vX.Y.Z`.
- Style: tabs and double quotes, no formatter or linter in the repository. Do not reformat untouched
  lines.
- Report vulnerabilities through GitHub's private advisory form (Security → Report a vulnerability),
  not a public issue.
- Contributions are accepted under the MIT license (see [LICENSE](LICENSE)).
