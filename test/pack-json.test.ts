/**
 * `npm pack --json` changed shape between majors: npm 10 returns an array, npm 11 an
 * object keyed by package name. The publish workflow upgrades npm, and the first CI run
 * failed exactly here, so both shapes are pinned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { firstPack, packEntries } from "../scripts/pack-json.mjs";

const record = { name: "@dumbmice/pi-todo-loop", version: "0.1.0", filename: "dumbmice-pi-todo-loop-0.1.0.tgz", files: [] };

test("npm 10 shape: an array of records", () => {
	assert.deepEqual(packEntries([record]), [record]);
	assert.equal(firstPack([record])?.filename, record.filename);
});

test("npm 11 shape: an object keyed by package name", () => {
	assert.deepEqual(packEntries({ "@dumbmice/pi-todo-loop": record }), [record]);
	assert.equal(firstPack({ "@dumbmice/pi-todo-loop": record })?.filename, record.filename);
});

test("anything else is empty, not a throw", () => {
	for (const value of [null, undefined, "x", 42, {}]) assert.deepEqual(packEntries(value), []);
	assert.equal(firstPack(null), undefined);
});
