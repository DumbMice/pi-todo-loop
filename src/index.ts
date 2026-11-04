/**
 * pi-todo-loop — continuation driven by an rpiv-todo list.
 *
 * Pairs with `@juicesharp/rpiv-todo`; does not import or patch it. Three hooks:
 *
 *   context    append the live open-task list at the tail (never persisted),
 *              replacing a trailing marker so the request never ends user → user
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
import { renderInjection } from "./inject.ts";
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
 * Constant body. The marker exists to keep the persisted history alternating and to
 * give `turn_end` a non-assistant tail; it carries no counters, so a stale marker in
 * history cannot claim the loop is on some other round.
 */
export const MARKER_BODY = "<todo_loop_continue/>";

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

	const state: LoopState & { paused: boolean; reason: string } = {
		...initialState(),
		paused: false,
		reason: "idle",
	};

	pi.on("context", async (event: any, ctx: SessionContext) => {
		if (isDisabled(ctx)) return undefined;
		// A hook that rewrites an unknown payload into a one-message request is
		// worse than doing nothing; leave the request alone.
		if (!Array.isArray(event?.messages)) return undefined;

		const original = event.messages as unknown[];
		const config = loadConfig(configPath);
		// No injection configured: nothing below needs the branch at all.
		if (!config.injectState) return undefined;

		const snapshot = readSnapshot(branchEntries(ctx));
		const injecting = snapshot.open.length > 0;
		if (!injecting) return undefined;

		// The marker is persisted between assistant turns, so it is what keeps the
		// history alternating: assistant → marker(user) → assistant. Stripping the
		// historical ones would expose runs of consecutive assistant messages, which
		// alternation-requiring providers reject. So markers stay in history; only a
		// marker sitting at the tail (the continuation request about to be made) is
		// replaced by the state block, so the request never ends on user → user.
		const text = { type: "text", text: renderInjection(snapshot, config) };
		const record = (message: unknown): Record<string, unknown> | null =>
			typeof message === "object" && message !== null ? (message as Record<string, unknown>) : null;
		const isMarker = (message: unknown): boolean => record(message)?.customType === MARKER_TYPE;
		const isUserRole = (message: unknown): boolean => {
			const entry = record(message);
			if (entry === null) return false;
			// A custom_message projects to a user-role message; anything else is user
			// only when its role says so.
			return typeof entry.customType === "string" ? entry.role !== "assistant" : entry.role === "user";
		};

		// A marker only earns its place *between* two assistant turns, where it is the
		// alternation glue. Anywhere else it is redundant bookkeeping that would sit
		// next to a real user message and break alternation: drop it. That covers a
		// marker at the tail, a marker followed by a human message, and two markers in
		// a row.
		const kept = (original as unknown[]).filter((message, index, list) => {
			if (!isMarker(message)) return true;
			const previous = list[index - 1];
			const next = list[index + 1];
			// Both neighbours must exist and neither may be user-role: `[A, M, H]` and
			// `[A, H, M, A]` both leave a marker next to a human message, which is the
			// adjacency this filter exists to prevent.
			return previous !== undefined && next !== undefined && !isUserRole(previous) && !isUserRole(next);
		});

		// Nothing left to attach to: an empty request would be an instruction with no prompt.
		if (kept.length === 0) return undefined;

		const tail = kept[kept.length - 1];
		if (tail !== null && isUserRole(tail)) {
			// Merge into the human's own message rather than adding a second one after it.
			const entry = tail as Record<string, unknown>;
			const existing = Array.isArray(entry.content)
				? (entry.content as unknown[])
				: typeof entry.content === "string" && entry.content !== ""
					? [{ type: "text", text: entry.content }]
					: [];
			const content = [...existing, text];
			return { messages: [...kept.slice(0, -1), { ...entry, content }] };
		}

		return { messages: [...kept, { role: "user", content: [text] }] };
	});

	pi.on("turn_end", async (event: any, ctx: SessionContext) => {
		if (isDisabled(ctx) || state.paused) return undefined;

		const config = loadConfig(configPath);
		const snapshot = readSnapshot(branchEntries(ctx));
		const toolResultCount = Array.isArray(event?.toolResults) ? event.toolResults.length : 0;
		// `turn_end` fires for every assistant response, including one that ended in a
		// tool call. Such a turn already causes pi's next request, so a continuation
		// would be redundant — and counting it as a round spends the budget on work the
		// loop did not cause. Only a settle (no tool results) can spend a round.
		//
		// A tool turn is still *work*, so it clears a pending strike: without this, a
		// model that runs tools and never updates the list (the case this extension is
		// for) collects two strikes across its settles and stops with "no progress"
		// while it was working the whole time.
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
			Object.assign(state, decision.next, { reason: decision.reason });
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

			if (rest.length > 0) {
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
					`open ${snapshot.open.length}/${snapshot.tasks.length} tracked · inject ${config.injectState ? "on" : "off"}`,
					`anchor ${snapshot.anchor || "(none)"}`,
					`last: ${state.reason}`,
					`config ${configPath}`,
				].join("\n"),
				"info",
			);
		},
	});
}

