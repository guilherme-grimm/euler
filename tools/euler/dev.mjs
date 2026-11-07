#!/usr/bin/env node
/**
 * Euler dev supervisor: restart-from-source hot reload.
 *
 * The TUI cannot reload modules in place (the bundle is loaded once), so "hot reload" here means
 * restart the process from source and resume the session. The source resolver runs TypeScript
 * directly, so a save costs about a second instead of a build.
 *
 * Usage:
 *   npm run dev                        # reload on changes under packages/{coding-agent,tui}/src
 *   npm run dev -- --session-dir /tmp  # extra args go to euler
 *   EULER_DEV_SESSION=my-dev npm run dev   # pin a stable session via --session-id
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resolverUrl = pathToFileURL(
	resolve(repoRoot, "packages/coding-agent/src/experimental/source-resolver.ts"),
).href;
const cliPath = resolve(repoRoot, "packages/coding-agent/src/cli.ts");
const watchedRoots = ["packages/coding-agent/src", "packages/tui/src"].map((path) => resolve(repoRoot, path));
const IGNORED = /(^|[/\\])(dist|node_modules|\.git)([/\\]|$)|\.test\.ts$/;
const DEBOUNCE_MS = 250;
const CRASH_WINDOW_MS = 2_500;

const forwarded = process.argv.slice(2);
const pinnedSession = process.env.EULER_DEV_SESSION;
const useContinue = forwarded.every((arg) => !arg.startsWith("--session") && arg !== "-r" && arg !== "--resume");

/** One dim log line per event; the app itself owns the screen. */
function log(message) {
	process.stderr.write(`\u001b[2m[euler dev]\u001b[0m ${message}\n`);
}

let child;
let restarting = false;
let pendingRestart = false;
let startedAt = 0;
let shuttingDown = false;

function argsForRun() {
	const args = ["--import", resolverUrl, cliPath, "--ui", "euler"];
	if (pinnedSession) args.push("--session-id", pinnedSession);
	else if (useContinue) args.push("--continue");
	return [...args, ...forwarded];
}

function start() {
	startedAt = Date.now();
	child = spawn(process.execPath, argsForRun(), {
		cwd: process.cwd(),
		stdio: "inherit",
		env: { ...process.env, EULER_DEV: "1" },
	});
	child.on("exit", (code, signal) => {
		const lived = Date.now() - startedAt;
		child = undefined;

		if (shuttingDown) process.exit(code ?? 0);
		// Our own reload: kill() was called from restart(), so come straight back.
		if (restarting) {
			restarting = false;
			start();
			return;
		}
		if (pendingRestart) {
			pendingRestart = false;
			start();
			return;
		}
		// Left on its own: `:q` (0) or ctrl+c (signal) means the supervisor is done too.
		if (code === 0 || signal !== null) process.exit(code ?? 0);
		if (lived < CRASH_WINDOW_MS) {
			log("euler exited early; fix the error and save to retry (ctrl+c to stop)");
			return;
		}
		process.exit(code ?? 0);
	});
	child.on("error", (error) => {
		log(`failed to start: ${error.message}`);
		process.exit(1);
	});
}

function restart(reason) {
	if (!child) {
		// Nothing running (previous crash): boot on the next change.
		pendingRestart = false;
		start();
		return;
	}
	restarting = true;
	log(`reloading (${reason})`);
	const exiting = child;
	exiting.kill("SIGTERM");
	// If the app does not release the terminal in time, escalate.
	setTimeout(() => {
		if (exiting.exitCode === null && exiting.signalCode === null) exiting.kill("SIGKILL");
	}, 4_000).unref();
}

let debounce;
function onChange(filename) {
	if (typeof filename === "string" && IGNORED.test(filename)) return;
	clearTimeout(debounce);
	debounce = setTimeout(() => {
		if (restarting) {
			pendingRestart = true;
			return;
		}
		restart(filename ? `${filename} changed` : "change detected");
	}, DEBOUNCE_MS);
}

for (const root of watchedRoots) {
	try {
		watch(root, { recursive: true }, (_event, filename) => onChange(filename));
	} catch (error) {
		log(`cannot watch ${root}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		shuttingDown = true;
		child?.kill(signal);
		setTimeout(() => process.exit(0), 1_500).unref();
	});
}

log(`watching packages/{coding-agent,tui}/src · ${pinnedSession ? `session ${pinnedSession}` : "session: continue"}`);
start();
