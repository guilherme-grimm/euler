/**
 * Plan-window usage: how much of a subscription quota is spent, in percent.
 *
 * Two sources, both optional and both undocumented:
 * - Anthropic subscription OAuth: `GET /api/oauth/usage`, the endpoint behind Claude Code's own
 *   `/usage`. Claude Code's user agent matters; without it Anthropic rate-limits the caller hard.
 * - ChatGPT/Codex OAuth: `GET /backend-api/wham/usage`, keyed by the account id embedded in the
 *   access token's JWT claims.
 *
 * The UI never guesses: a failed probe becomes `error` on that account, and no OAuth credential
 * means the account is not listed at all. Data is cached for a minute; the endpoints are read-only.
 */

const TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
/** Kept in step with `packages/ai/src/api/anthropic-messages.ts`; Anthropic expects a Claude Code client. */
const CLAUDE_USER_AGENT = "claude-cli/2.1.280";

export type UsageWindowKind = "session" | "weekly" | "monthly" | "other";

export interface UsageWindow {
	id: string;
	kind: UsageWindowKind;
	/** Compact label for the statusline and panel: `5h`, `7d`, `7d opus`. */
	label: string;
	usedPercent: number;
	/** ISO timestamp the window resets, when the provider reports one. */
	resetsAt?: string;
}

export interface UsageAccount {
	/** pi provider id: `anthropic`, `openai-codex`. */
	provider: string;
	label: string;
	plan?: string;
	windows: UsageWindow[];
	/** Informational state, e.g. an API key has no plan windows. */
	note?: string;
	/** Set when the probe or the credential resolution fails; `windows` is then empty. */
	error?: string;
}

export interface UsageSnapshot {
	accounts: UsageAccount[];
	loading: boolean;
}

export interface UsageAuth {
	apiKey?: string;
}

export interface EulerUsageOptions {
	/** Resolve a provider credential; `ModelRuntime.getAuth` maps onto this. */
	getAuth: (provider: string) => Promise<UsageAuth | undefined>;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	ttlMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function percent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(100, Math.max(0, value));
}

function isoDate(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function windowLabel(minutes: number): string {
	if (minutes >= 28 * 1440) return "30d";
	if (minutes >= 6 * 1440) return "7d";
	if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
	return `${Math.round(minutes)}m`;
}

function windowKind(minutes: number): UsageWindowKind {
	if (minutes >= 28 * 1440) return "monthly";
	if (minutes >= 6 * 1440) return "weekly";
	if (minutes > 0) return "session";
	return "other";
}

/** Claude reports utilization in percent plus ISO reset stamps, with optional per-model weeklies. */
export function parseClaudeUsage(payload: unknown): UsageWindow[] {
	const root = asRecord(payload);
	if (!root) return [];
	const windows: UsageWindow[] = [];
	const add = (id: string, kind: UsageWindowKind, label: string, value: unknown): void => {
		const entry = asRecord(value);
		const used = percent(entry?.utilization);
		if (used === undefined) return;
		windows.push({ id, kind, label, usedPercent: used, resetsAt: isoDate(entry?.resets_at) });
	};
	add("five_hour", "session", "5h", root.five_hour);
	add("seven_day", "weekly", "7d", root.seven_day);
	add("seven_day_opus", "weekly", "7d opus", root.seven_day_opus);
	add("seven_day_sonnet", "weekly", "7d sonnet", root.seven_day_sonnet);
	return windows;
}

/** Codex positions windows as primary/secondary; the duration tells us what they actually are. */
export function parseCodexUsage(payload: unknown): { windows: UsageWindow[]; plan?: string } {
	const root = asRecord(payload);
	if (!root) return { windows: [] };
	const plan = typeof root.plan_type === "string" ? root.plan_type : undefined;
	const limit = asRecord(root.rate_limit);
	const windows: UsageWindow[] = [];
	const add = (id: string, value: unknown, fallbackMinutes: number): void => {
		const entry = asRecord(value);
		const used = percent(entry?.used_percent);
		if (used === undefined) return;
		const seconds =
			typeof entry?.limit_window_seconds === "number" ? entry.limit_window_seconds : fallbackMinutes * 60;
		const minutes = Math.max(0, Math.round(seconds / 60));
		const reset = typeof entry?.reset_at === "number" ? new Date(entry.reset_at * 1000).toISOString() : undefined;
		windows.push({
			id,
			kind: windowKind(minutes),
			label: windowLabel(minutes),
			usedPercent: used,
			resetsAt: reset,
		});
	};
	add("primary", limit?.primary_window, 5 * 60);
	add("secondary", limit?.secondary_window, 7 * 1440);
	return { windows, plan };
}

/** OpenCode Go publishes three subscription windows; `percent` is already the used share. */
export function parseOpenCodeGoUsage(payload: unknown): UsageWindow[] {
	const usage = asRecord(asRecord(payload)?.usage);
	if (!usage) return [];
	const windows: UsageWindow[] = [];
	const add = (id: "rolling" | "weekly" | "monthly", kind: UsageWindowKind, label: string): void => {
		const entry = asRecord(usage[id]);
		const used = percent(entry?.percent);
		if (used === undefined) return;
		windows.push({ id, kind, label, usedPercent: used, resetsAt: isoDate(entry?.resetsAt) });
	};
	add("rolling", "session", "5h");
	add("weekly", "weekly", "7d");
	add("monthly", "monthly", "30d");
	return windows;
}

/** `chatgpt_account_id` from the OAuth JWT, the same claim the Codex API adapter reads. */
export function codexAccountId(token: string): string | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = asRecord(claims["https://api.openai.com/auth"]);
		const id = auth?.chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

interface ProbeInput {
	provider: string;
	label: string;
	url: string;
	headers: Record<string, string>;
	parse: (payload: unknown) => { windows: UsageWindow[]; plan?: string };
	fetch: typeof globalThis.fetch;
}

async function probeAccount(input: ProbeInput): Promise<UsageAccount> {
	const base = { provider: input.provider, label: input.label };
	try {
		const response = await input.fetch(input.url, {
			headers: input.headers,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) return { ...base, windows: [], error: `unavailable (http ${response.status})` };
		const parsed = input.parse(await response.json());
		if (parsed.windows.length === 0) return { ...base, windows: [], error: "no windows reported" };
		return { ...base, windows: parsed.windows, plan: parsed.plan };
	} catch {
		return { ...base, windows: [], error: "unavailable" };
	}
}

export class EulerUsage {
	private readonly getAuth: (provider: string) => Promise<UsageAuth | undefined>;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private accounts: UsageAccount[] = [];
	private checkedAt = 0;
	private inflight?: Promise<void>;
	private readonly listeners = new Set<() => void>();

	constructor(options: EulerUsageOptions) {
		this.getAuth = options.getAuth;
		this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? TTL_MS;
	}

	read(): UsageSnapshot {
		return { accounts: this.accounts, loading: this.inflight !== undefined };
	}

	get(provider: string | undefined): UsageAccount | undefined {
		if (!provider) return undefined;
		return this.accounts.find((account) => account.provider === provider);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** TTL-guarded refresh for render paths: no network while the snapshot is fresh or loading. */
	refreshIfStale(): Promise<void> {
		if (this.inflight) return this.inflight;
		if (this.checkedAt !== 0 && this.now() - this.checkedAt < this.ttlMs) return Promise.resolve();
		return this.refresh();
	}

	/** Force a refresh (`:usage`); concurrent callers share the same request. */
	refresh(): Promise<void> {
		if (this.inflight) return this.inflight;
		this.inflight = this.load().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private async load(): Promise<void> {
		const [claude, codex, opencode] = await Promise.all([this.readClaude(), this.readCodex(), this.readOpenCode()]);
		this.accounts = [claude, codex, opencode].filter((account): account is UsageAccount => account !== undefined);
		this.checkedAt = this.now();
		for (const listener of this.listeners) listener();
	}

	private async auth(provider: string): Promise<{ token?: string; error?: string }> {
		try {
			const token = (await this.getAuth(provider))?.apiKey;
			return token ? { token } : {};
		} catch {
			// A stored credential that cannot be refreshed must stay visible: silence reads as "not in use".
			return { error: `auth failed · euler auth login ${provider}` };
		}
	}

	private async readClaude(): Promise<UsageAccount | undefined> {
		const auth = await this.auth("anthropic");
		const base = { provider: "anthropic", label: "Claude" };
		if (auth.error) return { ...base, windows: [], error: auth.error };
		// Subscription tokens are the only ones with plan windows; API keys have no subscription.
		if (!auth.token) return undefined;
		if (!auth.token.includes("sk-ant-oat")) return { ...base, windows: [], note: "api key · no plan windows" };
		return probeAccount({
			provider: "anthropic",
			label: "Claude",
			url: "https://api.anthropic.com/api/oauth/usage",
			headers: {
				authorization: `Bearer ${auth.token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"user-agent": CLAUDE_USER_AGENT,
				accept: "application/json",
			},
			parse: (payload) => ({ windows: parseClaudeUsage(payload) }),
			fetch: this.fetchFn,
		});
	}

	private async readCodex(): Promise<UsageAccount | undefined> {
		const auth = await this.auth("openai-codex");
		const base = { provider: "openai-codex", label: "Codex" };
		if (auth.error) return { ...base, windows: [], error: auth.error };
		if (!auth.token) return undefined;
		const accountId = codexAccountId(auth.token);
		if (!accountId) return { ...base, windows: [], error: "token has no account id" };
		return probeAccount({
			provider: "openai-codex",
			label: "Codex",
			url: "https://chatgpt.com/backend-api/wham/usage",
			headers: {
				authorization: `Bearer ${auth.token}`,
				"chatgpt-account-id": accountId,
				accept: "application/json",
			},
			parse: parseCodexUsage,
			fetch: this.fetchFn,
		});
	}

	private async readOpenCode(): Promise<UsageAccount | undefined> {
		const auth = await this.auth("opencode-go");
		const base = { provider: "opencode-go", label: "OpenCode Go" };
		if (auth.error) return { ...base, windows: [], error: auth.error };
		if (!auth.token) return undefined;
		return probeAccount({
			provider: "opencode-go",
			label: "OpenCode Go",
			url: "https://opencode.ai/zen/go/v1/usage",
			headers: {
				authorization: `Bearer ${auth.token}`,
				accept: "application/json",
			},
			parse: (payload) => ({ windows: parseOpenCodeGoUsage(payload) }),
			fetch: this.fetchFn,
		});
	}
}
