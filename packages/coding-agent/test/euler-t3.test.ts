import assert from "node:assert";
import { describe, it } from "vitest";
import { isT3Live, parseThreadDetail, parseThreads, T3Client } from "../src/modes/euler/euler-t3.ts";

describe("t3 adapter", () => {
	it("maps thread list rows", () => {
		const threads = parseThreads([
			{
				threadId: "mcp:1",
				title: "add retry",
				status: "running",
				branch: "feat/retry",
				providerInstanceId: "pi",
				model: "opencode-go/deepseek-v4.1-flash",
				link: "http://127.0.0.1:3773/thread",
				updatedAt: "2026-11-09T16:51:58.631Z",
			},
		]);
		assert.deepEqual(threads[0], {
			threadId: "mcp:1",
			title: "add retry",
			status: "running",
			provider: "pi",
			model: "opencode-go/deepseek-v4.1-flash",
			branch: "feat/retry",
			worktreePath: undefined,
			link: "http://127.0.0.1:3773/thread",
			updatedAt: "2026-11-09T16:51:58.631Z",
		});
	});

	it("parses thread detail and messages", () => {
		const detail = parseThreadDetail({
			thread: {
				threadId: "mcp:1",
				title: "add retry",
				status: "completed",
				branch: "feat/retry",
				worktreePath: "/tmp/wt",
				providerInstanceId: "pi",
				model: "opencode-go/x",
			},
			messages: [
				{ role: "user", text: "do it" },
				{ role: "assistant", text: "done" },
			],
		});
		assert.equal(detail?.thread.branch, "feat/retry");
		assert.equal(detail?.thread.worktreePath, "/tmp/wt");
		assert.deepEqual(detail?.messages, [
			{ role: "user", text: "do it" },
			{ role: "assistant", text: "done" },
		]);
	});

	it("builds start args and returns the thread id", async () => {
		let received: readonly string[] = [];
		const client = new T3Client({
			cwd: "/repo",
			command: "t3",
			run: async (args) => {
				received = args;
				return JSON.stringify({ threadId: "mcp:1", runId: "run:1" });
			},
		});
		const id = await client.start("fix it", { worktree: "main", provider: "pi", model: "opencode-go/x" });
		assert.equal(id, "mcp:1");
		assert.deepEqual(
			[...received],
			[
				"thread",
				"start",
				"/repo",
				"fix it",
				"--json",
				"--worktree",
				"main",
				"--provider",
				"pi",
				"--model",
				"opencode-go/x",
			],
		);
	});

	it("turns a missing server into an install hint", async () => {
		const client = new T3Client({
			cwd: "/repo",
			run: async () => {
				throw new Error("No running T3 Code server uses /repo. Start T3 Code, then retry.");
			},
		});
		const snapshot = await client.list();
		assert.equal(snapshot.available, false);
		assert.equal(snapshot.error, "t3 server not running · t3 service install");
	});

	it("returns the reply from send and throws on a failed run", async () => {
		const ok = new T3Client({
			cwd: "/repo",
			run: async () => JSON.stringify({ status: "completed", reply: "1", error: null }),
		});
		assert.equal(await ok.send("mcp:1", "count"), "1");

		const failed = new T3Client({
			cwd: "/repo",
			run: async () => JSON.stringify({ status: "failed", error: "model not supported" }),
		});
		await assert.rejects(() => failed.send("mcp:1", "go"), /model not supported/);
	});

	it("classifies live statuses", () => {
		assert.equal(isT3Live("running"), true);
		assert.equal(isT3Live("preparing"), true);
		assert.equal(isT3Live("completed"), false);
		assert.equal(isT3Live("failed"), false);
	});
});
