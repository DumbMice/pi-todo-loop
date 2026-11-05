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
	// Every Unicode line terminator, not just \n: U+2028/9 and NEL (U+0085) split a
	// line for some readers, which is the channel this function exists to close.
	const flattened = text.replace(/[\r\n\t\u2028\u2029\u0085]+/g, " ");
	// C0/C1 controls, bidi overrides and isolates, zero-width and BOM characters: a
	// NUL can break JSON encoding and a bidi override can visually reverse a line.
	const cleaned = flattened.replace(
		/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
		"",
	);
	// No tag can be opened or closed from task text: `<` is escaped, which also covers
	// `</` and a bare `<todo_loop_state>` that would invert the block's nesting.
	const escaped = cleaned.replaceAll("<", "&lt;").replaceAll("&lt;", "&lt;");
	// Bound the working set before materialising code points (a 1 MB subject would
	// otherwise allocate a 1M-element array per row); 480 UTF-16 units can hold far
	// more than the 120 code points that survive.
	const bounded = escaped.length > 480 ? escaped.slice(0, 480) : escaped;
	// By code point, never UTF-16 units: `slice` can cut a surrogate pair in half and
	// leave a lone surrogate in the request.
	const points = Array.from(bounded).slice(0, 120).join("");
	// An unpaired surrogate already in the payload survives `Array.from`; drop it so the
	// request is always valid UTF-16.
	return points.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").trim();
}

export interface InjectionOptions {
	/**
	 * Add the reconciliation clause. Off for the first nudge of a chain, on afterwards:
	 * handing a model an explicit "fix the list" instruction on its first sighting
	 * invites it to reshape the list instead of doing the work, while after one nudge a
	 * drifted list is the likelier explanation.
	 */
	reconcile?: boolean;
}

const RECONCILE_CLAUSE = [
	"If this list has drifted from the work, reconcile it now: update statuses,",
	"add what is missing, and remove what no longer applies.",
].join("\n");

export function renderInjection(
	snapshot: Snapshot,
	config: LoopConfig,
	options: InjectionOptions = {},
): string {
	const shown = snapshot.open.slice(0, config.maxInjectedTasks);
	const rows = shown.map(
		(task) =>
			`  ${task.id}. [${sanitizeLabel(task.status)}] ${sanitizeLabel(
				label(task.status, task.subject, task.activeForm),
			)}`,
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
		...(options.reconcile ? [RECONCILE_CLAUSE] : []),
		`</${INJECT_TAG}>`,
	].join("\n");
}
