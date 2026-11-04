/**
 * The state machine, as a table of event sequences.
 *
 * Every release-blocking defect in this repository's history lived in one place:
 * the interaction between pi's `turn_end` cadence and the four counters. The other
 * suites test units; this one replays realistic event sequences against the real
 * hooks and asserts the whole observable outcome at once — counters, the
 * continuation decision, the marker count, and the reason `/todoloop` reports.
 *
 * Vocabulary, matching pi's behaviour:
 *
 *   settle  an assistant response with no tool calls — the only turn that can end
 *           the run, and so the only turn that can spend a round or a strike
 *   tool    an assistant response that ended in tool calls — pi requests the next
 *           turn itself; costs no round, writes no marker, clears a strike
 *   edit    the todo list changed (a tool call that updated it)
 *   human   a new message from the person, which resets the budget
 *
 * Adding a case here is the cheap way to pin a policy change: append a row to
 * `SCENARIOS`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { branchWith, harness, killSwitch, run, setHuman, setTasks, task, type Harness } from "./helpers/harness.ts";
import { MARKER_TYPE } from "../src/index.ts";

type Step =
	| { do: "settle" }
	| { do: "tool" }
	| { do: "edit"; tasks: unknown[] }
	| { do: "human" }
	| { do: "error" }
	| { do: "aborted" }
	| { do: "pause" }
	| { do: "resume" }
	| { do: "reset" }
	| { do: "killSwitch"; on: boolean }
	| { do: "clear" };

interface Expected {
	continuations: number;
	markers: number;
	rounds: number;
	strikes: number;
	reason: RegExp;
	mode: RegExp;
}

interface Outcome {
	/** Continuations proposed over the whole sequence. */
	continuations: number;
	/** Markers appended over the whole sequence. */
	markers: number;
	rounds: number;
	strikes: number;
	/** The `last:` line `/todoloop` prints at the end. */
	reason: string;
	/** The header `/todoloop` prints at the end. */
	mode: string;
}

interface Scenario {
	name: string;
	steps: Step[];
	config?: Record<string, unknown>;
	expect: Expected;
}

const OPEN = [task(1, "in_progress"), task(2, "pending")];
const ONE_DONE = [task(1, "completed"), task(2, "pending")];
const ALL_DONE = [task(1, "completed"), task(2, "completed")];

interface StepResult {
	continued: boolean;
	markers: number;
}

async function play(h: Harness, step: Step): Promise<StepResult> {
	const fromTurnEnd = (result: any): StepResult => ({
		continued: result?.continue === true,
		markers: Array.isArray(result?.entries)
			? (result.entries as unknown[]).filter(
					(entry) => (entry as Record<string, unknown>).customType === MARKER_TYPE,
				).length
			: 0,
	});

	switch (step.do) {
		case "settle":
			return fromTurnEnd(await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] }));
		case "tool":
			return fromTurnEnd(
				await run(h, "turn_end", { outcome: "completed", toolResults: [{ role: "toolResult" }], entries: [] }),
			);
		case "edit":
			setTasks(h, step.tasks);
			return fromTurnEnd(await run(h, "turn_end", { outcome: "completed", toolResults: [], entries: [] }));
		case "human":
			setHuman(h);
			return { continued: false, markers: 0 };
		case "error":
			return fromTurnEnd(await run(h, "turn_end", { outcome: "error", toolResults: [], entries: [] }));
		case "aborted":
			return fromTurnEnd(await run(h, "turn_end", { outcome: "aborted", toolResults: [], entries: [] }));
		case "pause":
			await h.commands.todoloop.handler("pause", h.ctx);
			return { continued: false, markers: 0 };
		case "resume":
			await h.commands.todoloop.handler("resume", h.ctx);
			return { continued: false, markers: 0 };
		case "reset":
			await h.commands.todoloop.handler("reset", h.ctx);
			return { continued: false, markers: 0 };
		case "killSwitch":
			killSwitch(h, step.on);
			return { continued: false, markers: 0 };
		case "clear":
			setTasks(h, ALL_DONE);
			return { continued: false, markers: 0 };
	}
}

async function playAll(scenario: Scenario): Promise<Outcome> {
	const h = harness(branchWith(OPEN), scenario.config);
	let continuations = 0;
	let markers = 0;
	for (const step of scenario.steps) {
		const result = await play(h, step);
		if (result.continued) continuations += 1;
		markers += result.markers;
	}

	await h.commands.todoloop.handler("", h.ctx);
	const status = h.notices.at(-1) as string;
	const counters = status.match(/rounds (\d+)\/\d+ · strikes (\d+)\/\d+/);
	const reason = status.match(/last: (.*)/)?.[1] ?? status;
	return {
		continuations,
		markers,
		rounds: Number(counters?.[1] ?? -1),
		strikes: Number(counters?.[2] ?? -1),
		reason,
		mode: status.split("\n")[0],
	};
}

const SCENARIOS: Scenario[] = [
	{
		name: "ideal run: every settle changes the list, then it clears",
		steps: [{ do: "edit", tasks: ONE_DONE }, { do: "edit", tasks: [task(1, "completed"), task(2, "completed")] }],
		expect: { continuations: 1, markers: 1, rounds: 1, strikes: 0, reason: /stopped: list is clear/, mode: /stopped/ },
	},
	{
		name: "prose-only model: second no-change settle stops the loop",
		steps: [{ do: "settle" }, { do: "settle" }, { do: "settle" }],
		expect: { continuations: 2, markers: 2, rounds: 2, strikes: 2, reason: /no progress/, mode: /stopped/ },
	},
	{
		name: "stale list with tool work: strikes are cleared, the cap stops it",
		config: { maxRounds: 3 },
		steps: [
			{ do: "settle" },
			{ do: "settle" },
			{ do: "tool" },
			{ do: "tool" },
			{ do: "settle" },
			{ do: "tool" },
			{ do: "settle" },
			{ do: "tool" },
			{ do: "settle" },
		],
		expect: { continuations: 3, markers: 3, rounds: 3, strikes: 1, reason: /round cap 3/, mode: /stopped/ },
	},
	{
		name: "a tool turn spends no round and writes no marker",
		config: { maxRounds: 2 },
		steps: [
			{ do: "tool" },
			{ do: "tool" },
			{ do: "tool" },
			{ do: "settle" },
			{ do: "settle" },
		],
		expect: { continuations: 2, markers: 2, rounds: 2, strikes: 1, reason: /continuing: round 2\/2/, mode: /active/ },
	},
	{
		name: "cap stays shut across a repeated settle under the same message",
		config: { maxRounds: 1 },
		steps: [{ do: "settle" }, { do: "settle" }, { do: "settle" }],
		expect: { continuations: 1, markers: 1, rounds: 1, strikes: 2, reason: /no progress/, mode: /stopped/ },
	},
	{
		name: "a new human message starts a new budget after a cap stop",
		config: { maxRounds: 1 },
		steps: [{ do: "settle" }, { do: "settle" }, { do: "human" }, { do: "settle" }],
		expect: { continuations: 2, markers: 2, rounds: 1, strikes: 0, reason: /continuing: round 1\/1/, mode: /active/ },
	},
	{
		name: "pause freezes the counters and resume lets the next settle continue",
		steps: [{ do: "settle" }, { do: "pause" }, { do: "settle" }, { do: "resume" }, { do: "settle" }],
		expect: { continuations: 2, markers: 2, rounds: 2, strikes: 1, reason: /continuing: round 2/, mode: /active/ },
	},
	{
		name: "reset clears a strike stop and lets the loop continue again",
		steps: [{ do: "settle" }, { do: "settle" }, { do: "settle" }, { do: "reset" }, { do: "settle" }],
		expect: { continuations: 3, markers: 3, rounds: 1, strikes: 0, reason: /continuing: round 1/, mode: /active/ },
	},
	{
		name: "an errored settle stops without spending a round, and the next settle can continue",
		steps: [{ do: "settle" }, { do: "error" }, { do: "edit", tasks: ONE_DONE }],
		expect: { continuations: 2, markers: 2, rounds: 2, strikes: 0, reason: /continuing: round 2/, mode: /active/ },
	},
	{
		name: "an aborted settle stops the loop and keeps the counters",
		steps: [{ do: "settle" }, { do: "aborted" }],
		expect: { continuations: 1, markers: 1, rounds: 1, strikes: 0, reason: /turn outcome was aborted/, mode: /stopped/ },
	},
	{
		name: "the kill switch stops continuations and keeps the counters",
		steps: [{ do: "settle" }, { do: "killSwitch", on: true }, { do: "settle" }, { do: "killSwitch", on: false }],
		expect: { continuations: 1, markers: 1, rounds: 1, strikes: 0, reason: /continuing: round 1/, mode: /active/ },
	},
	{
		name: "a cleared list stops immediately and reports it",
		steps: [{ do: "settle" }, { do: "clear" }, { do: "settle" }],
		expect: { continuations: 1, markers: 1, rounds: 1, strikes: 0, reason: /stopped: list is clear/, mode: /stopped/ },
	},
];

for (const scenario of SCENARIOS) {
	test(`state machine: ${scenario.name}`, async () => {
		const outcome = await playAll(scenario);
		assert.equal(outcome.continuations, scenario.expect.continuations, "continuations proposed");
		assert.equal(outcome.rounds, scenario.expect.rounds, "rounds left");
		assert.equal(outcome.strikes, scenario.expect.strikes, "strikes left");
		assert.equal(outcome.markers, scenario.expect.markers, "markers written");
		assert.match(outcome.reason, scenario.expect.reason, `last reason: ${outcome.reason}`);
		assert.match(outcome.mode, scenario.expect.mode, `status header: ${outcome.mode}`);
	});
}

test("state machine: every continuation appends exactly one marker, and nothing else does", async () => {
	const h = harness(branchWith(OPEN));
	const step = (outcome: string, toolResults: unknown[]) => ({ outcome, toolResults, entries: [] });

	await run(h, "turn_end", step("completed", [{ role: "toolResult" }]));
	await run(h, "turn_end", step("completed", []));
	await run(h, "turn_end", step("completed", [{ role: "toolResult" }]));
	const continuation = await run(h, "turn_end", step("completed", []));
	await run(h, "turn_end", step("completed", [{ role: "toolResult" }]));

	const markers = (continuation.entries as unknown[]).filter(
		(entry) => (entry as Record<string, unknown>).customType === MARKER_TYPE,
	);
	assert.equal(markers.length, 1);
	assert.equal((markers[0] as Record<string, unknown>).display, false);
	assert.equal((markers[0] as Record<string, unknown>).type, "custom_message");
});
