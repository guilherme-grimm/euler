/**
 * Code view and working-tree diff data for the Euler viewer.
 *
 * Deliberately read-only and local: the viewer shows files and `git diff HEAD`, it never edits or
 * stages. Paths are resolved against the session cwd; the cursor helper only accepts a candidate
 * that actually exists, so prose that looks like a filename does not open a bogus view.
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getLanguageFromPath, highlightCode, theme } from "../interactive/theme/theme.ts";

export interface CodeTarget {
	path: string;
	line?: number;
}

export interface CodeView {
	title: string;
	lines: string[];
	/** 1-based line to centre when the viewer opens. */
	focusLine?: number;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_VIEW_LINES = 5_000;

/** Resolve `path`, `path:line`, or a quoted path against the session cwd. */
export function resolveCodePath(cwd: string, input: string): CodeTarget | undefined {
	const trimmed = input
		.trim()
		.replace(/^['"`]/, "")
		.replace(/['"`]$/, "");
	if (trimmed.length === 0) return undefined;
	const match = /^(.*):(\d+)$/.exec(trimmed);
	const raw = match ? (match[1] ?? "") : trimmed;
	const line = match ? Math.max(1, Number(match[2])) : undefined;
	const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
	try {
		if (!statSync(path).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return { path, line };
}

/** Nearest existing path-like token on a rendered transcript line. */
export function detectPathAt(text: string, cwd: string): CodeTarget | undefined {
	const candidates = text.match(/(?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]+(?::\d+)?/g) ?? [];
	for (const candidate of [...candidates].reverse()) {
		const target = resolveCodePath(cwd, candidate);
		if (target) return target;
	}
	return undefined;
}

/** Numbered, syntax-highlighted file content. */
export function loadFileView(cwd: string, target: CodeTarget): CodeView {
	const stat = statSync(target.path);
	if (stat.size > MAX_FILE_BYTES) {
		throw new Error(`file too large for the viewer (${Math.round(stat.size / 1024)} KiB)`);
	}
	const content = readFileSync(target.path, "utf8");
	const highlighted = highlightCode(content, getLanguageFromPath(target.path));
	const total = highlighted.length;
	const width = String(total).length;
	let lines = highlighted.map((line, index) => `${theme.fg("dim", `${String(index + 1).padStart(width)} │`)} ${line}`);
	if (lines.length > MAX_VIEW_LINES) {
		lines = [...lines.slice(0, MAX_VIEW_LINES), theme.fg("dim", `… ${total - MAX_VIEW_LINES} more lines`)];
	}
	const path = relative(cwd, target.path) || target.path;
	return {
		title: `${path}${target.line ? `:${target.line}` : ""}`,
		lines,
		focusLine: target.line,
	};
}

/** Unified diff colouring: green adds, red removes, accent hunks, dim file headers. */
export function formatDiff(diff: string): string[] {
	const lines: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ")) continue;
		if (line.startsWith("+++ ")) {
			lines.push(theme.bold(theme.fg("text", line.slice(4).replace(/^b\//, ""))));
			continue;
		}
		if (line.startsWith("@@")) {
			lines.push(theme.fg("accent", line));
			continue;
		}
		if (line.startsWith("+")) {
			lines.push(theme.fg("success", line));
			continue;
		}
		if (line.startsWith("-")) {
			lines.push(theme.fg("error", line));
			continue;
		}
		if (line.startsWith("\\")) {
			lines.push(theme.fg("dim", line));
			continue;
		}
		lines.push(theme.fg("muted", line));
	}
	while (lines.at(-1) === "") lines.pop();
	return lines.slice(0, MAX_VIEW_LINES);
}

function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error) {
					const detail =
						String(stderr || error.message)
							.trim()
							.split("\n")[0] ?? "git failed";
					reject(new Error(detail));
					return;
				}
				resolvePromise(stdout);
			},
		);
	});
}

/** Working-tree diff against HEAD, all files or one path. */
export async function loadDiffView(cwd: string, path?: string): Promise<CodeView> {
	const pathspec = path ? [relative(cwd, path)] : [];
	const diff = await runGit(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--", ...pathspec]);
	if (diff.trim().length === 0) {
		throw new Error(path ? `no changes in ${relative(cwd, path)}` : "no changes against HEAD");
	}
	return {
		title: path ? `diff · ${relative(cwd, path)}` : "diff · working tree",
		lines: formatDiff(diff),
	};
}
