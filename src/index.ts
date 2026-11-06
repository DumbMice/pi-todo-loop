/**
 * @dumbmice/pi-todo-loop — continuation driven by an rpiv-todo list.
 *
 * Pairs with `@juicesharp/rpiv-todo`; does not import or patch it. Hooks and tool:
 *
 *   context    drop a marker that would sit next to a human message, and
 *              nothing else: the prompt is never rewritten with task state
 *   turn_end   request another turn while tasks are open (uncapped unless maxRounds is
 *              set), and stop when the agent calls todo_loop_block
 *   todo_loop_block  the agent's "I need a person" signal, scoped to one message
 *   /todoloop  status | pause | resume | reset
 *
 * Architecture notes worth keeping in mind when changing this file:
 *
 *   - A `turn_end` continuation must leave the final message role != assistant,
 *     so one entry is mandatory (`_buildBoundaryContext().canContinue` in pi
 *     1.5.0). We append a `custom_message` with `display: false`.
 *   - Markers are never added to a request by this extension, and are only removed
 *     when one would sit next to a human message. A marker at the tail is the nudge.
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

/**
 * The same nudge for the first settle since progress that did not move the list — the shape
 * a blocked agent has. It is offered on exactly one request: repeating it would be pressure
 * rather than information. The concession stays last, so the block still ends by telling the
 * model the human outranks it.
 */
export const MARKER_BODY_HINT =
	"Continue with the open todo tasks; use the todo tool to read and update the list. If you cannot proceed without a person, call todo_loop_block with the reason. If the human's latest instruction says to stop or limits what to do, do that instead.";

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

	const state: LoopState & {
		paused: boolean;
		reason: string;
		lastOpenCount: number;
		/** Set by `todo_loop_block`: this message waits for a human. */
		waiting: { reason: string; anchor: string } | null;
	} = {
		...initialState(),
		paused: false,
		reason: "idle",
		lastOpenCount: 0,
		waiting: null,
	};

	// The agent's own exit. A blocked agent looks exactly like a lazy one from the
	// loop's side, so the loop cannot detect it — but the agent can say so. One
	// sentence of state, scoped to this message: the human's next message resumes.
	pi.registerTool({
		name: "todo_loop_block",
		label: "Block the todo loop",
		description:
			"Stop the automatic continuation loop for the rest of this message because you need a person: a decision, a review, a credential or information only the human has. The human is shown your reason and their next message resumes the loop. Use it only when you cannot proceed on the open tasks without them.",
		// Without a snippet pi leaves the tool out of the prompt's `<tools>` summary; it is
		// still in the request's tool array, but a model reading the prompt summary does not
		// see the exit until the nudge names it. The exit must not be hidden that way.
		promptSnippet: "Stop the todo loop for this message and ask the human for what you need",
		promptGuidelines: [
			"Use todo_loop_block when you cannot proceed on the open todo tasks without a person — a decision, a review, a credential or information only they have. If the choice is yours to make, pick the reasonable option and say what you assumed instead. Do not use it to end work you could finish yourself.",
		],
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "What you need from the human, in one sentence." },
			},
			required: ["reason"],
			additionalProperties: false,
		},
		async execute(_id: any, params: any, _signal: any, _onUpdate: any, ctx: SessionContext) {
			// The hooks respect the kill switch and pause; a tool must not be the one
			// surface that keeps talking after the extension was switched off.
			if (isDisabled(ctx) || state.paused) {
				return {
					content: [
						{ type: "text", text: "The todo loop is not running in this session, so there is nothing to block." },
					],
					details: undefined,
				};
			}
			// Model-authored and rendered in the TUI: one line, bounded, no control characters.
			// `\p{Cc}` covers C0 and C1 (U+0085 NEL and U+009B CSI included); the slice is by
			// code point, so a cut at the limit cannot split a surrogate pair.
			const cleaned = String(params?.reason ?? "")
				.replace(/\p{Cc}+/gu, " ")
				.replace(/\s+/g, " ")
				.trim();
			const reason = [...cleaned].slice(0, 200).join("");
			if (reason === "") {
				return {
					content: [
						{
							type: "text",
							text: "todo_loop_block needs a reason: one sentence saying what you need from the human.",
						},
					],
					details: undefined,
				};
			}
			const snapshot = readSnapshot(branchEntries(ctx));
			state.waiting = { reason, anchor: snapshot.anchor };
			state.reason = `waiting for you: ${reason}`;
			ctx.ui?.notify?.(`todo-loop: waiting for you — ${reason}`, "info");
			return {
				content: [
					{
						type: "text",
						text: `The loop is stopped for this message; the human sees: ${reason}. Do not start other work — wait for their next message.`,
					},
				],
				details: undefined,
			};
		},
	});

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
		// A tool turn is *work*, so it clears the stall counter and re-arms the block
		// hint: an agent that keeps working is not stuck, and a later stall is a new
		// question rather than a repeat of the old one.
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
		// The human answered: the block belonged to the previous message.
		if (state.waiting !== null && state.waiting.anchor !== snapshot.anchor) {
			state.waiting = null;
			state.reason = "resumed by user";
		}

		if (toolResultCount > 0) {
			if (String(event?.outcome) !== "completed") {
				state.reason = `stopped: turn outcome was ${String(event?.outcome)}`;
				return undefined;
			}
			state.stalled = 0;
			// It worked: the next stop is not a bare stall, so the hint's question changes.
			state.toolSinceStop = true;
			return undefined;
		}

		// The agent asked for a person. Nothing continues until the human answers; their
		// next message is a new anchor, so the block clears itself.
		if (state.waiting !== null && state.waiting.anchor === snapshot.anchor) {
			const waiting = `waiting for you: ${state.waiting.reason}`;
			if (state.reason !== waiting) {
				state.reason = waiting;
				ctx.ui?.notify?.(`todo-loop: ${waiting}`, "info");
			}
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
					content: decision.hint ? MARKER_BODY_HINT : MARKER_BODY,
					display: false,
				},
			],
		};

		Object.assign(state, next, { reason: decision.reason });
		// With no cap by default, a runaway must still become visible. `stalled` counts settles
		// that changed nothing, so real work resets it and a healthy run cannot spam this.
		if (next.stalled > 0 && next.stalled % 10 === 0) {
			ctx.ui?.notify?.(
				`todo-loop: ${next.stalled} settles without moving the list, ${snapshot.open.length} open — /todoloop pause stops it; set maxRounds for a hard bound`,
				"warning",
			);
		}
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
				Object.assign(state, initialState(), {
					paused: state.paused,
					reason: "counters reset",
					waiting: null,
				});
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
			const waitingNow = state.waiting !== null && state.waiting.anchor === snapshot.anchor;
			const mode = isDisabled(ctx)
				? "DISABLED (kill-switch present)"
				: state.paused
					? "PAUSED"
					: waitingNow
						? "waiting (the agent asked for you; your next message resumes)"
						: state.reason.startsWith("stopped:")
							? "stopped (next human message starts a new budget)"
							: "active";
			ctx.ui?.notify?.(
				[
					`todo-loop ${mode}`,
					`rounds ${state.rounds}${config.maxRounds === null ? " (no cap)" : `/${config.maxRounds}`} · stalled ${state.stalled}`,
					// Only while it still belongs to this message: the human's next one
					// resumes the loop even though the reason is still in memory.
					...(waitingNow ? [`waiting: ${(state.waiting as { reason: string }).reason}`] : []),
					`open ${snapshot.open.length}/${snapshot.tasks.length} tracked`,
					`anchor ${snapshot.anchor || "(none)"}`,
					`last: ${waitingNow ? `waiting for you: ${(state.waiting as { reason: string }).reason}` : state.reason}`,
					`config ${configPath}`,
				].join("\n"),
				"info",
			);
		},
	});
}

