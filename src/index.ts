/**
 * pi-todo-loop — continuation driven by an rpiv-todo list.
 *
 * Pairs with `@juicesharp/rpiv-todo`; does not import or patch it. Three hooks:
 *
 *   context    strip the hidden continuation marker from the request, then
 *              append the live open-task list at the tail (never persisted)
 *   turn_end   request another turn while tasks are open, bounded by
 *              maxRounds / maxStrikes (see loop.ts)
 *   /todoloop  status | pause | resume | reset
 *
 * Architecture notes worth keeping in mind when changing this file:
 *
 *   - A `turn_end` continuation must leave the final message role != assistant,
 *     so one entry is mandatory (`_buildBoundaryContext().canContinue` in pi
 *     1.5.0). We append a `custom_message` with `display: false`.
 *   - That marker must be stripped from the provider request, and stripping it
 *     would leave an assistant tail — which is why the state injection is
 *     appended whenever the marker is stripped. Do not remove one without the
 *     other.
 *   - The marker customType is deliberately stable: sessions created by earlier
 *     builds keep filtering correctly.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { INJECT_TAG, renderInjection } from "./inject.ts";
import { decide, initialState, type LoopState } from "./loop.ts";
import { readSnapshot } from "./state.ts";

/** Stable across versions: earlier sessions' markers must keep being stripped. */
export const MARKER_TYPE = "todo-loop:continue";

export const CONFIG_PATH = join(homedir(), ".pi/agent/todo-loop.json");
const KILL_SWITCH_GLOBAL = join(homedir(), ".pi/agent/todo-loop-off");

function isDisabled(ctx: ExtensionContext): boolean {
	if (existsSync(KILL_SWITCH_GLOBAL)) return true;
	try {
		return existsSync(join(ctx.cwd, ".pi/todo-loop-off"));
	} catch {
		return false;
	}
}

function branchEntries(ctx: ExtensionContext): readonly unknown[] {
	try {
		return (ctx.sessionManager.getBranch() as readonly unknown[]) ?? [];
	} catch {
		return [];
	}
}

export default function todoLoop(pi: ExtensionAPI): void {
	const state: LoopState & { paused: boolean; reason: string } = {
		...initialState(),
		paused: false,
		reason: "idle",
	};

	pi.on("context", async (event, ctx) => {
		if (isDisabled(ctx)) return undefined;
		const original = event.messages as unknown[];
		const withoutMarker = original.filter((message) => {
			const record = message as Record<string, unknown>;
			return record.customType !== MARKER_TYPE;
		});
		const stripped = withoutMarker.length !== original.length;

		const config = loadConfig(CONFIG_PATH);
		const snapshot = readSnapshot(branchEntries(ctx));

		if (!config.injectState || snapshot.open.length === 0) {
			// Keep the marker: it is what keeps the request off an assistant tail.
			return undefined;
		}

		return {
			messages: [
				...(stripped ? withoutMarker : original),
				{ role: "user", content: [{ type: "text", text: renderInjection(snapshot, config) }] },
			],
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		if (isDisabled(ctx) || state.paused) return undefined;

		const config = loadConfig(CONFIG_PATH);
		const snapshot = readSnapshot(branchEntries(ctx));
		const toolResultCount = Array.isArray(event.toolResults) ? event.toolResults.length : 0;

		const decision = decide({
			outcome: String(event.outcome),
			toolResultCount,
			signature: snapshot.signature,
			openCount: snapshot.open.length,
			taskCount: snapshot.tasks.length,
			anchor: snapshot.anchor,
			state,
			config,
		});

		state.rounds = decision.next.rounds;
		state.strikes = decision.next.strikes;
		state.lastSignature = decision.next.lastSignature;
		state.anchor = decision.next.anchor;
		state.reason = decision.reason;

		if (!decision.continue) return undefined;

		return {
			continue: true,
			entries: [
				...(event.entries as unknown[]),
				{
					type: "custom_message",
					customType: MARKER_TYPE,
					content: `<todo_loop n="${state.rounds}" open="${snapshot.open.length}"/>`,
					display: false,
				},
			],
		};
	});

	pi.registerCommand("todoloop", {
		description: "Show or control the todo-driven continuation loop",
		handler: async (args, ctx) => {
			const command = (args ?? "").trim().toLowerCase();
			const config = loadConfig(CONFIG_PATH);

			if (command === "pause") {
				state.paused = true;
				state.reason = "paused by user";
				ctx.ui.notify("todo-loop: paused in this session", "info");
				return;
			}
			if (command === "resume") {
				state.paused = false;
				state.reason = "resumed by user";
				ctx.ui.notify("todo-loop: resumed", "info");
				return;
			}
			if (command === "reset") {
				Object.assign(state, initialState(), { paused: state.paused, reason: "counters reset" });
				ctx.ui.notify("todo-loop: counters reset", "info");
				return;
			}

			const snapshot = readSnapshot(branchEntries(ctx));
			const mode = isDisabled(ctx)
				? "DISABLED (kill-switch present)"
				: state.paused
					? "PAUSED"
					: "active";
			ctx.ui.notify(
				[
					`todo-loop ${mode}`,
					`rounds ${state.rounds}/${config.maxRounds} · strikes ${state.strikes}/${config.maxStrikes}`,
					`open ${snapshot.open.length}/${snapshot.tasks.length} tracked · inject ${config.injectState ? "on" : "off"}`,
					`last: ${state.reason}`,
					`config ${CONFIG_PATH}`,
				].join("\n"),
				"info",
			);
		},
	});
}

export { INJECT_TAG };
