/**
 * One-line modal statusline pinned under the chat viewport.
 *
 * Segmented like a lualine: a filled mode block on the left, dim separators, right-aligned
 * position/session/linage. The text is produced lazily on render, so mode changes only need a
 * `requestRender()`.
 */

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeBg, theme } from "../interactive/theme/theme.ts";
import type { EulerModeName } from "./keymap.ts";

export type { EulerModeName };

export interface EulerStatusData {
	mode: EulerModeName;
	line: number;
	total: number;
	sessionName: string;
	/** Name/id of the session this thread was forked from, when there is one. */
	parent?: string;
	streaming: boolean;
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

const MODE_BG: Record<EulerModeName, ThemeBg> = {
	normal: "userMessageBg",
	insert: "toolSuccessBg",
	visual: "customMessageBg",
	search: "searchMatchBg",
	command: "toolPendingBg",
};

export class EulerStatusLine implements Component {
	private readonly read: () => EulerStatusData;

	constructor(read: () => EulerStatusData) {
		this.read = read;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const data = this.read();
		const divider = theme.fg("dim", "│");
		const pad = theme.fg("dim", " ");

		const pill = theme.bg(MODE_BG[data.mode], theme.bold(theme.fg("text", ` ${MODE_LABEL[data.mode]} `)));

		const right: string[] = [theme.fg("muted", `${data.line}/${data.total}`)];
		if (data.pending) right.push(theme.fg("warning", data.pending));
		if (data.hint) right.push(theme.fg("dim", data.hint));
		if (data.streaming) right.push(theme.fg("success", "● working"));
		right.push(theme.fg("text", data.sessionName));
		if (data.parent) right.push(theme.fg("dim", `fork ${data.parent}`));
		if (data.message) right.push(theme.fg("warning", data.message));

		const left = `${pill}${pad}${divider}${pad}`;
		const body = right.join(`${pad}${divider}${pad}`);
		const needsGap = visibleWidth(left) + visibleWidth(body) + 1 > width;
		if (needsGap) {
			return [truncateToWidth(`${pill} ${body}`, width, "…", true)];
		}
		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(body)));
		return [`${left}${body}${gap}`];
	}
}
