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
	assert.match(decision.reason, /round 1\/12/);
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

test("a text-only turn that changes nothing spends a strike, then stops", () => {
	// The list is already known: this is turn 2+, not the turn that created it.
	const known = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	const first = decide(input({ toolResultCount: 0, state: known }));
	assert.equal(first.continue, true);
	assert.equal(first.next.strikes, 1);

	const second = decide(input({ toolResultCount: 0, state: first.next }));
	assert.equal(second.continue, false);
	assert.match(second.reason, /no progress/);
});

test("the first sighting of a list counts as progress, not a strike", () => {
	// Fresh state has an empty signature, so it must not look like a no-op turn.
	const decision = decide(input({ toolResultCount: 0 }));
	assert.equal(decision.next.strikes, 0);
	assert.equal(decision.continue, true);
});

test("a list change counts as progress even with no tool results", () => {
	const known = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	const first = decide(input({ toolResultCount: 0, state: known }));
	const second = decide(
		input({ toolResultCount: 0, signature: "1:completed,2:pending", state: first.next }),
	);
	assert.equal(second.continue, true, "signature change should reset strikes");
	assert.equal(second.next.strikes, 0);
});

test("round cap stops the loop", () => {
	const state = { ...initialState(), rounds: DEFAULTS.maxRounds, anchor: "user-1", lastSignature: "1:pending" };
	const decision = decide(input({ state }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /round cap/);
});

test("a new human message resets the budget", () => {
	const spent = { rounds: 7, strikes: 1, lastSignature: "1:pending", anchor: "user-1" };
	const decision = decide(input({ state: spent, anchor: "user-2" }));
	assert.equal(decision.continue, true);
	assert.equal(decision.next.rounds, 1, "rounds must restart at 1");
	assert.equal(decision.next.strikes, 0);
	assert.equal(decision.next.anchor, "user-2");
});

test("a stop keeps the counters, so a cap stays shut for the same anchor", () => {
	const spent = { rounds: 5, strikes: 0, lastSignature: "1:pending", anchor: "user-1" };
	const decision = decide(input({ state: spent, openCount: 0 }));
	assert.equal(decision.next.rounds, 5, "only a new human message resets the budget");
	assert.equal(decision.next.anchor, "user-1");
});

test("a new human message after a stop starts a fresh budget", () => {
	const spent = { rounds: 5, strikes: 2, lastSignature: "1:pending", anchor: "user-1" };
	const decision = decide(input({ state: spent, anchor: "user-2" }));
	assert.equal(decision.continue, true);
	assert.equal(decision.next.rounds, 1);
	assert.equal(decision.next.strikes, 0);
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

test("strikes never exceed the cap they are measured against", () => {
	const known = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	let state = known;
	for (let round = 0; round < 4; round += 1) {
		state = decide(input({ toolResultCount: 0, state })).next;
	}
	assert.equal(state.strikes, DEFAULTS.maxStrikes, "a budget should not read 3/2");
});

test("a stale list stops on the cap with a reason that says so", () => {
	const config = { ...DEFAULTS, maxRounds: 2, maxStrikes: 10 };
	let state = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	for (let round = 0; round < 3; round += 1) {
		state = decide(input({ toolResultCount: 0, state, config })).next;
	}
	const decision = decide(input({ toolResultCount: 0, state, config }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /round cap 2 reached/);
	assert.match(decision.reason, /list unchanged for \d+ settles/, "a stale burn must not read like healthy work");
});
