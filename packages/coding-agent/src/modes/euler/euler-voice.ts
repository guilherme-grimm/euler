/**
 * Euler's voice: the microcopy layer the ADE speaks with.
 *
 * House style: say the state, not the mechanism. Lowercase, no exclamation marks, and a number only
 * when the number is the point. `working 12s` instead of `[RUNNING]`; `no messages yet` instead of
 * `0`. Every string the chrome shows should be able to come from here.
 */

/** Durations the way a person reads them: 12s, 1m 4s, 2h 10m. */
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/** Countdown to a reset: 42s, 42m, 1h 12m, 3d 4h. */
export function until(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Second line of a rail row: what the thread holds, and whether it is a fork. */
export function threadMeta(messageCount: number, fork: boolean, age: string): string {
	const count = messageCount === 0 ? "no messages yet" : `${messageCount} ${messageCount === 1 ? "msg" : "msgs"}`;
	return `${fork ? "↳ " : ""}${count} · ${age}`;
}

/** Panel numbers: 999, 447.1k, 1.0M. */
export function compactTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return String(Math.round(count));
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Compact model name for the statusline: "Anthropic: Claude Opus 4.5" becomes "Opus 4.5". */
export function shortModelName(name: string, id: string): string {
	const label = (name || id)
		.replace(/^[^:]{2,24}:\s*/, "")
		.replace(/^Claude\s+/i, "")
		.trim();
	return label || id;
}
