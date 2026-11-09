/**
 * One-line modal statusline pinned under the chat viewport.
 *
 * Reads left to right: the mode you are in (brand bar), the thread you are in, and only then what it
 * is doing. The right cluster stays empty when there is nothing honest to report, so an idle turn
 * looks quiet instead of wearing lualine decoration.
 */

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../interactive/theme/theme.ts";
import { brand, SPINNER_INTERVAL_MS, spinnerFrame } from "./euler-look.ts";
import { elapsed } from "./euler-voice.ts";
import type { EulerModeName } from "./keymap.ts";

export type { EulerModeName };

export interface EulerStatusData {
	mode: EulerModeName;
	line: number;
	total: number;
	sessionName: string;
	/** Name/id of the session this thread was forked from, when there is one. */
	parent?: string;
	/** Active model for the right-edge chip, already shortened for display. */
	model?: { name: string; thinking?: string };
	/** Subscription quota window for the active provider, e.g. `5h` at 23%. */
	usage?: { label: string; percent: number };
	streaming: boolean;
	/** How long the current turn has been running, for `working 12s`. */
	workingMs?: number;
	/** Pending count/prefix, e.g. "3j". */
	pending?: string;
	/** Which-key continuations for the pending prefix. */
	hint?: string;
	message?: string;
}

const MODE_LABEL: Record<EulerModeName, string> = {
	normal: "NORMAL",
	visual: "VISUAL",
	insert: "INSERT",
	search: "SEARCH",
	command: "COMMAND",
};

/** Normal mode is Euler teal; every other mode borrows one semantic theme token. */
function modeName(mode: EulerModeName): string {
	const label = MODE_LABEL[mode];
	if (mode === "normal") return theme.bold(brand(label));
	const token: ThemeColor = mode === "insert" ? "success" : mode === "visual" ? "warning" : "accent";
	return theme.bold(theme.fg(token, label));
}

export class EulerStatusLine implements Component {
	private readonly read: () => EulerStatusData;
	private readonly requestRender?: () => void;
	private ticker?: ReturnType<typeof setInterval>;

	/** `requestRender` turns the working spinner into an animation; without it the line is static. */
	constructor(read: () => EulerStatusData, requestRender?: () => void) {
		this.read = read;
		this.requestRender = requestRender;
	}

	invalidate(): void {}

	/**
	 * The spinner is the only animation Euler owns, so it ticks while a turn is in flight and not a
	 * millisecond longer. The tick renders the whole UI, so the rail's spinner beats with it.
	 */
	private followStreaming(streaming: boolean): void {
		if (streaming) {
			if (this.ticker || !this.requestRender) return;
			this.ticker = setInterval(() => this.requestRender?.(), SPINNER_INTERVAL_MS);
			this.ticker.unref?.();
			return;
		}
		if (!this.ticker) return;
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private left(data: EulerStatusData): string {
		const context = data.pending
			? `${theme.fg("warning", data.pending)} ${theme.fg("dim", data.hint ?? "")}`.trimEnd()
			: theme.bold(theme.fg("text", data.sessionName));
		return `${brand("▎")}${modeName(data.mode)}  ${context}`;
	}

	/** Right cluster; the model chip and quota segment drop first when the line is tight. */
	private right(data: EulerStatusData, includeModel: boolean, includeUsage: boolean): string {
		const parts: string[] = [];
		if (data.streaming) {
			const label = data.workingMs === undefined ? "working" : `working ${elapsed(data.workingMs)}`;
			parts.push(`${brand(spinnerFrame())} ${theme.fg("muted", label)}`);
		}
		if (includeUsage && data.usage) {
			const { percent } = data.usage;
			const color: ThemeColor = percent >= 80 ? "error" : percent >= 50 ? "warning" : "success";
			parts.push(`${theme.fg("dim", `${data.usage.label} `)}${theme.fg(color, `${percent}%`)}`);
		}
		if (data.total > 0) parts.push(theme.fg("muted", `${data.line}/${data.total}`));
		if (data.parent) parts.push(theme.fg("dim", `↳ ${data.parent}`));
		if (includeModel && data.model) {
			const thinking = data.model.thinking ? ` ${theme.fg("dim", data.model.thinking)}` : "";
			parts.push(`${theme.fg("text", data.model.name)}${thinking}`);
		}
		if (data.message) parts.push(theme.fg("warning", data.message));
		return parts.join(theme.fg("dim", " · "));
	}

	render(width: number): string[] {
		const data = this.read();
		this.followStreaming(data.streaming);
		const left = this.left(data);
		const fits = (right: string) => width - visibleWidth(left) - visibleWidth(right) >= 1;
		// The chip and the quota segment are the least important things on the line: drop them before
		// the thread and position get cut.
		let right = this.right(data, true, true);
		if (!fits(right) && data.model) right = this.right(data, false, true);
		if (!fits(right) && data.usage) right = this.right(data, false, false);
		if (right.length === 0) return [truncateToWidth(left, width, "…", true)];
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap < 1) return [truncateToWidth(`${left} ${right}`, width, "…", true)];
		return [`${left}${" ".repeat(gap)}${right}`];
	}
}
