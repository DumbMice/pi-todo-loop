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
import { branchWith, harness, marker, run, setHuman, task } from "./helpers/harness.ts";

test("context removes a marker next to a human message and adds nothing", async () => {
	const h = harness(branchWith([task(1, "pending"), task(2, "in_progress")]));
	const sent = [{ role: "user", content: "go" }, marker(), { role: "assistant", content: "partial" }];
	const result = await run(h, "context", { messages: sent });
	assert.equal(result.messages.length, 2, "one message removed, none added");
	assert.deepEqual(result.messages.map((message: any) => message.role), ["user", "assistant"]);
	assert.deepEqual(result.messages[0], sent[0], "the human's message is byte-for-byte what they sent");
});
test("a marker next to the human message is dropped even when nothing is injected", async () => {
	const h = harness(branchWith([task(1, "completed")]));
	const result = await run(h, "context", { messages: [{ role: "user", content: "go" }, marker(), { role: "assistant", content: "a" }] });
	// The marker would sit between two user-role messages, which is the adjacency it must
	// never create. With no open tasks there is nothing to inject either.
	assert.deepEqual(result.messages.map((message: any) => message.role), ["user", "assistant"]);
});

test("a marker between two assistant turns is left alone", async () => {
	// This is the marker's whole job: it is what keeps `assistant → assistant` legal.
	const h = harness(branchWith([task(1, "completed")]));
	assert.equal(
		await run(h, "context", { messages: [{ role: "assistant", content: "a" }, marker(), { role: "assistant", content: "b" }] }),
		undefined,
		"removing the glue would expose two assistant turns in a row",
	);
});

test("a request with no markers and no continuation is never rewritten", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	for (const messages of [[{ role: "user", content: "go" }], [{ role: "assistant", content: "a" }], [{ role: "user", content: "go" }, { role: "assistant", content: "a" }]]) {
		assert.equal(await run(h, "context", { messages }), undefined);
	}
});
test("the prompt is never rewritten with task state", async () => {
	// The extension's only agent-facing text is the nudge. No list, no reminder, no
	// clause: whatever the model needs it reads with the todo tool.
	const h = harness(branchWith([task(1, "pending"), task(2, "pending")]));
	for (const messages of [
		[{ role: "user", content: "go" }],
		[{ role: "assistant", content: "a" }, { role: "toolResult", content: "r" }],
		[{ role: "user", content: "go" }, { role: "assistant", content: "a" }, marker()],
	]) {
		const result = await run(h, "context", { messages });
		if (result === undefined) continue;
		assert.ok(result.messages.length <= messages.length, "a request may only shrink");
		assert.ok(
			messages.every((message: any, index: number) => result.messages[index] === message),
			"surviving messages are untouched objects",
		);
	}
});
test("the tail marker is the nudge and is left alone", async () => {
	// Dropping it would leave the continuation request ending on an assistant turn,
	// which is the shape pi refuses to continue from in the first place.
	const h = harness(branchWith([task(1, "pending")]));
	assert.equal(
		await run(h, "context", { messages: [{ role: "user", content: "go" }, { role: "assistant", content: "a" }, marker()] }),
		undefined,
	);
});
test("an ordinary request is not touched at all", async () => {
	const h = harness(branchWith([task(1, "pending"), task(2, "pending")]));
	for (const messages of [
		[{ role: "user", content: "go" }, { role: "assistant", content: "a" }],
		[{ role: "assistant", content: "a" }, { role: "toolResult", content: "r" }],
	]) {
		assert.equal(await run(h, "context", { messages }), undefined);
	}
});
test("the request never ends with two user-role messages", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	// Realistic orders only: a marker is always persisted after an assistant turn.
	for (const messages of [
		[{ role: "user", content: "go" }, { role: "assistant", content: "a" }, marker()],
		[{ role: "user", content: "go" }, marker(), { role: "assistant", content: "b" }],
		[{ role: "user", content: "go" }, marker(), { role: "assistant", content: "b" }, marker()],
		[{ role: "user", content: "go" }, { role: "assistant", content: "a" }, marker(), marker()],
	]) {
		const result = await run(h, "context", { messages });
		const roles = (result?.messages ?? messages).map((message: any) => (message.customType ? "user" : message.role));
		for (let index = 1; index < roles.length; index += 1) {
			assert.notEqual(`${roles[index - 1]}/${roles[index]}`, "user/user", JSON.stringify(messages.map((m: any) => m.role)));
		}
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
	assert.match(appended.content, /Continue with the open todo tasks/, "the body carries the instruction");
	assert.doesNotMatch(appended.content, /\d/, "and no counters");
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

test("pause stops the continuation and the marker cleanup", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const work = { outcome: "completed", toolResults: [], entries: [] };
	const history = [{ role: "user", content: "u" }, marker(), { role: "assistant", content: "a" }];

	await h.commands.todoloop.handler("pause", h.ctx);
	assert.equal(await run(h, "turn_end", work), undefined, "no continuation while paused");
	assert.equal(await run(h, "context", { messages: history }), undefined, "and no history rewrite");

	await h.commands.todoloop.handler("resume", h.ctx);
	assert.equal((await run(h, "turn_end", work))?.continue, true);
	assert.ok(await run(h, "context", { messages: history }));
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

test("the human's own message is left exactly as sent", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	assert.equal(
		await run(h, "context", { messages: [{ role: "assistant", content: "waiting" }, { role: "user", content: "keep going" }] }),
		undefined,
		"a human's prompt is never rewritten",
	);
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

test("a marker after a human message is dropped, not merged", async () => {
	// The queued-message order: assistant, human message, marker. The marker's
	// predecessor is a human message, so it would project to `user → user`.
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "context", {
		messages: [
			{ role: "assistant", content: "a" },
			{ role: "user", content: "actually, do this instead" },
			marker(),
		],
	});
	assert.equal(result.messages.length, 2, "no third message, no merge");
	assert.deepEqual(result.messages.map((message: any) => message.role), ["assistant", "user"]);
	assert.equal(result.messages.at(-1).content, "actually, do this instead", "the human's text is not appended to");
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
	assert.deepEqual(roles, ["assistant", "user", "assistant"], "the marker is dropped and nothing is injected");
});
test("an aborted turn carrying tool results reports the stop and keeps the strike", async () => {
	// Two settles first, so a strike is actually pending: a mutation that clears it
	// before the outcome check must fail here.
	const h = harness(branchWith([task(1, "pending")]));
	const settle = { outcome: "completed", toolResults: [], entries: [] };
	await run(h, "turn_end", settle);
	await run(h, "turn_end", settle);
	const aborted = await run(h, "turn_end", { outcome: "aborted", toolResults: [{ role: "toolResult" }], entries: [] });
	assert.equal(aborted, undefined);
	await h.commands.todoloop.handler("", h.ctx);
	assert.match(h.notices.at(-1) as string, /rounds 2\/12 · strikes 1\/2/);
	assert.match(h.notices.at(-1) as string, /last: stopped: turn outcome was aborted/);
});

test("a stop is announced, and a repeated reason is not announced twice", async () => {
	const h = harness(branchWith([task(1, "pending")]), { maxRounds: 1 });
	const settle = { outcome: "completed", toolResults: [], entries: [] };

	await run(h, "turn_end", settle); // continues
	const afterContinue = h.notices.length;
	await run(h, "turn_end", settle); // stops on the cap
	assert.equal(h.notices.length, afterContinue + 1, "the stop is announced");
	assert.match(h.notices.at(-1) as string, /todo-loop: stopped: round cap 1 reached/);

	await run(h, "turn_end", settle); // stops on the strike budget: a different reason
	const afterSecondStop = h.notices.length;
	assert.match(h.notices.at(-1) as string, /no progress/);

	await run(h, "turn_end", settle); // same reason again: silent
	assert.equal(h.notices.length, afterSecondStop, "an unchanged reason is not repeated");
});

test("a list cleared by todo calls alone is not laundered as verified work", async () => {
	const h = harness([
		{ type: "message", id: "user-1", message: { role: "user", content: "go" } },
		{ type: "custom", customType: "rpiv-todo-state", id: "t1", data: { tasks: [task(1, "pending")] } },
	]);
	await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] });
	const before = h.notices.length;
	// The clear arrives in the next turn, as a real todo call would.
	h.branch.push({ type: "custom", customType: "rpiv-todo-state", id: "t2", data: { tasks: [task(1, "completed")] } });
	await run(h, "turn_end", {
		outcome: "completed",
		toolResults: [{ toolName: "todo" }],
		entries: [],
	});
	assert.equal(h.notices.length, before + 1, "the suspicious clear is announced");
	assert.match(h.notices.at(-1) as string, /cleared by todo calls alone/);
});

test("a list cleared alongside real tool work is not announced", async () => {
	const h = harness([
		{ type: "message", id: "user-1", message: { role: "user", content: "go" } },
		{ type: "custom", customType: "rpiv-todo-state", id: "t1", data: { tasks: [task(1, "pending")] } },
	]);
	await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] });
	const before = h.notices.length;
	h.branch.push({ type: "custom", customType: "rpiv-todo-state", id: "t2", data: { tasks: [task(1, "completed")] } });
	await run(h, "turn_end", { outcome: "completed", toolResults: [{ toolName: "todo" }, { toolName: "bash" }], entries: [] });
	assert.equal(h.notices.length, before, "real work needs no warning");
});

test("a run of markers keeps one, so no two assistant turns end up adjacent", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "context", {
		messages: [
			{ role: "assistant", content: "a" },
			marker(),
			marker(),
			{ role: "assistant", content: "b" },
		],
	});
	const roles = result.messages.map((message: any) => (message.customType ? "marker" : message.role));
	assert.deepEqual(roles, ["assistant", "marker", "assistant"]);
	assert.equal(result.messages.length, 3, "one marker survives, no block is added");
});

test("a run of markers at the tail keeps one, so the nudge survives", async () => {
	const h = harness(branchWith([task(1, "pending")]));
	const result = await run(h, "context", { messages: [{ role: "assistant", content: "a" }, marker(), marker()] });
	assert.deepEqual(result.messages.map((message: any) => (message.customType ? "marker" : message.role)), ["assistant", "marker"]);
});
