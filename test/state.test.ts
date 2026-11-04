import assert from "node:assert/strict";
import { test } from "node:test";
import { readSnapshot, snapshotFrom, normalizeTask, EMPTY_SNAPSHOT } from "../src/state.ts";

const customEntry = (tasks: unknown[], id = "e-todo") => ({
	type: "custom",
	customType: "rpiv-todo-state",
	id,
	data: { action: "create", tasks, nextId: tasks.length + 1 },
});

const messageEntry = (role: string, extra: Record<string, unknown> = {}, id = `e-${role}`) => ({
	type: "message",
	id,
	message: { role, ...extra },
});

test("reads the newest rpiv-todo custom entry", () => {
	const branch = [
		messageEntry("user"),
		customEntry([{ id: 1, subject: "a", status: "pending" }], "old"),
		customEntry([{ id: 1, subject: "a", status: "completed" }], "new"),
	];
	const snapshot = readSnapshot(branch);
	assert.equal(snapshot.tasks.length, 1);
	assert.equal(snapshot.tasks[0].status, "completed");
	assert.equal(snapshot.open.length, 0);
});

test("falls back to todo toolResult details", () => {
	const branch = [
		messageEntry("user"),
		messageEntry("toolResult", {
			toolName: "todo",
			details: { tasks: [{ id: 7, subject: "from tool", status: "in_progress" }] },
		}),
	];
	const snapshot = readSnapshot(branch);
	assert.deepEqual(
		snapshot.open.map((t) => t.id),
		[7],
	);
});

test("prefers the custom entry over the toolResult fallback", () => {
	const branch = [
		messageEntry("toolResult", {
			toolName: "todo",
			details: { tasks: [{ id: 1, subject: "stale", status: "pending" }] },
		}),
		customEntry([{ id: 2, subject: "fresh", status: "pending" }]),
	];
	const snapshot = readSnapshot(branch);
	assert.deepEqual(
		snapshot.open.map((t) => t.subject),
		["fresh"],
	);
});

test("anchor is the newest human message id, ignoring assistant and toolResult", () => {
	const branch = [
		messageEntry("user", {}, "user-1"),
		messageEntry("assistant", {}, "a-1"),
		messageEntry("toolResult", { toolName: "todo" }, "t-1"),
		messageEntry("user", {}, "user-2"),
		messageEntry("assistant", {}, "a-2"),
	];
	assert.equal(readSnapshot(branch).anchor, "user-2");
});

test("deleted tasks are excluded from tasks, open and signature", () => {
	const snapshot = snapshotFrom([
		{ id: 1, subject: "gone", status: "deleted" },
		{ id: 2, subject: "live", status: "pending" },
	]);
	assert.equal(snapshot.tasks.length, 1);
	assert.equal(snapshot.signature, "2:pending");
});

test("signature changes when a status changes", () => {
	const a = snapshotFrom([{ id: 1, subject: "a", status: "pending" }]);
	const b = snapshotFrom([{ id: 1, subject: "a", status: "in_progress" }]);
	assert.notEqual(a.signature, b.signature);
});

test("activeForm and content fallbacks are normalised", () => {
	const task = normalizeTask({ id: "3", content: "legacy subject", status: "in_progress", activeForm: "running" });
	assert.equal(task?.id, 3);
	assert.equal(task?.subject, "legacy subject");
	assert.equal(task?.activeForm, "running");
});

test("malformed or missing state degrades to the empty snapshot", () => {
	assert.deepEqual(readSnapshot([]), EMPTY_SNAPSHOT);
	assert.deepEqual(readSnapshot([{ type: "custom", customType: "rpiv-todo-state" }]), EMPTY_SNAPSHOT);
	assert.deepEqual(readSnapshot([{ type: "message" }, null, 42]), EMPTY_SNAPSHOT);
	assert.deepEqual(readSnapshot([customEntry([])]), { ...EMPTY_SNAPSHOT, anchor: "" });
});

test("a task without a usable id falls back to its position, not to being dropped", () => {
	const snapshot = readSnapshot([customEntry([{ subject: "no id" }, { id: "x", subject: "bad" }])]);
	assert.deepEqual(
		snapshot.tasks.map((t) => t.id),
		[0, 1],
		"dropping it would shrink the list toward clear",
	);
});

test("an unknown status counts as open, not as done", () => {
	const snapshot = snapshotFrom([
		{ id: 1, subject: "a", status: "blocked" },
		{ id: 2, subject: "b", status: "completed" },
		{ id: 3, subject: "c", status: "deleted" },
	]);
	assert.deepEqual(
		snapshot.open.map((t) => t.id),
		[1],
	);
});

test("the newer of a custom entry and a toolResult wins, in either order", () => {
	const tool = messageEntry("toolResult", {
		toolName: "todo",
		details: { tasks: [{ id: 9, subject: "from tool", status: "pending" }] },
	});
	const custom = customEntry([{ id: 8, subject: "from custom", status: "pending" }]);

	const customNewer = readSnapshot([tool, custom]);
	assert.deepEqual(
		customNewer.open.map((t) => t.subject),
		["from custom"],
	);
	const toolNewer = readSnapshot([custom, tool]);
	assert.deepEqual(
		toolNewer.open.map((t) => t.subject),
		["from tool"],
	);
});
