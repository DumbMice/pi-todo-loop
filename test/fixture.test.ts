/**
 * A real captured branch, not a hand-built one.
 *
 * `test/fixtures/branch.jsonl` is six lines copied from an actual pi 1.5.0 session
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
	assert.equal(snapshot.tasks.length, 2);
	assert.deepEqual(
		snapshot.tasks.map((task) => [task.id, task.subject, task.status]),
		[
			[1, "write the report", "pending"],
			[2, "run the tests", "pending"],
		],
	);
	assert.equal(snapshot.open.length, 2);
});

test("the captured markers are the shape the context hook looks for", () => {
	const markers = branch.filter((entry) => entry.customType === MARKER_TYPE);
	assert.equal(markers.length, 2);
	for (const marker of markers) {
		assert.equal(marker.type, "custom_message", "persisted markers are custom_message entries");
		assert.equal(marker.display, false);
	}
});

test("the context hook keeps real markers and appends one block", async () => {
	const messages = branch
		.filter((entry) => entry.type === "message" || entry.type === "custom_message")
		.map((entry) => entry.message ?? { role: "user", customType: entry.customType, content: entry.content });

	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	todoLoop(
		{ on: (name: string, handler: any) => (handlers[name] = handler), registerCommand: () => {} },
		{
			configPath: "/nonexistent/todo-loop.json",
			killSwitchGlobal: "/nonexistent/off-global",
			killSwitchLocal: ".pi/off-local",
		},
	);
	const result = await handlers.context({ messages }, { cwd: "/tmp", sessionManager: { getBranch: () => branch } });

	const roles = result.messages.map((message: any) => message.customType ?? message.role);
	assert.equal(roles.at(-1), "user", "the request ends on the injected block");
	assert.equal(roles.filter((role: string) => role === "user").length, 2, "the human message and the block");
	assert.ok(
		roles.filter((role: string) => role === MARKER_TYPE).length >= 1,
		"history markers survive: they keep the conversation alternating",
	);
});
