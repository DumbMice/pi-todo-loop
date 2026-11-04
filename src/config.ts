/**
 * Config loading. A missing, unreadable, or malformed file falls back to the
 * defaults: this extension must never be the reason a turn fails.
 */

import { readFileSync } from "node:fs";
import { DEFAULTS, type LoopConfig } from "./loop.ts";

export { DEFAULTS };

function coerce(raw: unknown): Partial<LoopConfig> {
	if (typeof raw !== "object" || raw === null) return {};
	const record = raw as Record<string, unknown>;
	const out: Partial<LoopConfig> = {};

	const positive = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;

	const maxRounds = positive(record.maxRounds);
	if (maxRounds !== undefined) out.maxRounds = maxRounds;

	const maxStrikes = positive(record.maxStrikes);
	if (maxStrikes !== undefined) out.maxStrikes = maxStrikes;

	if (typeof record.injectState === "boolean") out.injectState = record.injectState;

	const maxInjectedTasks = positive(record.maxInjectedTasks);
	if (maxInjectedTasks !== undefined) out.maxInjectedTasks = maxInjectedTasks;

	return out;
}

export function mergeConfig(raw: unknown): LoopConfig {
	return { ...DEFAULTS, ...coerce(raw) };
}

export function loadConfig(path: string): LoopConfig {
	try {
		return mergeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return DEFAULTS;
	}
}
