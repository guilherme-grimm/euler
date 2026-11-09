import assert from "node:assert";
import { describe, it } from "vitest";
import {
	codexAccountId,
	EulerUsage,
	parseClaudeUsage,
	parseCodexUsage,
	parseOpenCodeGoUsage,
} from "../src/modes/euler/euler-usage.ts";

const CLAUDE_USAGE = {
	five_hour: { utilization: 23, resets_at: "2026-11-08T22:00:00Z" },
	seven_day: { utilization: 8 },
	seven_day_opus: { utilization: 140 },
	seven_day_sonnet: null,
};

const CODEX_USAGE = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 61, limit_window_seconds: 18_000, reset_at: 1_781_000_000 },
		secondary_window: { used_percent: 34, limit_window_seconds: 604_800 },
	},
};

const OPENCODE_USAGE = {
	usage: {
		rolling: { status: "ok", percent: 63, resetsAt: "2026-11-09T04:00:00Z" },
		weekly: { status: "ok", percent: 41, resetsAt: "2026-11-12T00:00:00Z" },
		monthly: { status: "rate-limited", percent: 100 },
	},
};

function jwt(claims: Record<string, unknown>): string {
	return ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
}

function response(payload: unknown, ok = true, status = 200): Response {
	return { ok, status, json: async () => payload } as unknown as Response;
}

describe("euler usage", () => {
	it("parses claude windows and clamps percentages", () => {
		const windows = parseClaudeUsage(CLAUDE_USAGE);
		assert.deepEqual(
			windows.map((window) => [window.label, window.kind, Math.round(window.usedPercent)]),
			[
				["5h", "session", 23],
				["7d", "weekly", 8],
				["7d opus", "weekly", 100],
			],
		);
		assert.equal(windows[0]?.resetsAt, "2026-11-08T22:00:00Z");
	});

	it("maps codex primary/secondary windows by duration", () => {
		const { windows, plan } = parseCodexUsage(CODEX_USAGE);
		assert.equal(plan, "plus");
		assert.deepEqual(
			windows.map((window) => [window.label, window.kind, Math.round(window.usedPercent)]),
			[
				["5h", "session", 61],
				["7d", "weekly", 34],
			],
		);
	});

	it("maps opencode go windows", () => {
		const windows = parseOpenCodeGoUsage(OPENCODE_USAGE);
		assert.deepEqual(
			windows.map((window) => [window.label, window.kind, Math.round(window.usedPercent)]),
			[
				["5h", "session", 63],
				["7d", "weekly", 41],
				["30d", "monthly", 100],
			],
		);
		assert.equal(windows[0]?.resetsAt, "2026-11-09T04:00:00Z");
	});

	it("reads the chatgpt account id from the token claims", () => {
		const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
		assert.equal(codexAccountId(token), "acct_123");
		assert.equal(codexAccountId("not-a-jwt"), undefined);
	});

	it("caches all three probes and refreshes after the ttl", async () => {
		let now = 1_000;
		let calls = 0;
		const codexToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
		const usage = new EulerUsage({
			getAuth: async (provider) => ({
				apiKey:
					provider === "anthropic"
						? "sk-ant-oat-test"
						: provider === "openai-codex"
							? codexToken
							: "opencode-go-key",
			}),
			now: () => now,
			fetch: async (input) => {
				calls += 1;
				const url = String(input);
				if (url.includes("anthropic")) return response(CLAUDE_USAGE);
				if (url.includes("chatgpt.com")) return response(CODEX_USAGE);
				return response(OPENCODE_USAGE);
			},
		});

		await usage.refresh();
		assert.equal(calls, 3);
		assert.deepEqual(
			usage.read().accounts.map((account) => account.provider),
			["anthropic", "openai-codex", "opencode-go"],
		);
		assert.equal(usage.get("anthropic")?.windows[0]?.label, "5h");
		assert.equal(usage.get("opencode-go")?.windows[2]?.label, "30d");

		await usage.refreshIfStale();
		assert.equal(calls, 3, "fresh snapshot is reused");
		now += 61_000;
		await usage.refreshIfStale();
		assert.equal(calls, 6, "stale snapshot refetches");
	});

	it("keeps a failed probe as an unavailable account instead of throwing", async () => {
		const usage = new EulerUsage({
			getAuth: async () => ({ apiKey: "sk-ant-oat-test" }),
			fetch: async () => response({}, false, 403),
		});
		await usage.refresh();
		const claude = usage.get("anthropic");
		assert.ok(claude?.error?.includes("403"), claude?.error);
		assert.equal(claude?.windows.length, 0);
	});

	it("marks api-key credentials as having no plan windows", async () => {
		const calls: string[] = [];
		const usage = new EulerUsage({
			getAuth: async (provider) => ({ apiKey: provider === "anthropic" ? "sk-ant-api03-key" : undefined }),
			fetch: async (input) => {
				calls.push(String(input));
				return response({});
			},
		});
		await usage.refresh();
		const claude = usage.get("anthropic");
		assert.equal(claude?.note, "api key · no plan windows");
		assert.equal(claude?.windows.length, 0);
		assert.deepEqual(calls, []);
	});

	it("surfaces an auth failure instead of dropping the account", async () => {
		const usage = new EulerUsage({
			getAuth: async () => {
				throw new Error("refresh failed");
			},
		});
		await usage.refresh();
		const claude = usage.get("anthropic");
		assert.ok(claude?.error?.includes("auth failed"), claude?.error);
		assert.ok(claude?.error?.includes("euler auth login anthropic"), claude?.error);
		assert.equal(usage.read().accounts.length, 3);
	});
});
