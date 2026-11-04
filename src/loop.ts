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
	/** Consecutive turns that neither ran a tool nor changed the task list. */
	strikes: number;
	/** Task signature at the previous decision, to detect list changes. */
	lastSignature: string;
	/** Settles since the list last changed: a stale list stops on the cap, not on strikes. */
	staleSettles: number;
	/** Id of the user message the current budget belongs to. */
	anchor: string;
}

export interface LoopConfig {
	/** Max consecutive auto-continuations per human message. */
	maxRounds: number;
	/** Consecutive no-progress turns tolerated before stopping. */
	maxStrikes: number;
	/** Inject the live task list at the tail of every request. */
	injectState: boolean;
	/** Max open tasks rendered in that injection. */
	maxInjectedTasks: number;
}

export const DEFAULTS: LoopConfig = {
	maxRounds: 12,
	maxStrikes: 2,
	injectState: true,
	maxInjectedTasks: 6,
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
}

/**
 * A stop keeps the counters. Only a new human message starts a new budget: a cap
 * or strike stop that cleared them would re-arm the full budget on the next
 * `turn_end` under the same anchor (another extension's continuation, a provider
 * retry). A queued human message is a new anchor by definition, so it resets the
 * budget the ordinary way.
 */
function stop(state: LoopState, reason: string): Decision {
	return { continue: false, next: { ...state }, reason };
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
			? { ...state, rounds: 0, strikes: 0, lastSignature: "", staleSettles: 0, anchor: input.anchor }
			: { ...state };

	if (input.outcome !== "completed") {
		return stop(current, `stopped: turn outcome was ${input.outcome}`);
	}
	if (input.openCount === 0) {
		return stop(current, input.taskCount > 0 ? "stopped: list is clear" : "stopped: no list");
	}

	const progressed = input.toolResultCount > 0 || input.signature !== current.lastSignature;
	if (progressed) {
		current.strikes = 0;
		current.staleSettles = 0;
	} else {
		current.staleSettles += 1;
		// A budget must never read above the cap it is measured against (`strikes 3/2`).
		current.strikes = Math.min(current.strikes + 1, config.maxStrikes);
		if (current.strikes >= config.maxStrikes) {
			return stop(
				current,
				`stopped: ${current.strikes} consecutive turns with no progress, ${input.openCount} open`,
			);
		}
	}

	if (current.rounds >= config.maxRounds) {
		const stale =
			current.staleSettles >= 2 ? `, list unchanged for ${current.staleSettles} settles` : "";
		return stop(current, `stopped: round cap ${config.maxRounds} reached, ${input.openCount} open${stale}`);
	}

	current.rounds += 1;
	current.lastSignature = input.signature;
	return {
		continue: true,
		next: current,
		reason: `continuing: round ${current.rounds}/${config.maxRounds}, ${input.openCount} open`,
	};
}

export function initialState(): LoopState {
	return { rounds: 0, strikes: 0, lastSignature: "", staleSettles: 0, anchor: "" };
}
