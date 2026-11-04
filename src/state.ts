/**
 * rpiv-todo state, read-only.
 *
 * The extension never writes todo state and never imports rpiv-todo. It reads
 * the two shapes a todo tool persists on the session branch:
 *
 *   1. `custom` entries with `customType: "rpiv-todo-state"` — the authoritative
 *      snapshot written by every mutation (state/replay.ts upstream).
 *   2. a `todo` toolResult carrying `details.tasks` — the fallback, used when the
 *      custom entry shape is absent or unrecognised.
 *
 * Both are extension-authored session data, which pi does not send to the LLM
 * (that is exactly the gap this extension closes).
 *
 * Everything here fails soft: a malformed branch degrades to "no list" rather
 * than throwing inside a turn boundary.
 */

export interface Task {
	id: number;
	subject: string;
	status: string;
	activeForm?: string;
	/** Internal: the id was derived from the array position, not supplied by the payload. */
	syntheticId?: true;
}

export interface Snapshot {
	/** Non-deleted tasks, in list order. */
	tasks: Task[];
	/** Tasks that are not `completed` or `deleted`. */
	open: Task[];
	/** `id:status` joined — cheap change detector. */
	signature: string;
	/** Id of the newest human message on the branch; never empty once seen. */
	anchor: string;
}

export const EMPTY_SNAPSHOT: Snapshot = { tasks: [], open: [], signature: "", anchor: "" };

const TODO_CUSTOM_TYPE = "rpiv-todo-state";
const TODO_TOOL_NAME = "todo";
const CLOSED_STATUSES = new Set(["completed", "deleted"]);

/**
 * Normalise one task. A missing or unusable id falls back to the array index so
 * a single bad field cannot silently shrink the list toward "clear".
 */
export function normalizeTask(value: unknown, index = 0): Task | undefined {
	// An array is a wrapper the reader does not understand, not a task: keeping it
	// would produce a phantom "open" task that never lets the loop report the list
	// clear.
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;

	// Only a string can need conversion — `Number(...)` on anything else is the only
	// place this file could throw.
	const numeric = typeof record.id === "number" ? record.id : typeof record.id === "string" ? Number(record.id) : Number.NaN;
	const usableId = typeof record.id === "number" || (typeof record.id === "string" && record.id.trim() !== "");
	const id = usableId && Number.isInteger(numeric) && numeric >= 0 ? numeric : index;

	const subject =
		typeof record.subject === "string"
			? record.subject
			: typeof record.content === "string"
				? record.content
				: "";

	// Fail-open (see isOpen) makes status matching load-bearing, so normalise it:
	// "Completed " from another tool must not read as open forever.
	const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "pending";

	// A record with neither a label nor a status is not a task; keeping it would make
	// the list permanently "open" on a phantom entry.
	if (subject === "" && typeof record.status !== "string") return undefined;

	const task: Task = {
		id,
		subject,
		status,
		...(typeof record.activeForm === "string" ? { activeForm: record.activeForm } : {}),
	};
	if (!(usableId && Number.isInteger(numeric) && numeric >= 0)) task.syntheticId = true;
	return task;
}

/**
 * Open means "not finished". An allow-list would fail closed: a status the
 * todo tool adds or renames later (`blocked`, a localised value) would vanish
 * from the injected block and the loop would report the list clear with work
 * still outstanding.
 */
export function isOpen(task: Task): boolean {
	return !CLOSED_STATUSES.has(task.status);
}

/**
 * Give every task a distinct id without ever renumbering one the payload supplied.
 *
 * A real id is what the model must use to update the task, so it is reserved first;
 * only synthetic ids (derived from the array position) and duplicates of a real id are
 * moved to a free number above the reserved set.
 */
function withUniqueIds(tasks: readonly Task[]): Task[] {
	const reserved = new Set<number>();
	for (const task of tasks) if (task.syntheticId !== true) reserved.add(task.id);

	const used = new Set<number>();
	let next = 1;
	const freeId = (): number => {
		while (reserved.has(next) || used.has(next)) next += 1;
		used.add(next);
		return next;
	};

	return tasks.map((task) => {
		if (task.syntheticId !== true && !used.has(task.id)) {
			used.add(task.id);
			return task;
		}
		const { syntheticId: _synthetic, ...rest } = task;
		return { ...rest, id: freeId() };
	});
}

export function snapshotFrom(tasks: readonly Task[], anchor = ""): Snapshot {
	const kept = withUniqueIds(tasks.filter((task) => task.status !== "deleted"));
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

/** A human message anchor: never empty, so the "no anchor yet" sentinel stays unambiguous. */
function anchorFromEntry(entry: Record<string, unknown>, index: number): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as Record<string, unknown> | undefined;
	if (message?.role !== "user") return undefined;
	// If pi ever materialises a custom_message as a plain user message, our own
	// marker must not become the anchor: it changes every round and would reset
	// the budget on every continuation.
	if (typeof message.customType === "string") return undefined;
	const id = entry.id;
	return typeof id === "string" && id !== "" ? id : `#${index}`;
}

/**
 * Read the latest snapshot from a branch, newest entry first.
 *
 * Both shapes are located by their position, and the newer one wins: preference
 * by type alone would serve a stale list forever if the todo tool stopped
 * writing custom entries partway through a session.
 */
export function readSnapshot(entries: readonly unknown[]): Snapshot {
	let custom: Task[] | undefined;
	let customIndex = -1;
	let fallback: Task[] | undefined;
	let fallbackIndex = -1;
	let anchor = "";

	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;

		if (anchor === "") {
			const found = anchorFromEntry(record, index);
			if (found !== undefined) anchor = found;
		}

		if (record.type === "custom" && custom === undefined) {
			const found = tasksFromEntry(record);
			if (found !== undefined) {
				custom = found;
				customIndex = index;
			}
		} else if (fallback === undefined) {
			const found = tasksFromEntry(record);
			if (found !== undefined) {
				fallback = found;
				fallbackIndex = index;
			}
		}

		if ((custom !== undefined || fallback !== undefined) && anchor !== "") break;
	}

	const newest =
		custom !== undefined && (fallback === undefined || customIndex > fallbackIndex)
			? custom
			: fallback !== undefined
				? fallback
				: undefined;
	return snapshotFrom(newest ?? [], anchor);
}
