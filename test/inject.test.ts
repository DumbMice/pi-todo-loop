import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, mergeConfig, DEFAULTS } from "../src/config.ts";
import { renderInjection, INJECT_TAG } from "../src/inject.ts";
import { snapshotFrom } from "../src/state.ts";

test("missing or malformed config falls back to defaults", () => {
	assert.deepEqual(loadConfig("/nonexistent/todo-loop.json"), DEFAULTS);
	assert.deepEqual(mergeConfig(undefined), DEFAULTS);
	assert.deepEqual(mergeConfig("nope"), DEFAULTS);
	assert.deepEqual(mergeConfig({ maxRounds: "twelve" }), DEFAULTS);
});

test("valid fields override, invalid ones are ignored", () => {
	const merged = mergeConfig({ maxRounds: 3, maxStrikes: 0, injectState: false, maxInjectedTasks: 2.9 });
	assert.equal(merged.maxRounds, 3);
	assert.equal(merged.maxStrikes, DEFAULTS.maxStrikes, "0 is not a meaningful strike budget");
	assert.equal(merged.injectState, false);
	assert.equal(merged.maxInjectedTasks, 2, "floors to an integer");
});

test("injection lists open tasks with their status", () => {
	const snapshot = snapshotFrom([
		{ id: 1, subject: "done thing", status: "completed" },
		{ id: 2, subject: "write the report", status: "pending" },
		{ id: 3, subject: "run the tests", status: "in_progress", activeForm: "running the tests" },
	]);
	const text = renderInjection(snapshot, DEFAULTS);
	assert.match(text, new RegExp(`<${INJECT_TAG}>`));
	assert.match(text, /2 tracked task\(s\) are still open/);
	assert.match(text, /2\. \[pending\] write the report/);
	assert.match(text, /3\. \[in_progress\] running the tests/, "activeForm replaces the subject");
	assert.doesNotMatch(text, /done thing/, "completed tasks are not injected");
});

test("injection is bounded and reports the overflow", () => {
	const snapshot = snapshotFrom(
		Array.from({ length: 9 }, (_, index) => ({
			id: index + 1,
			subject: `task ${index + 1}`,
			status: "pending",
		})),
	);
	const text = renderInjection(snapshot, { ...DEFAULTS, maxInjectedTasks: 3 });
	assert.match(text, /\.\.\. and 6 more/);
	assert.equal(text.split("\n").filter((line) => line.startsWith("  ")).length, 4, "3 rows + overflow");
});

test("injection uses activeForm only for in_progress", () => {
	const snapshot = snapshotFrom([{ id: 1, subject: "plain", status: "pending", activeForm: "running" }]);
	assert.match(renderInjection(snapshot, DEFAULTS), /\[pending\] plain/);
});

test("injection tolerates an empty subject", () => {
	const snapshot = snapshotFrom([{ id: 1, subject: "", status: "pending" }]);
	assert.match(renderInjection(snapshot, DEFAULTS), /\(untitled\)/);
});
