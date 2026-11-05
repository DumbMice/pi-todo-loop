/**
 * Loop policy: the pure decision function.
 *
 * Everything that can loop forever lives here, so it can be unit-tested without
 * running a model. `index.ts` only adapts pi events into `DecisionInput` and
 * applies the result.
 */

export interface LoopState {
	/** Continuations started since the last human message. */
	rounds: number;
	/**
	 * Consecutive settles that neither ran a tool nor changed the task list. No cap:
	 * it decides when to offer the block tool, not when to give up.
	 */
	stalled: number;
	/** Whether the "call todo_loop_block" clause has already been offered this stall. */
	hintSent: boolean;
	/** Task signature at the previous decision, to detect list changes. */
	lastSignature: string;
	/** Settles since the list last changed: a stale list stops on the cap. */
	staleSettles: number;
	/** Id of the user message the current budget belongs to. */
	anchor: string;
}

export interface LoopConfig {
	/** Max consecutive auto-continuations per human message. */
	maxRounds: number;
}

export const DEFAULTS: LoopConfig = {
	maxRounds: 12,
};

export type DecisionInput = {
	/** `turn_end` outcome: "completed" is the only value that may continue. */
	outcome: string;
	/** Number of tool results in the turn that just ended. */
	toolResultCount: number;
	/** Current task signature (id:status joined), empty when no list. */
	signature: string;
	/** Open (pending or in_progress) task count. */
	openCount: number;
	/** Total tracked task count, used only for the stop reason. */
	taskCount: number;
	/** Id of the newest human message on the branch. */
	anchor: string;
	state: LoopState;
	config: LoopConfig;
};

export interface Decision {
	/** True when the caller should request another turn. */
	continue: boolean;
	/** True when the caller should persist `rounds` as they are (no reset). */
	next: LoopState;
	reason: string;
	/**
	 * True when this continuation should carry the "if you cannot proceed without a
	 * person, call todo_loop_block" clause. Offered once per stall: this is the first
	 * stop since real progress that did not move the list — the shape a blocked agent
	 * has.
	 */
	hint: boolean;
}

/**
 * A stop keeps the counters. Only a new human message starts a new budget: a cap
 * or cap stop that cleared them would re-arm the full budget on the next
 * `turn_end` under the same anchor (another extension's continuation, a provider
 * retry). A queued human message is a new anchor by definition, so it resets the
 * budget the ordinary way.
 */
function stop(state: LoopState, reason: string): Decision {
	return { continue: false, next: { ...state }, hint: false, reason };
}

/**
 * Decide whether to continue.
 *
 * Order matters: a new human message resets the budget before anything else, so
 * a long conversation cannot inherit the previous turn's spent rounds.
 */
export function decide(input: DecisionInput): Decision {
	const { state, config } = input;

	// A new human message owns a fresh budget.
	let current: LoopState =
		input.anchor !== state.anchor
			? { ...state, rounds: 0, stalled: 0, hintSent: false, lastSignature: "", staleSettles: 0, anchor: input.anchor }
			: { ...state };

	if (input.outcome !== "completed") {
		return stop(current, `stopped: turn outcome was ${input.outcome}`);
	}
	if (input.openCount === 0) {
		return stop(current, input.taskCount > 0 ? "stopped: list is clear" : "stopped: no list");
	}

	const progressed = input.toolResultCount > 0 || input.signature !== current.lastSignature;
	if (progressed) {
		// Work re-arms the hint: a second stall, after real progress, is a new question.
		current.stalled = 0;
		current.hintSent = false;
		current.staleSettles = 0;
	} else {
		current.staleSettles += 1;
		current.stalled += 1;
	}

	// A repeat stop is the shape a blocked agent has: it already answered once, it did
	// not move the list, and it stopped again. Offer the block tool there — once per
	// stall — and never stop the loop for it. The only stops are a clear list, the
	// round cap, an error, and the agent asking for a person.
	const hint = current.stalled >= 1 && !current.hintSent;

	if (current.rounds >= config.maxRounds) {
		const stale =
			current.staleSettles >= 2 ? `, list unchanged for ${current.staleSettles} settles` : "";
		// A hint that comes due on the cap round has no continuation left to ride in.
		// Do not drop it silently: the human reads the reason, and the agent may be
		// blocked rather than done.
		const stalled = hint ? ", the agent stalled and may need a person" : "";
		return stop(current, `stopped: round cap ${config.maxRounds} reached, ${input.openCount} open${stale}${stalled}`);
	}

	current.rounds += 1;
	current.lastSignature = input.signature;
	if (hint) current.hintSent = true;
	return {
		continue: true,
		next: current,
		hint,
		reason: `continuing: round ${current.rounds}/${config.maxRounds}, ${input.openCount} open`,
	};
}

export function initialState(): LoopState {
	return { rounds: 0, stalled: 0, hintSent: false, lastSignature: "", staleSettles: 0, anchor: "" };
}
