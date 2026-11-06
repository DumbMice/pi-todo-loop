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
	/** A tool turn happened since the last stop, so the next stop was not a bare stall. */
	toolSinceStop: boolean;
	/** Task signature at the previous decision, to detect list changes. */
	lastSignature: string;
	/** Settles since the list last changed: a stale list stops on the cap. */
	staleSettles: number;
	/** Id of the user message the current budget belongs to. */
	anchor: string;
}

export interface LoopConfig {
	/** Continuations allowed per human message; `null` means no limit. */
	maxRounds: number | null;
}

export const DEFAULTS: LoopConfig = {
	// No cap by default: the loop ends when the list clears, the agent asks for a person,
	// or you stop it. Set a number to bound what one message of yours can cost.
	maxRounds: null,
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
	 * person, call todo_loop_block" clause: the first settle since real progress that did
	 * not move the list. One request, not a series.
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
			? {
					...state,
					rounds: 0,
					stalled: 0,
					toolSinceStop: false,
					lastSignature: "",
					staleSettles: 0,
					anchor: input.anchor,
				}
			: { ...state };

	if (input.outcome !== "completed") {
		return stop(current, `stopped: turn outcome was ${input.outcome}`);
	}
	if (input.openCount === 0) {
		return stop(current, input.taskCount > 0 ? "stopped: list is clear" : "stopped: no list");
	}

	const progressed = input.toolResultCount > 0 || input.signature !== current.lastSignature;
	if (progressed) {
		current.stalled = 0;
		current.staleSettles = 0;
		current.toolSinceStop = false;
	} else {
		current.staleSettles += 1;
		current.stalled += 1;
	}

	// The hint asks "are you blocked?" and only one shape answers that: the model stopped, we
	// sent one request, and it stopped again having touched nothing. A tool turn in between is
	// an answer — it was working, not stuck — so the question is not asked again there.
	const hint = current.stalled === 1 && !current.toolSinceStop;

	if (config.maxRounds !== null && current.rounds >= config.maxRounds) {
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
	current.toolSinceStop = false;
	const of = config.maxRounds === null ? "" : `/${config.maxRounds}`;
	return {
		continue: true,
		next: current,
		hint,
		reason: `continuing: round ${current.rounds}${of}, ${input.openCount} open`,
	};
}

export function initialState(): LoopState {
	return { rounds: 0, stalled: 0, toolSinceStop: false, lastSignature: "", staleSettles: 0, anchor: "" };
}
