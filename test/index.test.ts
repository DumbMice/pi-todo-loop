/**
 * The pi-facing half: the two hooks and the command, driven through a stub
 * `pi` object. No model, no network, no real session.
 *
 * These cases exist because the tail invariant (marker stripped ⇒ block
 * appended, marker kept otherwise) cannot be checked by the pure-logic tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import todoLoop, { MARKER_TYPE } from "../src/index.ts";
import { INJECT_TAG } from "../src/inject.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

interface Harness {
	handlers: Record<string, Handler[]>;
	commands: Record<string, { handler: Handler }>;
	notices: string[];
	ctx: any;
	pi: any;
	options: { configPath: string; killSwitchGlobal: string; killSwitchLocal: string };
}

const task = (id: number, status: string, subject = `task ${id}`) => ({ id, status, subject });

function branchWith(tasks: unknown[]): unknown[] {
	return [
		{ type: "message", id: "user-1", message: { role: "user", content: "go" } },
		{
			type: "custom",
			customType: "rpiv-todo-state",
			id: "todo-1",
			data: { tasks },
		},
	];
}

function harness(branch: unknown[], config?: Record<string, unknown>): Harness {
	const dir = mkdtempSync(join(tmpdir(), "todo-loop-test-"));
	const configPath = join(dir, "todo-loop.json");
	if (config !== undefined) writeFileSync(configPath, JSON.stringify(config));

	const notices: string[] = [];
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: Handler }> = {};

	const pi = {
		on(name: string, handler: Handler) {
			(handlers[name] ??= []).push(handler);
		},
		registerCommand(name: string, definition: { handler: Handler }) {
			commands[name] = definition;
		},
	};

	const ctx = {
		cwd: dir,
		sessionManager: { getBranch: () => branch },
		ui: { notify: (message: string) => notices.push(message) },
	};

	const options = {
		configPath,
		killSwitchGlobal: join(dir, "off-global"),
		killSwitchLocal: ".pi/off-local",
	};

	todoLoop(pi, options);
	return { handlers, commands, notices, ctx, pi, options };
}

async function run(harness: Harness, event: string, payload: any): Promise<any> {
	const handlers = harness.handlers[event] ?? [];
	let result: any;
	for (const handler of handlers) result = await handler(payload, harness.ctx);
	return result;
}

test("context strips the marker and appends the state block when tasks are open", async () => {
	const h = harness(branchWith([task(1, "pending"), task(2, "in_progress")]));
	const result = await run(h, "context", {
		messages: [
			{ role: "user", content: "go" },
			{ role: "assistant", content: "partial" },
			{ role: "user", customType: MARKER_TYPE, content: "<todo_loop n=\"1\" open=\"2\"/>" },
		],
	});

	assert.ok(result?.messages, "the hook must return a rewritten list");
	const kinds = result.messages.map((message: any) => message.customType ?? message.role);
	assert.deepEqual(kinds, ["user", "assistant", "user"], "the marker is gone, one block added");
	const last = result.messages.at(-1);
	const text = last.content[0].text as string;
	assert.match(text, new RegExp(`<${INJECT_TAG}>`));
	assert.match(text, /2 tracked task\(s\) are still open/);
});

test("context strips earlier markers when the list is clear, and appends nothing", async () => {
	const h = harness(branchWith([task(1, "completed")]));
	const result = await run(h, "context", {
		messages: [
			{ role: "user", content: "go" },
			{ role: "user", customType: MARKER_TYPE, content: "<todo_loop n=\"1\" open=\"2\"/>" },
			{ role: "assistant", content: "done" },
			{ role: "user", customType: MARKER_TYPE, content: "<todo_loop n=\"2\" open=\"1\"/>" },
			{ role: "assistant", content: "all clear" },
		],
	});

	assert.ok(result?.messages, "persisted markers must be stripped even when nothing is injected");
	assert.deepEqual(
		result.messages.map((message: any) => message.role),
		["user", "assistant", "assistant"],
		"every marker is gone, including the last one",
	);
});

test("context strips markers and appends no block when injection is disabled", async () => {
	const h = harness(branchWith([task(1, "pending")]), { injectState: false });
	const result = await run(h, "context", {
		messages: [{ role: "user", customType: MARKER_TYPE, content: "marker" }],
	});
	assert.deepEqual(result?.messages, [], "the marker is still removed");
});

test("context leaves a malformed payload alone instead of rewriting it", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	for (const payload of [{}, { messages: null }, { messages: "nope" }]) {
		assert.equal(await run(h, "context", payload), undefined);
	}
});

test("the global kill switch disables both hooks", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	writeFileSync(h.options.killSwitchGlobal, "");

	assert.equal(await run(h, "context", { messages: [] }), undefined);
	assert.equal(
		await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] }),
		undefined,
		"no continuation while disabled",
	);
});

test("the project-local kill switch disables both hooks", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	mkdirSync(join(h.ctx.cwd, ".pi"), { recursive: true });
	writeFileSync(join(h.ctx.cwd, ".pi", "off-local"), "");

	assert.equal(await run(h, "context", { messages: [] }), undefined);
	assert.equal(
		await run(h, "turn_end", { outcome: "completed", toolResults: [{ role: "toolResult" }], entries: [] }),
		undefined,
	);
});

test("turn_end requests one turn with a hidden marker when work is open", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "turn_end", {
		outcome: "completed",
		toolResults: [{ role: "toolResult" }],
		entries: [{ type: "custom", customType: "someone-else", data: {} }],
	});

	assert.equal(result?.continue, true);
	const appended = result.entries.at(-1);
	assert.equal(appended.type, "custom_message", "pi's boundary needs a non-assistant tail entry");
	assert.notEqual(appended.role, "assistant");
	assert.equal(appended.customType, MARKER_TYPE);
	assert.equal(appended.display, false, "the marker must never render");
	assert.equal(result.entries.length, 2, "existing proposals are preserved");
	assert.match(appended.content, /<todo_loop n="1" open="1"\/>/);
});

test("turn_end stops on an errored or aborted turn and does not spend a round", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	for (const outcome of ["error", "aborted"]) {
		const result = await run(h, "turn_end", { outcome, toolResults: [], entries: [] });
		assert.equal(result, undefined, outcome);
	}
	const status = await h.commands.todoloop.handler("", h.ctx);
	assert.equal(status, undefined);
	assert.match(h.notices.at(-1) as string, /rounds 0\/12/);
});

test("turn_end stops when the list is clear, and reports why", async () => {
	const h = harness(branchWith([task(1, "completed")]));
	const result = await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] });
	assert.equal(result, undefined);

	await h.commands.todoloop.handler("", h.ctx);
	assert.match(h.notices.at(-1) as string, /stopped: list is clear/);
});

test("turn_end tolerates a malformed event payload instead of throwing", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "turn_end", { outcome: "completed" });
	assert.equal(result?.continue, true, "missing toolResults/entries degrade, not crash");
	assert.deepEqual(
		result.entries.map((entry: any) => entry.customType),
		[MARKER_TYPE],
	);
});

test("the round cap is sticky for one human message", async () => {
	const h = harness(branchWith([task(1, "pending")]), { maxRounds: 1 });
	const work = { outcome: "completed", toolResults: [{ role: "toolResult" }], entries: [] };

	assert.equal((await run(h, "turn_end", work))?.continue, true, "round 1");
	assert.equal(await run(h, "turn_end", work), undefined, "cap reached");

	await h.commands.todoloop.handler("", h.ctx);
	assert.match(h.notices.at(-1) as string, /stopped: round cap 1 reached/);
});

test("pause and resume gate the loop", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const work = { outcome: "completed", toolResults: [{ role: "toolResult" }], entries: [] };

	await h.commands.todoloop.handler("pause", h.ctx);
	assert.equal(await run(h, "turn_end", work), undefined);

	await h.commands.todoloop.handler("resume", h.ctx);
	assert.equal((await run(h, "turn_end", work))?.continue, true);
});
