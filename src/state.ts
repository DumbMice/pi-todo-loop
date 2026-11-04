/**
 * rpiv-todo state, read-only.
 *
 * The extension never writes todo state and never imports rpiv-todo. It reads
 * the two shapes rpiv-todo persists on the session branch:
 *
 *   1. `custom` entries with `customType: "rpiv-todo-state"` — the authoritative
 *      snapshot written by every mutation (state/replay.ts upstream).
 *   2. a `todo` toolResult carrying `details.tasks` — the fallback, used when the
 *      custom entry shape is absent or unrecognised.
 *
 * Both are extension-authored session data, which pi does not send to the LLM
 * (that is exactly the gap this extension closes).
 */

export interface Task {
	id: number;
	subject: string;
	status: string;
	activeForm?: string;
}

export interface Snapshot {
	/** Non-deleted tasks, in list order. */
	tasks: Task[];
	/** Tasks in `pending` or `in_progress`. */
	open: Task[];
	/** `id:status` joined — cheap change detector. */
	signature: string;
	/** Id of the newest human message on the branch. */
	anchor: string;
}

export const EMPTY_SNAPSHOT: Snapshot = { tasks: [], open: [], signature: "", anchor: "" };

const TODO_CUSTOM_TYPE = "rpiv-todo-state";
const TODO_TOOL_NAME = "todo";

export function normalizeTask(value: unknown): Task | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "number" ? record.id : Number(record.id);
	if (!Number.isFinite(id)) return undefined;
	const subject =
		typeof record.subject === "string"
			? record.subject
			: typeof record.content === "string"
				? record.content
				: "";
	return {
		id,
		subject,
		status: typeof record.status === "string" ? record.status : "pending",
		...(typeof record.activeForm === "string" ? { activeForm: record.activeForm } : {}),
	};
}

export function isOpen(task: Task): boolean {
	return task.status === "pending" || task.status === "in_progress";
}

export function snapshotFrom(tasks: readonly Task[], anchor = ""): Snapshot {
	const kept = tasks.filter((task) => task.status !== "deleted");
	return {
		tasks: [...kept],
		open: kept.filter(isOpen),
		signature: kept.map((task) => `${task.id}:${task.status}`).join(","),
		anchor,
	};
}

function tasksFromEntry(entry: Record<string, unknown>): Task[] | undefined {
	if (entry.type === "custom" && entry.customType === TODO_CUSTOM_TYPE) {
		const data = entry.data as Record<string, unknown> | undefined;
		if (data && Array.isArray(data.tasks)) {
			return data.tasks.map(normalizeTask).filter((task): task is Task => task !== undefined);
		}
	}
	if (entry.type === "message") {
		const message = entry.message as Record<string, unknown> | undefined;
		if (message?.role === "toolResult" && message.toolName === TODO_TOOL_NAME) {
			const details = message.details as Record<string, unknown> | undefined;
			if (details && Array.isArray(details.tasks)) {
				return details.tasks.map(normalizeTask).filter((task): task is Task => task !== undefined);
			}
		}
	}
	return undefined;
}

function anchorFromEntry(entry: Record<string, unknown>): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as Record<string, unknown> | undefined;
	if (message?.role !== "user") return undefined;
	return String(entry.id ?? "");
}

/**
 * Read the latest snapshot from a branch, newest entry first.
 *
 * Walks backwards once, collecting the newest todo state and the newest human
 * message id. Missing or malformed entries degrade to an empty snapshot rather
 * than throwing inside a turn boundary.
 */
export function readSnapshot(entries: readonly unknown[]): Snapshot {
	let tasks: Task[] | undefined;
	let fallback: Task[] | undefined;
	let anchor = "";

	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;

		if (anchor === "") {
			const found = anchorFromEntry(record);
			if (found !== undefined) anchor = found;
		}

		if (tasks === undefined) {
			const isCustom = record.type === "custom";
			if (isCustom) {
				const found = tasksFromEntry(record);
				if (found !== undefined) tasks = found;
			} else if (fallback === undefined) {
				const found = tasksFromEntry(record);
				if (found !== undefined) fallback = found;
			}
		}

		if (tasks !== undefined && anchor !== "") break;
	}

	return snapshotFrom(tasks ?? fallback ?? [], anchor);
}
