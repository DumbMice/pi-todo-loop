/**
 * Documentation consistency.
 *
 * The ruledoc is prose in four files and nothing else can notice a drift, so
 * these cases check the parts a reader would trust: the tested-version table,
 * the invariant map, the reason table and the configuration table — against the
 * code where the code is the source of truth.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { PI_API_SNAPSHOT } from "../src/index.ts";
import { DEFAULTS } from "../src/loop.ts";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const README = read("../README.md");
const AGENTS = read("../AGENTS.md");
const ALIGNMENT = read("../docs/pi-api-alignment.md");
const CHANGELOG = read("../CHANGELOG.md");
const PACKAGE = JSON.parse(read("../package.json"));
const VERIFIED_DATE = "2026-11-04";
const TESTED_RPIV_TODO = "2.15.0";

const isSeparator = (row: string): boolean =>
	row
		.split("|")
		.slice(1, -1)
		.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));

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
	assert.ok(CHANGELOG.includes(`## [${PACKAGE.version}]`), `CHANGELOG has no entry for ${PACKAGE.version}`);
});

test("every README link target inside the repository exists", () => {
	const links = [...README.matchAll(/\]\((?!https?:)([^)#]+)[^)]*\)/g)].map((match) => match[1]);
	assert.ok(links.length > 0, "expected relative links in the README");
	for (const link of links) {
		assert.doesNotThrow(() => read(`../${link}`), `README links to a missing file: ${link}`);
	}
});

test("every test name the invariant map cites actually exists", () => {
	const titles = new Set<string>();
	for (const file of readdirSync(new URL("../test/", import.meta.url))) {
		if (!file.endsWith(".test.ts")) continue;
		for (const match of read(`../test/${file}`).matchAll(/test\("([^"]+)"/g)) titles.add(match[1]);
	}

	const map = AGENTS.slice(AGENTS.indexOf("## Invariant → test map"), AGENTS.indexOf("## Adding or changing"));
	const rows = map
		.split("\n")
		.filter((line) => line.startsWith("|") && !line.startsWith("| Invariant") && !isSeparator(line));
	// Pinned exactly: a row that disappears must fail here, not merely lower the count.
	assert.equal(rows.length, 31, `invariant map row count changed (${rows.length}); update this number when you add a row`);

	const cited: string[] = [];
	for (const row of rows) {
		// A row that loses a pipe must fail here, not quietly drop out of the check.
		assert.ok(row.includes("`"), `invariant-map row cites no test: ${row.slice(0, 80)}`);
		const cells = row.split("|");
		const cell = cells.length >= 4 ? cells[2] : cells.slice(1).join("|");
		cited.push(...[...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
	}

	const missing = cited.filter((name) => !titles.has(name));
	assert.deepEqual(missing, [], `invariant map cites tests that do not exist: ${missing.join(", ")}`);
});

test("every stop reason the code can report appears in the README table", () => {
	// Only lines that produce a reason: `reason:`, `state.reason =`, `stop(...)`,
	// `resetRun(...)`. UI notices are not reasons and must not be required here.
	const lines = [read("../src/loop.ts"), read("../src/index.ts")]
		.join("\n")
		.split("\n")
		.filter((line) => /reason|resetRun\(|stop\([A-Za-z]+,/.test(line));

	const fragments = new Set<string>();
	for (const line of lines) {
		for (const match of line.matchAll(/`([^`]*\$\{[^`]*)`/g)) {
			const template = match[1];
			const head = template.split("${")[0].trim();
			if (head.length >= 4) fragments.add(head);
			const tail = template.slice(template.lastIndexOf("}") + 1).trim();
			if (tail.length >= 4) fragments.add(tail);
		}
		for (const match of line.matchAll(/"([^"]{6,})"/g)) fragments.add(match[1]);
	}
	fragments.delete("");
	assert.ok(fragments.size >= 8, `expected several reason fragments, found ${fragments.size}`);

	const missing = [...fragments].filter((fragment) => !README.includes(fragment));
	assert.deepEqual(missing, [], `README reason table is missing: ${missing.join(" | ")}`);
});

test("the README configuration table states every default, not just the numbers", () => {
	for (const [key, value] of Object.entries(DEFAULTS)) {
		assert.ok(
			README.includes(`| \`${key}\` | \`${value}\` |`),
			`README default for ${key} does not match DEFAULTS (${String(value)})`,
		);
	}
});

test("clamp ceilings in the README match the ones the code enforces, per key", () => {
	const config = read("../src/config.ts");
	const clamps = [...config.matchAll(/bounded\(record\.(\w+), ([0-9_]+)\)/g)].map((match) => ({
		key: match[1],
		ceiling: match[2].replace(/_/g, ""),
	}));
	assert.equal(clamps.length, 3, `expected three clamp ceilings, found ${clamps.length}`);
	for (const { key, ceiling } of clamps) {
		assert.ok(
			README.includes(`\`${key}\` ≤ ${ceiling}`),
			`README does not state \`${key}\` ≤ ${ceiling}`,
		);
	}
});
