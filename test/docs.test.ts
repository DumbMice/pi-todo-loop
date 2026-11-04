/**
 * Documentation consistency.
 *
 * The tested-version discipline is prose in four files and nothing else can
 * notice a drift, so these cases pin the parts a reader would trust: the pi
 * snapshot constant, the verification date, the tested rpiv-todo version, and
 * the CHANGELOG entry for the published version.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PI_API_SNAPSHOT } from "../src/index.ts";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const README = read("../README.md");
const AGENTS = read("../AGENTS.md");
const ALIGNMENT = read("../docs/pi-api-alignment.md");
const CHANGELOG = read("../CHANGELOG.md");
const PACKAGE = JSON.parse(read("../package.json"));
const VERIFIED_DATE = "2026-11-04";
const TESTED_RPIV_TODO = "2.15.0";

test("the pi snapshot constant appears in the README and the register", () => {
	assert.ok(PI_API_SNAPSHOT.length > 0);
	assert.match(README, new RegExp(PI_API_SNAPSHOT.replace(/\./g, "\\.")));
	assert.match(ALIGNMENT, new RegExp(PI_API_SNAPSHOT.replace(/\./g, "\\.")));
	assert.ok(AGENTS.includes("PI_API_SNAPSHOT"), "AGENTS.md must name the constant it keeps in step");
});

test("the verification date appears in the README and the register", () => {
	assert.ok(README.includes(VERIFIED_DATE), "README loses the last-verified date");
	assert.ok(ALIGNMENT.includes(VERIFIED_DATE), "register loses the last-verified date");
});

test("the tested rpiv-todo version is recorded in both places", () => {
	assert.ok(README.includes(TESTED_RPIV_TODO));
	assert.ok(ALIGNMENT.includes(TESTED_RPIV_TODO));
});

test("the CHANGELOG documents the version in package.json", () => {
	assert.ok(
		CHANGELOG.includes(`## [${PACKAGE.version}]`),
		`CHANGELOG has no entry for ${PACKAGE.version}`,
	);
});

test("every README link target inside the repository exists", () => {
	const links = [...README.matchAll(/\]\((?!https?:)([^)#]+)[^)]*\)/g)].map((match) => match[1]);
	assert.ok(links.length > 0, "expected relative links in the README");
	for (const link of links) {
		assert.doesNotThrow(() => read(`../${link}`), `README links to a missing file: ${link}`);
	}
});
