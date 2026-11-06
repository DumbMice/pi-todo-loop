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
	assert.match(decision.reason, /1 task still open, continue 1/);
	assert.doesNotMatch(decision.reason, /\d\/\d/, "no cap by default, so the reason has no denominator");
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

test("the hint asks exactly one stop after the last one", () => {
	// "It stopped, we sent one request, and it stopped again with the list unchanged."
	const known = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	const first = decide(input({ toolResultCount: 0, state: known }));
	assert.equal(first.continue, true, "a stall is never a stop");
	assert.equal(first.hint, false, "one stop is not yet a pattern");

	const second = decide(input({ toolResultCount: 0, state: first.next }));
	assert.equal(second.continue, true);
	assert.equal(second.hint, true, "the second stop answers the question the nudge asks");

	const third = decide(input({ toolResultCount: 0, state: second.next }));
	assert.equal(third.hint, false, "one request per stall, not a series");
	assert.equal(third.next.stalled, 3);
});
test("the first sighting of a list counts as progress, not a stall", () => {
	// Fresh state has an empty signature, so it must not look like a no-op turn.
	const decision = decide(input({ toolResultCount: 0 }));
	assert.equal(decision.next.stalled, 0);
	assert.equal(decision.hint, false, "no hint on the first nudge of a chain");
	assert.equal(decision.continue, true);
});
test("a list change is progress, so it is not asked about", () => {
	const known = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	const first = decide(input({ toolResultCount: 0, state: known }));
	const second = decide(
		input({ toolResultCount: 0, signature: "1:completed,2:pending", state: first.next }),
	);
	assert.equal(second.continue, true);
	assert.equal(second.next.stalled, 0);
	assert.equal(second.hint, false, "the list moved, so nothing is stuck");
});
test("no round cap by default", () => {
	// Unlimited: the loop ends when the list clears or the agent asks for a person.
	const state = { ...initialState(), rounds: 500, anchor: "user-1", lastSignature: "1:pending" };
	const decision = decide(input({ state, signature: "1:completed,2:pending" }));
	assert.equal(decision.continue, true);
	assert.match(decision.reason, /continue 501/);
});

test("a configured round cap stops the loop", () => {
	const config = { ...DEFAULTS, maxRounds: 3 };
	const state = { ...initialState(), rounds: 3, anchor: "user-1", lastSignature: "1:pending" };
	const decision = decide(input({ state, config }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /3 continuations used/);
});

test("a cap that lands on the bare stall names it in the reason", () => {
	// The one continuation that would have carried the clause never happens, so the reason
	// has to say it. `settleRun: 1` means this settle is the second stop in a row.
	const config = { ...DEFAULTS, maxRounds: 3 };
	const state = { ...initialState(), rounds: 3, anchor: "user-1", lastSignature: "1:pending", settleRun: 1 };
	const decision = decide(input({ state, config, toolResultCount: 0 }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /the agent may need you/);
});

test("a new human message clears every counter, including the warning's", () => {
	const spent = { ...initialState(), anchor: "user-1", rounds: 5, stalled: 4, staleSettles: 9, settleRun: 5 };
	const decision = decide(input({ state: spent, anchor: "user-2" }));
	assert.equal(decision.next.rounds, 1, "a fresh budget, with this continuation counted");
	assert.equal(decision.next.stalled, 0);
	assert.equal(decision.next.staleSettles, 0, "otherwise a new message would warn almost immediately");
	// This settle is the first turn of the new run, so it counts as 1 — what matters is that
	// the previous message's value (5) does not carry over and hide every later hint.
	assert.equal(decision.next.settleRun, 1);
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
	assert.match(second.reason, /1 continuation used/);
});

test("a tool turn ends the run, so the next pair is asked again", () => {
	// The model this package exists for: tools running, list frozen. Work between two stops
	// means the pair is not "stop, one request, stop" — but the pair after it still is.
	const working = { ...initialState(), anchor: "user-1", lastSignature: "1:pending", settleRun: 0 };
	const first = decide(input({ toolResultCount: 0, state: working }));
	assert.equal(first.hint, false);
	const second = decide(input({ toolResultCount: 0, state: first.next }));
	assert.equal(second.hint, true, "stop, nudge, stop — with no work between them");

	// A tool turn resets the run (the adapter sets settleRun = 0 on every tool turn).
	const afterTool = { ...second.next, settleRun: 0 };
	const restart = decide(input({ toolResultCount: 0, signature: "1:pending", state: afterTool }));
	assert.equal(restart.hint, false, "the first stop after work is not asked");
	const asked = decide(input({ toolResultCount: 0, signature: "1:pending", state: restart.next }));
	assert.equal(asked.hint, true, "but the stop after it is, so a tool-heavy stall is still asked");
});
test("a stale list stops on the cap with a reason that says so", () => {
	const config = { ...DEFAULTS, maxRounds: 2 };
	let state = { ...initialState(), anchor: "user-1", lastSignature: "1:pending" };
	for (let round = 0; round < 3; round += 1) {
		state = decide(input({ toolResultCount: 0, state, config })).next;
	}
	const decision = decide(input({ toolResultCount: 0, state, config }));
	assert.equal(decision.continue, false);
	assert.match(decision.reason, /2 continuations used/);
	assert.match(decision.reason, /no todo change for \d+ replies/, "a stale burn must not read like healthy work");
	assert.doesNotMatch(decision.reason, /may need you/, "the cap landed on the second stall, not the first");
});
