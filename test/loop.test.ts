import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, DEFAULTS, initialState, type DecisionInput } from "../src/loop.ts";

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
	return {
		outcome: "completed",
		toolResultCount: 1,
		signature: "1:pending",
		openCount: 1,
		taskCount: 1,
		anchor: "user-1",
		state: initialState(),
		config: DEFAULTS,
		...overrides,
	};
}

test("continues while work is open and the turn did work", () => {
	const decision = decide(input());
	assert.equal(decision.continue, true);
	assert.equal(decision.next.rounds, 1);
	assert.match(decision.reason, /round 1, 1 open/, "no cap by default, so the reason has no denominator");
});

test("stops when the list is clear", () => {
	const decision = decide(input({ openCount: 0, signature: "1:completed" }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /list is clear/);
});

test("stops when there is no list at all", () => {
	const decision = decide(input({ openCount: 0, taskCount: 0, signature: "" }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /no list/);
});

test("never continues on an error or aborted turn", () => {
	for (const outcome of ["error", "aborted"]) {
		const decision = decide(input({ outcome }));
		assert.equal(decision.continue, false, outcome);
		assert.match(decision.reason, new RegExp(outcome));
	}
});

test("only the first no-progress settle carries the block hint", () => {
	// The list is already known: this is turn 2+, not the turn that created it.
	const known = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	const first = decide(input({ toolResultCount: 0, state: known }));
	assert.equal(first.continue, true, "a stall is never a stop");
	assert.equal(first.next.stalled, 1);
	assert.equal(first.hint, true, "the first repeat stop is what a blocked agent looks like");

	const second = decide(input({ toolResultCount: 0, state: first.next }));
	assert.equal(second.continue, true);
	assert.equal(second.hint, false, "one request, not a series");
	assert.equal(second.next.stalled, 2);
});
test("the first sighting of a list counts as progress, not a stall", () => {
	// Fresh state has an empty signature, so it must not look like a no-op turn.
	const decision = decide(input({ toolResultCount: 0 }));
	assert.equal(decision.next.stalled, 0);
	assert.equal(decision.hint, false, "no hint on the first nudge of a chain");
	assert.equal(decision.continue, true);
});
test("a list change clears the stall and re-arms the hint", () => {
	const known = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	const first = decide(input({ toolResultCount: 0, state: known }));
	const second = decide(
		input({ toolResultCount: 0, signature: "1:completed,2:pending", state: first.next }),
	);
	assert.equal(second.continue, true, "signature change should reset stalls");
	assert.equal(second.next.stalled, 0);
	assert.equal(second.hint, false);

	const third = decide(
		input({ toolResultCount: 0, signature: "1:completed,2:pending", state: second.next }),
	);
	assert.equal(third.hint, true, "the next stall is a new question");
});
test("no round cap by default", () => {
	// Unlimited: the loop ends when the list clears or the agent asks for a person.
	const state = { ...initialState(), rounds: 500, anchor: "user-1", lastSignature: "1:pending" };
	const decision = decide(input({ state, signature: "1:completed,2:pending" }));
	assert.equal(decision.continue, true);
	assert.match(decision.reason, /round 501/);
});

test("a configured round cap stops the loop", () => {
	const config = { ...DEFAULTS, maxRounds: 3 };
	const state = { ...initialState(), rounds: 3, anchor: "user-1", lastSignature: "1:pending" };
	const decision = decide(input({ state, config }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /round cap 3/);
});

test("a new human message resets the budget", () => {
	const spent = { ...initialState(), rounds: 7, stalled: 1, lastSignature: "1:pending", anchor: "user-1" };
	const decision = decide(input({ state: spent, anchor: "user-2" }));
	assert.equal(decision.continue, true);
	assert.equal(decision.next.rounds, 1, "rounds must restart at 1");
	assert.equal(decision.next.stalled, 0);
	assert.equal(decision.next.anchor, "user-2");
});
test("a stop keeps the counters, so a cap stays shut for the same anchor", () => {
	const spent = { ...initialState(), rounds: 5, anchor: "user-1", lastSignature: "1:pending" };
	const decision = decide(input({ state: spent, openCount: 0 }));
	assert.equal(decision.next.rounds, 5, "only a new human message resets the budget");
	assert.equal(decision.next.anchor, "user-1");
});
test("a new human message after a stop starts a fresh budget", () => {
	const spent = { ...initialState(), rounds: 5, stalled: 2, anchor: "user-1" };
	const decision = decide(input({ state: spent, anchor: "user-2" }));
	assert.equal(decision.continue, true);
	assert.equal(decision.next.rounds, 1);
	assert.equal(decision.next.stalled, 0);
});
test("config caps are honoured", () => {
	const strict = { ...DEFAULTS, maxRounds: 1 };
	const first = decide(input({ config: strict }));
	assert.equal(first.continue, true);
	const second = decide(
		input({ config: strict, state: first.next, signature: "1:in_progress" }),
	);
	assert.equal(second.continue, false);
	assert.match(second.reason, /round cap 1/);
});

test("tool work clears the stall and re-arms the hint", () => {
	// A tool turn is progress even when the list did not move: an agent that keeps
	// working is not stuck, and a later stall is a new question.
	const known = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	const stalled = decide(input({ toolResultCount: 0, state: known }));
	const worked = decide(input({ toolResultCount: 1, state: stalled.next }));
	assert.equal(worked.next.stalled, 0);
	assert.equal(worked.hint, false, "work is not a stall, so no clause");

	// A stop that follows a tool turn is not a bare stall: the model already answered
	// "are you blocked?" by working, so the next stop is not asked again.
	const afterWork = decide(input({ toolResultCount: 0, signature: "1:pending", state: { ...worked.next, toolSinceStop: true } }));
	assert.equal(afterWork.hint, false);
	const again = decide(input({ toolResultCount: 0, state: worked.next, signature: "1:pending" }));
	assert.equal(again.hint, true, "a bare stop with no work in between is asked again");
});
test("a stale list stops on the cap with a reason that says so", () => {
	const config = { ...DEFAULTS, maxRounds: 2 };
	let state = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	for (let round = 0; round < 3; round += 1) {
		state = decide(input({ toolResultCount: 0, state, config })).next;
	}
	const decision = decide(input({ toolResultCount: 0, state, config }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /round cap 2 reached/);
	assert.match(decision.reason, /list unchanged for \d+ settles/, "a stale burn must not read like healthy work");
	assert.doesNotMatch(decision.reason, /may need a person/, "the cap landed on the second stall, not the first");
});
