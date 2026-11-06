/**
 * Config coercion: a broken file must never fail a turn, and a hostile value must
 * never defeat the cap it is meant to configure. These tests lived in the renderer
 * suite before the state block was removed; they outlived it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeConfig } from "../src/config.ts";
import { DEFAULTS } from "../src/loop.ts";

test("missing or malformed config falls back to defaults", () => {
	for (const raw of [undefined, null, 3, "x", [], {}]) {
		assert.deepEqual(mergeConfig(raw), DEFAULTS);
	}
});

test("valid fields override, invalid ones are ignored", () => {
	const merged = mergeConfig({ maxRounds: 3, maxStrikes: 5, nonsense: true });
	assert.equal(merged.maxRounds, 3);
	assert.deepEqual(Object.keys(merged).sort(), ["maxRounds"], "removed keys are not resurrected");
});

test("numbers are clamped so a typo cannot defeat the cap it configures", () => {
	assert.equal(mergeConfig({ maxRounds: 1e9 }).maxRounds, 1_000);
});

test("a value below 1 is treated as invalid, not as zero", () => {
	// "0 rounds" would mean "never continue", which is not what a typo should buy.
	assert.equal(mergeConfig({ maxRounds: 0 }).maxRounds, DEFAULTS.maxRounds);
	assert.equal(mergeConfig({ maxRounds: 2.9 }).maxRounds, 2, "floors to an integer");
});

test("maxRounds accepts an explicit null, and a typo stays unlimited", () => {
	// The default is "no cap", so the failure direction of a bad value is the expensive one:
	// it must never invent a cap, and it must never become 0.
	assert.equal(mergeConfig({ maxRounds: null }).maxRounds, null);
	assert.equal(mergeConfig({ maxRounds: -3 }).maxRounds, null);
	assert.equal(mergeConfig({ maxRounds: "12" }).maxRounds, null, "a quoted number is not a number");
	assert.equal(mergeConfig({ maxRounds: 12 }).maxRounds, 12, "but a real number is honoured");
});
