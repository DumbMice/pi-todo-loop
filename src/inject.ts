/**
 * The state injection.
 *
 * Appended at the tail of every request by the `context` hook and never
 * persisted. Two properties matter:
 *
 *   - It is the *whole* open list (bounded), not a hint to call `list`. After
 *     compaction the model has no other way to learn the list still exists.
 *   - It is a user-role block appended at the tail, replacing a trailing
 *     continuation marker so the request never ends on two user-role messages.
 */

import type { LoopConfig } from "./loop.ts";
import type { Snapshot } from "./state.ts";

export const INJECT_TAG = "todo_loop_state";

function label(status: string, subject: string, activeForm?: string): string {
	if (status === "in_progress" && activeForm) return activeForm;
	return subject || "(untitled)";
}

export function renderInjection(snapshot: Snapshot, config: LoopConfig): string {
	const shown = snapshot.open.slice(0, config.maxInjectedTasks);
	const rows = shown.map(
		(task) => `  ${task.id}. [${task.status}] ${label(task.status, task.subject, task.activeForm)}`,
	);
	const hidden = snapshot.open.length - shown.length;

	return [
		`<${INJECT_TAG}>`,
		`${snapshot.open.length} tracked task(s) are still open on this branch:`,
		...rows,
		...(hidden > 0 ? [`  ... and ${hidden} more`] : []),
		"The list is authoritative. Keep working it; do not ask whether to continue.",
		"Call the todo tool to move a task to in_progress when you start it, and to",
		"completed only once it is actually verified.",
		`</${INJECT_TAG}>`,
	].join("\n");
}
