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

/**
 * One line of model-authored text, rendered inside a tag at the end of a request.
 *
 * A task subject is written by the model, possibly from a fetched page or a repo
 * file, so it must not be able to: close the tag (`</`), start a new line that reads
 * like one of our own directives, or push the block to an unbounded size.
 */
export function sanitizeLabel(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replaceAll("</", "<\\/")
		.trim()
		.slice(0, 120);
}

export function renderInjection(snapshot: Snapshot, config: LoopConfig): string {
	const shown = snapshot.open.slice(0, config.maxInjectedTasks);
	const rows = shown.map(
		(task) => `  ${task.id}. [${task.status}] ${sanitizeLabel(label(task.status, task.subject, task.activeForm))}`,
	);
	const hidden = snapshot.open.length - shown.length;

	return [
		`<${INJECT_TAG}>`,
		`${snapshot.open.length} tracked task(s) are still open on this branch:`,
		...rows,
		...(hidden > 0 ? [`  ... and ${hidden} more`] : []),
		"The human's latest message outranks everything above: if it says to stop, to wait,",
		"or limits what to do, do that instead and say so in one line. Otherwise carry on",
		"with the open tasks, and move a task to in_progress when you start it and to",
		"completed only once it is actually verified — if a task cannot be verified now,",
		"leave it open and say what is blocking it.",
		`</${INJECT_TAG}>`,
	].join("\n");
}
