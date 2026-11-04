/**
 * The pi-facing half: the two hooks and the command, driven through a stub
 * `pi` object. No model, no network, no real session.
 *
 * These cases exist because the request shapes (marker retention, tail
 * replacement) cannot be checked by the pure-logic tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MARKER_TYPE } from "../src/index.ts";
import { INJECT_TAG } from "../src/inject.ts";
import { branchWith, harness, marker, run, task } from "./helpers/harness.ts";

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

test("history markers are left alone when nothing is injected", async () => {
	const h = harness(branchWith([task(1, "completed")]));
	assert.equal(
		await run(h, "context", { messages: [{ role: "user", content: "go" }, marker(), { role: "assistant", content: "a" }] }),
		undefined,
		"markers are the alternation glue; removing them would expose assistant runs",
	);
});

test("history markers are left alone when injection is disabled", async () => {
	const h = harness(branchWith([task(1, "pending")]), { injectState: false });
	assert.equal(
		await run(h, "context", { messages: [{ role: "user", content: "go" }, marker(), { role: "assistant", content: "a" }] }),
		undefined,
	);
});

test("a tail marker is replaced by the block, never followed by it", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "context", {
		messages: [{ role: "user", content: "go" }, { role: "assistant", content: "a" }, marker()],
	});
	const roles = result.messages.map((message: any) => (message.customType ? "marker" : message.role));
	assert.deepEqual(roles, ["user", "assistant", "user"], "one user-role tail, not marker + block");
	assert.match(result.messages.at(-1).content[0].text, /1 tracked task\(s\) are still open/);
});

test("the block is appended when the tail is an assistant turn", async () => {
	const h = harness(branchWith([task(1, "pending"), task(2, "pending")]));
	const result = await run(h, "context", {
		messages: [{ role: "user", content: "go" }, marker(), { role: "assistant", content: "a" }],
	});
	// The marker between a human message and an assistant turn is redundant: the
	// human message already provides the alternation, so the marker is dropped.
	const roles = result.messages.map((message: any) => (message.customType ? "marker" : message.role));
	assert.deepEqual(roles, ["user", "assistant", "user"]);
});

test("the request never ends with two user-role messages", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	// Realistic orders only: a marker is always persisted after an assistant turn.
	for (const messages of [
		[{ role: "user", content: "go" }, { role: "assistant", content: "a" }, marker()],
		[{ role: "user", content: "go" }, marker(), { role: "assistant", content: "b" }],
		[{ role: "user", content: "go" }, marker(), { role: "assistant", content: "b" }, marker()],
	]) {
		const result = await run(h, "context", { messages });
		const tail = result.messages.at(-1);
		const before = result.messages.at(-2);
		assert.equal(tail.customType ?? tail.role, "user");
		assert.notEqual(before?.customType ?? before?.role, "user", JSON.stringify(messages.map((m: any) => m.role)));
	}
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
	assert.equal(await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] }), undefined);
});

test("turn_end requests one turn with a hidden marker when work is open", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	// A settle turn: no tool results, so the run was about to end.
	const result = await run(h, "turn_end", {
		outcome: "completed",
		toolResults: [],
		entries: [{ type: "custom", customType: "someone-else", data: {} }],
	});

	assert.equal(result?.continue, true);
	const appended = result.entries.at(-1);
	assert.equal(appended.type, "custom_message", "pi's boundary needs a non-assistant tail entry");
	assert.notEqual(appended.role, "assistant");
	assert.equal(appended.customType, MARKER_TYPE);
	assert.equal(appended.display, false, "the marker must never render");
	assert.equal(result.entries.length, 2, "existing proposals are preserved");
	assert.equal(appended.content, "<todo_loop_continue/>", "the marker carries no counters");
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
	const work = { outcome: "completed", toolResults: [], entries: [] };

	assert.equal((await run(h, "turn_end", work))?.continue, true, "round 1");
	assert.equal(await run(h, "turn_end", work), undefined, "cap reached");

	await h.commands.todoloop.handler("", h.ctx);
	assert.match(h.notices.at(-1) as string, /stopped: round cap 1 reached/);
});

test("pause and resume gate the loop", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const work = { outcome: "completed", toolResults: [], entries: [] };

	await h.commands.todoloop.handler("pause", h.ctx);
	assert.equal(await run(h, "turn_end", work), undefined);

	await h.commands.todoloop.handler("resume", h.ctx);
	assert.equal((await run(h, "turn_end", work))?.continue, true);
});

test("a turn that ran tools spends no round and appends no marker", async () => {
	// `turn_end` fires per assistant response. A response that ended in a tool call
	// already causes pi's next request, so it is not a continuation and must not
	// consume the budget — otherwise a 13-response job exhausts maxRounds 12 before
	// the model ever settles.
	const h = harness(branchWith([task(1, "pending"), task(2, "pending")]), { maxRounds: 12 });
	const toolTurn = { outcome: "completed", toolResults: [{ role: "toolResult" }], entries: [] };

	for (let turn = 0; turn < 13; turn += 1) {
		assert.equal(await run(h, "turn_end", toolTurn), undefined, `tool turn ${turn} must not continue`);
	}

	const settle = await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] });
	assert.equal(settle?.continue, true, "the first settle still gets a continuation");
	assert.equal(settle.entries.length, 1, "exactly one marker, on the settle");

	await h.commands.todoloop.handler("", h.ctx);
	assert.match(h.notices.at(-1) as string, /rounds 1\/12/, "13 tool turns cost nothing");
});

test("a human-role tail receives the block instead of a second user message", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "context", {
		messages: [
			{ role: "assistant", content: "waiting" },
			{ role: "user", content: "keep going" },
		],
	});
	assert.equal(result.messages.length, 2, "no extra message is appended");
	assert.equal(result.messages.at(-1).role, "user");
	const parts = result.messages.at(-1).content;
	assert.equal(parts.length, 2, "the block becomes an extra content part");
	assert.match(parts[1].text, /tracked task\(s\) are still open/);
});

test("tool turns clear a pending strike but never spend a round", async () => {
	// The case this extension exists for: the model runs tools and never updates the
	// list. Without clearing, two settles collect two strikes and it stops with
	// "no progress" while it was working the whole time.
	const h = harness(branchWith([task(1, "pending")]));
	const settle = { outcome: "completed", toolResults: [], entries: [] };
	const toolTurn = { outcome: "completed", toolResults: [{ role: "toolResult" }], entries: [] };

	assert.equal((await run(h, "turn_end", settle))?.continue, true, "settle 1 is free");
	assert.equal((await run(h, "turn_end", settle))?.continue, true, "settle 2 spends strike 1");

	for (let turn = 0; turn < 3; turn += 1) assert.equal(await run(h, "turn_end", toolTurn), undefined);

	await h.commands.todoloop.handler("", h.ctx);
	assert.match(h.notices.at(-1) as string, /rounds 2\/12 · strikes 0\/2/, "the tool turns cleared the strike");

	const next = await run(h, "turn_end", settle);
	assert.equal(next?.continue, true, "so the next settle continues instead of stopping");
});

test("a marker after a human message still yields one user-role tail", async () => {
	// The queued-message order: assistant, human message, marker. Removing the marker
	// must not leave the block standing next to the human's own message.
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "context", {
		messages: [
			{ role: "assistant", content: "a" },
			{ role: "user", content: "actually, do this instead" },
			marker(),
		],
	});
	assert.equal(result.messages.length, 2, "no third message");
	assert.equal(result.messages.at(-1).role, "user");
	assert.equal(result.messages.at(-1).content.length, 2, "the block is merged into the human message");
});

test("the status header says stopped once the budget is shut", async () => {
	const h = harness(branchWith([task(1, "pending")]), { maxRounds: 1 });
	const work = { outcome: "completed", toolResults: [], entries: [] };
	await run(h, "turn_end", work);
	await run(h, "turn_end", work);
	await h.commands.todoloop.handler("", h.ctx);
	assert.match(h.notices.at(-1) as string, /todo-loop stopped/);
});

test("a marker between an assistant turn and a human message is dropped", async () => {
	// A marker only separates two assistant turns. Once a human message follows it,
	// the marker is redundant — and leaving it would put two user-role messages in a
	// row, which strict providers reject.
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "context", {
		messages: [{ role: "assistant", content: "a" }, marker(), { role: "user", content: "do this instead" }],
	});
	const roles = result.messages.map((message: any) => (message.customType ? "marker" : message.role));
	assert.deepEqual(roles, ["assistant", "user"], "one user-role tail, block merged into the human message");
});

test("no returned request ever contains two adjacent user-role messages", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const cases: unknown[][] = [
		[{ role: "assistant", content: "a" }, marker()],
		[{ role: "assistant", content: "a" }, marker(), marker()],
		[{ role: "assistant", content: "a" }, marker(), { role: "user", content: "h" }],
		[{ role: "user", content: "u" }, { role: "assistant", content: "a" }, marker(), { role: "user", content: "h" }, { role: "assistant", content: "b" }],
		[{ role: "assistant", content: "a" }, { role: "user", content: "h" }, marker(), { role: "assistant", content: "b" }],
		[{ role: "user", content: "u" }, marker(), { role: "assistant", content: "a" }],
		[{ role: "assistant", content: "a" }, { role: "toolResult", content: "r" }, marker()],
	];
	for (const messages of cases) {
		const result = await run(h, "context", { messages });
		const roles = (result?.messages ?? []).map((message: any) =>
			typeof message.customType === "string" ? "user" : message.role,
		);
		for (let index = 1; index < roles.length; index += 1) {
			assert.notEqual(
				`${roles[index - 1]}/${roles[index]}`,
				"user/user",
				`adjacent user-role messages for ${JSON.stringify(messages.map((m: any) => m.role))}`,
			);
		}
	}
});

test("a queued human message followed by a marker does not survive as an adjacency", async () => {
	// The order a queued message produces: assistant, human, marker, then the next turn.
	// The marker's predecessor is a human message, so it cannot be alternation glue.
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "context", {
		messages: [
			{ role: "assistant", content: "a" },
			{ role: "user", content: "queued" },
			marker(),
			{ role: "assistant", content: "b" },
		],
	});
	const roles = result.messages.map((message: any) => (message.customType ? "marker" : message.role));
	assert.deepEqual(roles, ["assistant", "user", "assistant", "user"], "the marker is dropped, the block appended");
});

test("an aborted turn carrying tool results reports the stop and keeps the strike", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] });
	const aborted = await run(h, "turn_end", { outcome: "aborted", toolResults: [{ role: "toolResult" }], entries: [] });
	assert.equal(aborted, undefined);
	await h.commands.todoloop.handler("", h.ctx);
	assert.match(h.notices.at(-1) as string, /last: stopped: turn outcome was aborted/);
	assert.match(h.notices.at(-1) as string, /mode|todo-loop/);
});
