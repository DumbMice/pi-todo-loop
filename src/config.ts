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

	// Clamped, not just validated: a hostile or typo'd config must not be able to
	// defeat the caps it configures (`maxRounds: 1e9` would otherwise be honoured).
	const bounded = (value: unknown, ceiling: number): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 1
			? Math.min(Math.floor(value), ceiling)
			: undefined;

	const maxRounds = bounded(record.maxRounds, 1_000);
	if (maxRounds !== undefined) out.maxRounds = maxRounds;

	const maxStrikes = bounded(record.maxStrikes, 100);
	if (maxStrikes !== undefined) out.maxStrikes = maxStrikes;

	return out;
}

export function mergeConfig(raw: unknown): LoopConfig {
	return { ...DEFAULTS, ...coerce(raw) };
}

export function loadConfig(path: string): LoopConfig {
	try {
		return mergeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// A fresh copy: the shared object must never be mutable by a caller.
		return { ...DEFAULTS };
	}
}
