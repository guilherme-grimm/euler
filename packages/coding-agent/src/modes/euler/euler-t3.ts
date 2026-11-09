/**
 * T3 Code orchestration adapter.
 *
 * T3 owns worktrees, provider/model routing and PRs. Its host CLI is the seam: `t3 thread … --json`
 * needs no sign-in on the machine running the server, so Euler can start and steer background
 * threads without speaking T3's private Effect-RPC protocol. Polling `list`/`show` is enough for
 * the rail; the streaming WebSocket client is deliberately out of scope until polling hurts.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface T3Thread {
	threadId: string;
	title: string;
	status: string;
	provider?: string;
	model?: string;
	branch?: string;
	worktreePath?: string;
	link?: string;
	updatedAt?: string;
}

export interface T3Snapshot {
	available: boolean;
	error?: string;
	threads: T3Thread[];
}

export interface T3Message {
	role: string;
	text: string;
}

export interface T3ThreadDetail {
	thread: T3Thread;
	messages: T3Message[];
}

export interface T3StartOptions {
	worktree?: string;
	branch?: string;
	provider?: string;
	model?: string;
	title?: string;
}

/** Injectable command runner so tests never spawn `t3`. */
export type T3Run = (args: readonly string[]) => Promise<string>;

const COMMAND_TIMEOUT_MS = 10_000;

function discoverCommand(): string {
	const explicit = process.env.EULER_T3_BIN ?? process.env.T3_BIN;
	if (explicit) return explicit;
	for (const candidate of [
		join(homedir(), ".t3", "bin", "t3"),
		join(homedir(), ".local", "bin", "t3"),
		"/usr/local/bin/t3",
		"/opt/homebrew/bin/t3",
	]) {
		if (existsSync(candidate)) return candidate;
	}
	// Let PATH resolution fail with ENOENT so the rail can say "not installed".
	return "t3";
}

function mapError(detail: string, code?: string): string {
	if (code === "ENOENT") return "t3 not installed";
	if (/No running T3 Code server|Could not reach/i.test(detail)) {
		return "t3 server not running · t3 service install";
	}
	const first = detail.split("\n").find((line) => line.trim().length > 0) ?? "t3 command failed";
	return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

function defaultRun(command: string, cwd: string): T3Run {
	return (args) =>
		new Promise((resolve, reject) => {
			execFile(
				command,
				[...args],
				{ cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
				(error, stdout, stderr) => {
					if (error) {
						const detail = String(stderr || stdout || error.message).trim();
						reject(new Error(mapError(detail, (error as { code?: string }).code)));
						return;
					}
					resolve(stdout);
				},
			);
		});
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** T3's list payload is an array; tolerate an envelope if a release wraps it. */
function parseThread(value: unknown): T3Thread | undefined {
	const row = record(value);
	if (!row) return undefined;
	const threadId = text(row.threadId) ?? text(row.id);
	if (!threadId) return undefined;
	return {
		threadId,
		title: text(row.title) ?? threadId,
		status: text(row.status) ?? "unknown",
		provider: text(row.providerInstanceId) ?? text(row.provider),
		model: text(row.model),
		branch: text(row.branch),
		worktreePath: text(row.worktreePath),
		link: text(row.link),
		updatedAt: text(row.updatedAt) ?? text(row.createdAt),
	};
}

export function parseThreads(payload: unknown): T3Thread[] {
	const rows = Array.isArray(payload)
		? payload
		: Array.isArray(record(payload)?.threads)
			? (record(payload)?.threads as unknown[])
			: [];
	return rows.flatMap((value) => {
		const thread = parseThread(value);
		return thread ? [thread] : [];
	});
}

export function parseThreadDetail(payload: unknown): T3ThreadDetail | undefined {
	const root = record(payload);
	const thread = parseThread(root?.thread);
	if (!thread) return undefined;
	const rows = Array.isArray(root?.messages) ? root.messages : [];
	const messages = rows.flatMap((value): T3Message[] => {
		const row = record(value);
		if (!row) return [];
		return [{ role: text(row.role) ?? "unknown", text: text(row.text) ?? "" }];
	});
	return { thread, messages };
}

/** `running`, `preparing`, `queued`… anything the UI should animate. */
export function isT3Live(status: string): boolean {
	return !["completed", "failed", "cancelled", "settled", "idle"].includes(status);
}

export class T3Client {
	private readonly cwd: string;
	private readonly command: string;
	private readonly run: T3Run;

	constructor(options: { cwd: string; command?: string; run?: T3Run }) {
		this.cwd = options.cwd;
		this.command = options.command ?? discoverCommand();
		this.run = options.run ?? defaultRun(this.command, options.cwd);
	}

	private async exec(args: readonly string[]): Promise<unknown> {
		let stdout: string;
		try {
			stdout = await this.run(args);
		} catch (error) {
			throw new Error(mapError(error instanceof Error ? error.message : String(error)));
		}
		try {
			return JSON.parse(stdout) as unknown;
		} catch {
			throw new Error("t3 returned non-JSON output");
		}
	}

	async list(): Promise<T3Snapshot> {
		try {
			return {
				available: true,
				threads: parseThreads(await this.exec(["thread", "list", "--project", this.cwd, "--json"])),
			};
		} catch (error) {
			return {
				available: false,
				error: error instanceof Error ? error.message : String(error),
				threads: [],
			};
		}
	}

	async start(message: string, options: T3StartOptions = {}): Promise<string> {
		const args = ["thread", "start", this.cwd, message, "--json"];
		if (options.worktree) args.push("--worktree", options.worktree);
		if (options.branch) args.push("--branch", options.branch);
		if (options.provider) args.push("--provider", options.provider);
		if (options.model) args.push("--model", options.model);
		if (options.title) args.push("--title", options.title);
		const payload = record(await this.exec(args));
		const threadId = text(payload?.threadId);
		if (!threadId) throw new Error("t3 did not return a thread id");
		return threadId;
	}

	async send(threadId: string, message: string): Promise<string> {
		const payload = record(await this.exec(["thread", "send", threadId, message, "--json"]));
		const failure = text(payload?.error);
		if (failure) throw new Error(failure);
		const reply = text(payload?.reply);
		return reply && reply.trim().length > 0 ? reply : (text(payload?.status) ?? "sent");
	}

	async show(threadId: string, messages = 8): Promise<T3ThreadDetail> {
		const detail = parseThreadDetail(
			await this.exec(["thread", "show", threadId, "--json", "--messages", String(messages)]),
		);
		if (!detail) throw new Error("t3 returned no thread");
		return detail;
	}
}
