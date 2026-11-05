/**
 * A real captured branch, not a hand-built one.
 *
 * `test/fixtures/branch.jsonl` is a branch copied from an actual pi 1.5.0 session
 * driving @juicesharp/rpiv-todo 2.15.0: a real user entry with a real id, a real
 * `rpiv-todo-state` custom entry, a real `todo` toolResult with `details.tasks`, and
 * two real `custom_message` markers. Every other test in this repository invents
 * these shapes; if pi or rpiv-todo changes one, only this file notices.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKER_TYPE, default as todoLoop } from "../src/index.ts";
import { readSnapshot } from "../src/state.ts";

const branch = readFileSync(new URL("./fixtures/branch.jsonl", import.meta.url), "utf8")
	.split("\n")
	.filter((line) => line.trim() !== "")
	.map((line) => JSON.parse(line) as Record<string, unknown>);

test("the captured branch parses into the expected snapshot", () => {
	const snapshot = readSnapshot(branch);
	const userEntry = branch.find((entry) => (entry.message as any)?.role === "user");
	assert.equal(snapshot.anchor, userEntry?.id, "the anchor is the real user entry id");
	assert.equal(snapshot.tasks.length, 3, "the newer toolResult wins: it carries a third task");
	assert.deepEqual(
		snapshot.tasks.map((task) => [task.id, task.subject, task.status]),
		[
			[1, "write the report", "pending"],
			[2, "run the tests", "pending"],
			[3, "only in the toolResult", "pending"],
		],
	);
	assert.equal(snapshot.open.length, 3);
});

test("the captured markers are the shape the context hook looks for", () => {
	const markers = branch.filter((entry) => entry.customType === MARKER_TYPE);
	assert.ok(markers.length >= 2, `expected the captured markers, found ${markers.length}`);
	for (const marker of markers) {
		assert.equal(marker.type, "custom_message", "persisted markers are custom_message entries");
		assert.equal(marker.display, false);
	}
});

test("the fixture ends with a marker, the shape a continuation request really has", () => {
	const last = branch.at(-1);
	assert.equal(last?.type, "custom_message", "a real chain ends on the marker it just appended");
	assert.equal(last?.display, false);
});

test("the context hook keeps real markers and adds nothing to the request", async () => {
	const messages = branch
		.filter((entry) => entry.type === "message" || entry.type === "custom_message")
		// pi projects a custom_message to `role: "custom"`, not `role: "user"`.
		.map(
			(entry) =>
				entry.message ?? { role: "custom", customType: entry.customType, content: entry.content, display: false },
		);

	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	todoLoop(
		{
			on: (name: string, handler: any) => (handlers[name] = handler),
			registerCommand: () => {},
			registerTool: () => {},
		},
		{
			configPath: "/nonexistent/todo-loop.json",
			killSwitchGlobal: "/nonexistent/off-global",
			killSwitchLocal: ".pi/off-local",
		},
	);
	const result = await handlers.context({ messages }, { cwd: "/tmp", sessionManager: { getBranch: () => branch } });

	// A real continuation request ends on the marker, which is the nudge: it must
	// survive, and no state block may be added to the request.
	assert.equal(result, undefined, "the prompt is left exactly as built");
	assert.equal(
		messages.filter((message: any) => message.customType === MARKER_TYPE).length >= 1,
		true,
		"markers are the alternation glue",
	);
});
