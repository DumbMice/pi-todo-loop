#!/usr/bin/env node
/**
 * Verify the published tarball actually contains what the package promises.
 *
 * `npm pack --dry-run` prints a file list and exits 0 even when `files` matches
 * nothing, so dropping "src" from the manifest used to pass CI while shipping a
 * package whose `pi.extensions` entry point does not exist. This asserts the
 * entry point, the docs and the licence are in the tarball.
 */

import { execFileSync } from "node:child_process";

const REQUIRED = [
	"src/index.ts",
	"src/loop.ts",
	"src/state.ts",
	"src/inject.ts",
	"src/config.ts",
	"docs/pi-api-alignment.md",
	"README.md",
	"AGENTS.md",
	"CONTRIBUTING.md",
	"CHANGELOG.md",
	"LICENSE",
	"tsconfig.json",
];

const FORBIDDEN = ["test", "test/", ".github", "node_modules", "package-lock.json"];

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const [tarball] = JSON.parse(raw);
const files = new Set(tarball.files.map((file) => file.path));

const missing = REQUIRED.filter((path) => !files.has(path));
if (missing.length > 0) {
	console.error(`pack check failed — missing from the tarball:\n  ${missing.join("\n  ")}`);
	const sample = [...files].slice(0, 20).join("\n  ");
	console.error(`\nfiles present (${files.size}):\n  ${sample}`);
	process.exit(1);
}

const entry = JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json').pi)"], { encoding: "utf8" }));
for (const declared of entry.extensions ?? []) {
	const path = declared.replace(/^\.\//, "");
	if (!files.has(path)) {
		console.error(`pack check failed — pi.extensions declares ${path}, which is not in the tarball`);
		process.exit(1);
	}
}

const leaked = [...files].filter((path) => FORBIDDEN.some((bad) => path === bad || path.startsWith(`${bad}/`)));
if (leaked.length > 0) {
	console.error(`pack check failed — dev-only paths in the tarball:\n  ${leaked.join("\n  ")}`);
	process.exit(1);
}

console.log(`pack ok: ${files.size} files, entry point and docs present, no dev paths`);
