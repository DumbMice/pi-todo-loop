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
test/state.test.ts        branch reader: custom entry, toolResult fallback, malformed input
test/inject.test.ts       renderer and config coercion
docs/pi-api-alignment.md  every deliberate workaround over pi's documented extension API
README.md                 user-facing documentation
AGENTS.md                 this file
CONTRIBUTING.md           four-line pointer to this file (GitHub convention)
CHANGELOG.md              Keep a Changelog format, released and unreleased entries
package.json              scripts, engines, the files allow-list, pi.extensions entry point
tsconfig.json             the strict / noEmit settings used by typecheck
.github/workflows/        test.yml (Node 22 and 24)
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
```

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
- **State is read from the branch on every request.** No in-memory cache, no `session_compact`
  resync handler. Memory would drift across forks and compaction; the walk is cheap.
- **The decision is a pure function.** `decide()` in `src/loop.ts` takes a value and returns a value.
  It must stay free of pi, filesystem and time so the caps can be tested exhaustively.
- **No runtime dependencies.** The only imports are `node:` builtins. Argument validation, config
  parsing and rendering are hand-written for that reason.
- **Fail soft at the boundary.** Parsing a branch, a config file or an entry never throws: malformed
  input degrades to "no list" or to defaults. A thrown boundary handler is reported and the turn
  continues, but the loop would then stop silently — inert is better than loud.
- **Nothing is written.** No files, no network, no process execution. The only reads are the optional
  config and the session branch.
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
| a stop clears counters but keeps the anchor | `a stop clears the counters but keeps the anchor` |
| the newest custom entry wins over older ones | `reads the newest rpiv-todo custom entry` |
| the toolResult fallback works and loses to the custom entry | `falls back to todo toolResult details`, `prefers the custom entry over the toolResult fallback` |
| the anchor is the newest human message, not assistant or toolResult | `anchor is the newest human message id, ignoring assistant and toolResult` |
| `deleted` tasks leave list, open set and signature | `deleted tasks are excluded from tasks, open and signature` |
| malformed entries degrade to the empty snapshot | `malformed or missing state degrades to the empty snapshot` |
| config defaults survive garbage; fields are coerced | `missing or malformed config falls back to defaults`, `valid fields override, invalid ones are ignored` |
| the injection shows open tasks only, bounded, `activeForm` for in_progress | `injection lists open tasks with their status`, `injection is bounded and reports the overflow`, `injection uses activeForm only for in_progress` |

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
   the guard.
2. **Counter lifecycle.** `rounds`, `strikes` and `anchor` are mutated in one place and reset in four.
   A missing reset either loops forever or refuses to continue after one bad turn.
3. **State shape drift in rpiv-todo.** The custom entry is read defensively and falls back to the
   toolResult; keep `normalizeTask` tolerant of renamed fields (`content` vs `subject`).
4. **Branch walking.** The reader breaks early only when it has both the list and the anchor. A change
   that returns early on the list alone can pick up a stale anchor and reset the budget mid-run.

## Tests

`test/*.test.ts` uses `node:test` and imports the source directly; nothing needs a model, a key or a
network. When fixing a bug, add the failing case first. Run `npm test` before every commit; CI repeats
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
  API, verified against a stated pi version. Add an item when behaviour deviates; items with no output
  signal are marked _(silent)_. `PI_API_SNAPSHOT` appears in the `src/index.ts` header and at the top
  of the register — keep them in step.
- `CHANGELOG.md` follows Keep a Changelog. Put unreleased work under `[Unreleased]` with
  Added/Changed/Fixed headings; add the version heading when the release is tagged.
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
lightweight tag would stay local and publish nothing. The publish workflow runs the suite and the
typecheck, refuses to publish when the tag and `package.json` version disagree, then publishes.

## Commits and security

- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`); release commits are
  `chore: release vX.Y.Z`.
- Style: tabs and double quotes, no formatter or linter in the repository. Do not reformat untouched
  lines.
- Report vulnerabilities through GitHub's private advisory form (Security → Report a vulnerability),
  not a public issue.
- Contributions are accepted under the MIT license (see [LICENSE](LICENSE)).
