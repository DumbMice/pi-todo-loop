/**
 * @dumbmice/pi-todo-loop — continuation driven by an rpiv-todo list.
 *
 * Pairs with `@juicesharp/rpiv-todo`; does not import or patch it. Three hooks:
 *
 *   context    drop a marker that would sit next to a human message, and
 *              nothing else: the prompt is never rewritten with task state
 *   turn_end   request another turn while tasks are open, bounded by
 *              maxRounds / maxStrikes (see loop.ts)
 *   /todoloop  status | pause | resume | reset
 *
 * Architecture notes worth keeping in mind when changing this file:
 *
 *   - A `turn_end` continuation must leave the final message role != assistant,
 *     so one entry is mandatory (`_buildBoundaryContext().canContinue` in pi
 *     1.5.0). We append a `custom_message` with `display: false`.
 *   - Markers are never removed from history: they sit between assistant turns and
 *     are what keep the conversation alternating. A marker at the tail is replaced
 *     by the state block, so the request ends on exactly one user message.
 *   - pi's non-assistant requirement binds the *persisted projection* checked at
 *     `turn_end`, not the provider request (register item 3).
 *   - The marker customType is deliberately stable: sessions created by earlier
 *     builds keep filtering correctly.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { decide, initialState, type LoopState } from "./loop.ts";
import { readSnapshot } from "./state.ts";

/**
 * Snapshot of the pi extension API surface this file depends on. Keep in step
 * with the header of `docs/pi-api-alignment.md`.
 *
 * No pi type import on purpose: the extension is loaded by pi and the type
 * package would otherwise need to be a dependency, for one signature.
 */
export const PI_API_SNAPSHOT = "1.5.0";

/** The part of `ExtensionContext` this extension reads. */
interface SessionContext {
	readonly cwd: string;
	readonly sessionManager: { getBranch(): readonly unknown[] };
	readonly ui: { notify(message: string, level: "info" | "error" | "warning"): void };
}

/** Stable across versions: the tail check must keep recognising markers from earlier builds. */
export const MARKER_TYPE = "todo-loop:continue";

/**
 * The only text this extension ever gives the model. It keeps the persisted
 * history alternating, gives `turn_end` a non-assistant tail, and points at the
 * todo tool rather than restating state: the list is the agent's to read.
 * It carries no counters, so a stale marker in history cannot claim the loop is
 * on some other round.
 */
export const MARKER_BODY =
	"Continue with the open todo tasks; use the todo tool to read and update the list. If the human's latest instruction says to stop or limits what to do, do that instead.";

export const CONFIG_PATH = join(homedir(), ".pi/agent/todo-loop.json");
const KILL_SWITCH_GLOBAL = join(homedir(), ".pi/agent/todo-loop-off");

/**
 * Overrides for tests and embedding. Production always uses the documented
 * paths; nothing else in the extension varies.
 */
export interface TodoLoopOptions {
	/** Replaces `~/.pi/agent/todo-loop.json`. */
	configPath?: string;
	/** Replaces `~/.pi/agent/todo-loop-off`. */
	killSwitchGlobal?: string;
	/** Replaces `.pi/todo-loop-off`, resolved against `ctx.cwd`. */
	killSwitchLocal?: string;
}

function branchEntries(ctx: SessionContext): readonly unknown[] {
	try {
		return (ctx.sessionManager.getBranch() as readonly unknown[]) ?? [];
	} catch {
		return [];
	}
}

export default function todoLoop(pi: any, options: TodoLoopOptions = {}): void {
	const configPath = options.configPath ?? CONFIG_PATH;
	const killSwitchGlobal = options.killSwitchGlobal ?? KILL_SWITCH_GLOBAL;
	const killSwitchLocal = options.killSwitchLocal ?? ".pi/todo-loop-off";

	const isDisabled = (ctx: SessionContext): boolean => {
		try {
			return existsSync(killSwitchGlobal) || existsSync(join(ctx.cwd, killSwitchLocal));
		} catch {
			// existsSync swallows ENOENT; anything else must not fail a turn.
			return false;
		}
	};

	const state: LoopState & { paused: boolean; reason: string; lastOpenCount: number } = {
		...initialState(),
		paused: false,
		reason: "idle",
		lastOpenCount: 0,
	};

	pi.on("context", async (event: any, ctx: SessionContext) => {
		if (isDisabled(ctx) || state.paused) return undefined;
		// A hook that rewrites an unknown payload into a one-message request is
		// worse than doing nothing; leave the request alone.
		if (!Array.isArray(event?.messages)) return undefined;

		const original = event.messages as unknown[];
		const record = (message: unknown): Record<string, unknown> | null =>
			typeof message === "object" && message !== null ? (message as Record<string, unknown>) : null;
		const isMarker = (message: unknown): boolean => record(message)?.customType === MARKER_TYPE;
		// pi projects every role except these to a user-role message in the request.
		const NON_USER_ROLES = new Set(["assistant", "toolResult", "system", "tool"]);
		const isUserRole = (message: unknown): boolean => {
			const role = record(message)?.role;
			return typeof role === "string" && !NON_USER_ROLES.has(role);
		};

		// Nothing is ever *added* to a request: the prompt the human sends, and every
		// tool turn, go out exactly as built. The one thing this hook may do is remove
		// the marker this extension itself appended, when it would sit next to a human
		// message and project to `user → user` — an adjacency pi's providers reject, and
		// one the extension created. Between two assistant turns the marker stays: it is
		// the glue that keeps that pair alternating.
		const neighbour = (list: unknown[], from: number, step: number): unknown => {
			for (let index = from; index >= 0 && index < list.length; index += step) {
				if (!isMarker(list[index])) return list[index];
			}
			return undefined;
		};
		const kept = original.filter((message, index, list) => {
			if (!isMarker(message)) return true;
			// Keep only the first marker of a run: that is what preserves
			// `assistant → marker → assistant`, while testing the literal neighbours drops
			// the whole run and leaves two assistant turns adjacent.
			if (isMarker(list[index - 1])) return false;
			const previous = neighbour(list, index - 1, -1);
			const next = neighbour(list, index + 1, 1);
			// Drop it only when it would project to `user → user`: next to a human message,
			// on either side. A marker at the tail is the nudge itself — dropping it would
			// leave the continuation request ending on an assistant turn.
			return !isUserRole(previous) && !isUserRole(next);
		});

		return kept.length === original.length ? undefined : { messages: kept };
	});

	pi.on("turn_end", async (event: any, ctx: SessionContext) => {
		if (isDisabled(ctx) || state.paused) return undefined;

		const config = loadConfig(configPath);
		const snapshot = readSnapshot(branchEntries(ctx));
		const toolResults = Array.isArray(event?.toolResults) ? (event.toolResults as unknown[]) : [];
		const toolResultCount = toolResults.length;
		// `turn_end` fires for every assistant response, including one that ended in a
		// tool call. Such a turn already causes pi's next request, so a continuation
		// would be redundant — and counting it as a round spends the budget on work the
		// loop did not cause. Only a settle (no tool results) can spend a round.
		//
		// A tool turn is still *work*, so it clears a pending strike: without this, a
		// model that runs tools and never updates the list (the case this extension is
		// for) collects two strikes across its settles and stops with "no progress"
		// while it was working the whole time.
		// A list that goes open -> clear in a turn whose only tool calls were `todo` is
		// the loop's success state and its failure state at once. Never police it;
		// just do not launder the trust: say so once.
		if (snapshot.open.length === 0 && state.lastOpenCount > 0 && toolResultCount > 0) {
			const names = toolResults.map((result) => String((result as Record<string, unknown>)?.toolName ?? ""));
			const onlyTodo = names.every((name) => name === "todo");
			if (onlyTodo) {
				ctx.ui?.notify?.(
					"todo-loop: the list was cleared by todo calls alone in that turn — no other tool work accompanied it",
					"warning",
				);
			}
		}
		state.lastOpenCount = snapshot.open.length;

		if (toolResultCount > 0) {
			if (String(event?.outcome) !== "completed") {
				state.reason = `stopped: turn outcome was ${String(event?.outcome)}`;
				return undefined;
			}
			state.strikes = 0;
			return undefined;
		}

		const decision = decide({
			outcome: String(event?.outcome),
			toolResultCount,
			signature: snapshot.signature,
			openCount: snapshot.open.length,
			taskCount: snapshot.tasks.length,
			anchor: snapshot.anchor,
			state,
			config,
		});

		if (!decision.continue) {
			const previous = state.reason;
			Object.assign(state, decision.next, { reason: decision.reason });
			// A stop is otherwise silent until someone runs /todoloop.
			if (previous !== decision.reason) ctx.ui?.notify?.(`todo-loop: ${decision.reason}`, "info");
			return undefined;
		}

		// Build the proposal before committing the counters: a throw here (or a
		// proposal pi rejects) must not leave `/todoloop` reporting a round that
		// never happened.
		const entries = Array.isArray(event?.entries) ? (event.entries as unknown[]) : [];
		const next = decision.next;
		const proposal = {
			continue: true,
			entries: [
				...entries,
				{
					type: "custom_message",
					customType: MARKER_TYPE,
					content: MARKER_BODY,
					display: false,
				},
			],
		};

		Object.assign(state, next, { reason: decision.reason });
		return proposal;
	});

	pi.registerCommand("todoloop", {
		description: "Show or control the todo-driven continuation loop",
		handler: async (args: string, ctx: SessionContext) => {
			const raw = (args ?? "").trim();
			const [command, ...rest] = raw.toLowerCase().split(/\s+/);
			const config = loadConfig(configPath);

			if (command === "pause") {
				state.paused = true;
				state.reason = "paused by user";
				ctx.ui?.notify?.("todo-loop: paused in this session", "info");
				return;
			}
			if (command === "resume") {
				state.paused = false;
				state.reason = "resumed by user";
				ctx.ui?.notify?.("todo-loop: resumed", "info");
				return;
			}
			if (command === "reset") {
				Object.assign(state, initialState(), { paused: state.paused, reason: "counters reset" });
				ctx.ui?.notify?.("todo-loop: counters reset", "info");
				return;
			}

			if (command !== "" && !["status", "pause", "resume", "reset"].includes(command)) {
				ctx.ui?.notify?.(
					`todo-loop: unknown argument "${command}"; use status, pause, resume or reset`,
					"warning",
				);
			} else if (rest.length > 0) {
				ctx.ui?.notify?.(
					`todo-loop: ignoring extra arguments "${rest.join(" ")}"; use status, pause, resume or reset`,
					"warning",
				);
			}

			const snapshot = readSnapshot(branchEntries(ctx));
			const mode = isDisabled(ctx)
				? "DISABLED (kill-switch present)"
				: state.paused
					? "PAUSED"
					: state.reason.startsWith("stopped:")
						? "stopped (next human message starts a new budget)"
						: "active";
			ctx.ui?.notify?.(
				[
					`todo-loop ${mode}`,
					`rounds ${state.rounds}/${config.maxRounds} · strikes ${state.strikes}/${config.maxStrikes}`,
					`open ${snapshot.open.length}/${snapshot.tasks.length} tracked`,
					`anchor ${snapshot.anchor || "(none)"}`,
					`last: ${state.reason}`,
					`config ${configPath}`,
				].join("\n"),
				"info",
			);
		},
	});
}

