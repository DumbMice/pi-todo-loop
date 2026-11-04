/**
 * Shared harness for the hook-level suites: a stub `pi`, a mutable branch, and a
 * scripted context. No model, no network, no real session.
 *
 * Kept out of `*.test.ts` so both `index.test.ts` and `state-machine.test.ts` can
 * drive the same object and `test/docs.test.ts` does not count these helpers as
 * tests.
 */

import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import todoLoop, { MARKER_TYPE } from "../../src/index.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

export interface Harness {
	/** The branch `ctx.sessionManager.getBranch()` returns. Mutate it to script state. */
	branch: unknown[];
	handlers: Record<string, Handler[]>;
	commands: Record<string, { handler: Handler }>;
	notices: string[];
	ctx: any;
	options: { dir: string; configPath: string; killSwitchGlobal: string; killSwitchLocal: string };
}

export const MARKER = MARKER_TYPE;

export const task = (id: number, status: string, subject = `task ${id}`): Record<string, unknown> => ({
	id,
	status,
	subject,
});

/** A branch with one human message and one todo snapshot. */
export function branchWith(tasks: unknown[]): unknown[] {
	return [
		{ type: "message", id: "user-1", message: { role: "user", content: "go" } },
		{ type: "custom", customType: "rpiv-todo-state", id: "todo-1", data: { tasks } },
	];
}

/** A marker as pi projects it into `event.messages`. */
export const marker = (): Record<string, unknown> => ({
	role: "user",
	customType: MARKER_TYPE,
	content: "<todo_loop_continue/>",
});

export function harness(branch: unknown[], config?: Record<string, unknown>): Harness {
	const dir = mkdtempSync(join(tmpdir(), "todo-loop-test-"));
	const configPath = join(dir, "todo-loop.json");
	if (config !== undefined) writeFileSync(configPath, JSON.stringify(config));

	const notices: string[] = [];
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: Handler }> = {};

	const pi = {
		on(name: string, handler: Handler) {
			(handlers[name] ??= []).push(handler);
		},
		registerCommand(name: string, definition: { handler: Handler }) {
			commands[name] = definition;
		},
	};

	const ctx = {
		cwd: dir,
		sessionManager: { getBranch: () => branch },
		ui: { notify: (message: string) => notices.push(message) },
	};

	const options = {
		dir,
		configPath,
		killSwitchGlobal: join(dir, "off-global"),
		killSwitchLocal: ".pi/off-local",
	};

	todoLoop(pi, options);
	return { branch, handlers, commands, notices, ctx, options };
}

export async function run(h: Harness, event: string, payload: any): Promise<any> {
	let result: any;
	for (const handler of h.handlers[event] ?? []) result = await handler(payload, h.ctx);
	return result;
}

/** Append a task-state snapshot to the branch, as a real todo tool call would. */
export function setTasks(h: Harness, tasks: unknown[]): void {
	h.branch.push({
		type: "custom",
		customType: "rpiv-todo-state",
		id: `todo-${h.branch.length}`,
		data: { tasks },
	});
}

/** Append a human message, which changes the anchor. */
export function setHuman(h: Harness, text = "next"): void {
	h.branch.push({
		type: "message",
		id: `user-${h.branch.length}`,
		message: { role: "user", content: text },
	});
}

export function killSwitch(h: Harness, on: boolean): void {
	const path = h.options.killSwitchGlobal;
	if (on) writeFileSync(path, "");
	else if (existsSync(path)) unlinkSync(path);
}

export function projectKillSwitch(h: Harness, on: boolean): void {
	const path = join(h.ctx.cwd, ".pi", "off-local");
	if (on) {
		mkdirSync(join(h.ctx.cwd, ".pi"), { recursive: true });
		writeFileSync(path, "");
	} else if (existsSync(path)) {
		unlinkSync(path);
	}
}
