/**
 * Read `npm pack --json`, whose shape changed between npm majors.
 *
 * npm 10 returns an array of tarball records; npm 11 returns an object keyed by
 * package name. The publish workflow upgrades npm, so both shapes appear in practice
 * and code that destructures `[0]` breaks on the newer one.
 */

import { execFileSync } from "node:child_process";

/** Normalise either shape to a list of tarball records. */
export function packEntries(value) {
	if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === "object");
	if (value && typeof value === "object") {
		return Object.values(value).filter((entry) => entry && typeof entry === "object");
	}
	return [];
}

/** The first packed record, or undefined. */
export function firstPack(value) {
	return packEntries(value)[0];
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
	const record = firstPack(JSON.parse(raw));
	if (!record || typeof record.filename !== "string") {
		console.error("pack-json: npm pack produced no tarball record");
		process.exit(1);
	}
	console.log(record.filename);
}
