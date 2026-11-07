#!/usr/bin/env node
/**
 * Upstream drift gate for the euler fork.
 *
 * Euler patches a handful of upstream files and depends on a set of upstream APIs. Blindly
 * merging a new pi release is how a fork quietly breaks. This gate classifies every upstream
 * change since the merge base:
 *
 *   safe      nothing euler relies on moved
 *   review    upstream edited a file euler patches; a human must port the change
 *   blocked   a signature/export euler imports disappeared or renamed
 *
 * Usage:
 *   node tools/euler/upstream-gate.mjs                 # fetch upstream, diff, report
 *   node tools/euler/upstream-gate.mjs --no-fetch      # offline / CI with a pre-fetched remote
 *   node tools/euler/upstream-gate.mjs --base v1.5.0   # diff against a tag instead of upstream/main
 *   node tools/euler/upstream-gate.mjs --json          # machine-readable report on stdout
 *
 * Exit codes: 0 safe, 1 needs a port (review), 2 blocked.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const seams = JSON.parse(readFileSync(resolve(here, "seams.json"), "utf8"));

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const flagValue = (flag) => {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
};

const upstreamRemote = seams.upstream.remote;
const branch = seams.upstream.branch;
const base = flagValue("--base") ?? `${upstreamRemote}/${branch}`;
const jsonOnly = hasFlag("--json");

function git(...gitArgs) {
	return execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function tryGit(...gitArgs) {
	try {
		return git(...gitArgs);
	} catch {
		return undefined;
	}
}

function fail(message) {
	console.error(`upstream-gate: ${message}`);
	process.exit(2);
}

if (!tryGit("remote", "get-url", upstreamRemote)) {
	fail(`git remote "${upstreamRemote}" is missing. Add it with:\n  git remote add ${upstreamRemote} https://github.com/${seams.upstream.repo}`);
}

if (!hasFlag("--no-fetch")) {
	process.stderr.write(`fetching ${upstreamRemote}...\n`);
	const fetch = tryGit("fetch", "--quiet", upstreamRemote, branch, "--tags");
	if (fetch === undefined) fail(`could not fetch ${upstreamRemote}/${branch}`);
}

const target = tryGit("rev-parse", "--verify", base)?.trim();
if (!target) fail(`unknown base ref "${base}"`);

const mergeBase = git("merge-base", "HEAD", target).trim();
const range = `${mergeBase}..${target}`;
const changedFiles = git("diff", "--name-only", range).trim().split("\n").filter(Boolean);
const commits = git("rev-list", "--count", range).trim();

/** Files euler owns outright: upstream never has them, so they are informational only. */
function eulerOwned(path) {
	return path.startsWith("packages/coding-agent/src/modes/euler/") || path.startsWith("tools/euler/");
}

const patched = new Set(seams.patched);
const touchedPatched = changedFiles.filter((file) => patched.has(file));
const touchedEulerOwned = changedFiles.filter(eulerOwned);
const otherChanges = changedFiles.filter((file) => !patched.has(file) && !eulerOwned(file));

function showAt(ref, path) {
	return tryGit("show", `${ref}:${path}`);
}

/** Declarations a module exports, used to detect renames that keep the file but drop a symbol. */
function exportedSymbols(source) {
	const symbols = new Set();
	// Re-exports (`export { A, type B } from "./x.ts"`) carry most of the public surface.
	for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
		for (const entry of match[1].split(",")) {
			const name = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
			if (name) symbols.add(name.trim());
		}
	}
	const patterns = [
		/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
		/export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/g,
		/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g,
		/export\s+(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) symbols.add(match[1]);
	}
	return symbols;
}

const missingSignatures = [];
for (const check of seams.signatures) {
	const before = showAt(mergeBase, check.file);
	const after = showAt(target, check.file);
	if (after === undefined) {
		missingSignatures.push({ ...check, reason: "file no longer exists upstream" });
		continue;
	}
	if (!after.includes(check.contains)) {
		missingSignatures.push({ ...check, reason: `"${check.contains}" disappeared`, hadBefore: before?.includes(check.contains) ?? false });
	}
}

const missingExports = [];
for (const group of seams.exports) {
	const before = showAt(mergeBase, group.file);
	const after = showAt(target, group.file);
	if (after === undefined) {
		for (const symbol of group.symbols) missingExports.push({ file: group.file, symbol, reason: "file no longer exists" });
		continue;
	}
	const afterSymbols = exportedSymbols(after);
	for (const symbol of group.symbols) {
		if (!afterSymbols.has(symbol)) {
			const existedBefore = before ? exportedSymbols(before).has(symbol) : false;
			missingExports.push({ file: group.file, symbol, reason: existedBefore ? "export removed or renamed" : "export missing" });
		}
	}
}

const blocked = missingSignatures.length > 0 || missingExports.length > 0;
const needsPort = touchedPatched.length > 0;
const status = blocked ? "blocked" : needsPort ? "review" : "safe";

const report = {
	status,
	upstream: seams.upstream,
	base,
	mergeBase,
	commitsSinceMergeBase: Number(commits),
	changedFileCount: changedFiles.length,
	touchedPatchedFiles: touchedPatched,
	missingSignatures,
	missingExports,
	otherChanges,
	contractTests: seams.contractTests,
};

const artifactsDir = resolve(repoRoot, ".artifacts");
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(resolve(artifactsDir, "upstream-gate.json"), `${JSON.stringify(report, null, 2)}\n`);

if (jsonOnly) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const line = (label, value) => console.log(`${label.padEnd(18)} ${value}`);
	line("status", status.toUpperCase());
	line("upstream", `${seams.upstream.repo}@${base}`);
	line("commits", commits);
	line("files changed", changedFiles.length);

	if (touchedPatched.length > 0) {
		console.log("\nUpstream edited files euler patches:");
		for (const file of touchedPatched) console.log(`  ~ ${file}`);
		console.log("  Port these by hand, then rerun the contract tests.");
	}
	if (missingSignatures.length > 0) {
		console.log("\nSignatures euler relies on are gone:");
		for (const item of missingSignatures) console.log(`  ✗ ${item.file}: ${item.reason}`);
	}
	if (missingExports.length > 0) {
		console.log("\nExports euler relies on are gone:");
		for (const item of missingExports) console.log(`  ✗ ${item.file}: ${item.symbol} (${item.reason})`);
	}
	if (touchedEulerOwned.length > 0) {
		console.log("\nUpstream also ships files euler owns (informational):");
		for (const file of touchedEulerOwned) console.log(`  = ${file}`);
	}
	if (status === "safe") {
		console.log("\nNo euler seams moved. Merge, then run:");
		console.log(`  npx vitest run ${seams.contractTests.join(" ")}`);
	}
	console.log(`\nreport: .artifacts/upstream-gate.json`);
}

process.exit(blocked ? 2 : needsPort ? 1 : 0);
