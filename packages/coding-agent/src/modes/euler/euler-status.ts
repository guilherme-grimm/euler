/**
 * One-line vim statusline pinned under the chat viewport: mode, position, session, thread lineage.
 *
 * The text is produced lazily on render so mode/cursor changes only need a `requestRender()`.
 */

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../interactive/theme/theme.ts";

export type EulerModeName = "normal" | "visual" | "insert" | "search";

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
	message?: string;
}

const MODE_LABEL: Record<EulerModeName, string> = {
	normal: "NORMAL",
	visual: "VISUAL",
	insert: "INSERT",
	search: "SEARCH",
};

export class EulerStatusLine implements Component {
	private readonly read: () => EulerStatusData;

	constructor(read: () => EulerStatusData) {
		this.read = read;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const data = this.read();
		const modeColor: ThemeColor =
			data.mode === "insert"
				? "success"
				: data.mode === "visual"
					? "warning"
					: data.mode === "search"
						? "mdLink"
						: "accent";
		const left = theme.bold(theme.fg(modeColor, ` ${MODE_LABEL[data.mode]} `));
		const parts: string[] = [];
		parts.push(theme.fg("muted", `${data.line}/${data.total}`));
		if (data.pending) parts.push(theme.fg("warning", data.pending));
		parts.push(theme.fg("text", data.sessionName));
		if (data.parent) parts.push(theme.fg("dim", `forked from ${data.parent}`));
		if (data.streaming) parts.push(theme.fg("warning", "working"));
		if (data.message) parts.push(theme.fg("muted", data.message));

		const right = parts.join(theme.fg("dim", " │ "));
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		if (leftWidth + rightWidth + 1 > width) {
			return [truncateToWidth(`${left}${right}`, width, "…", true)];
		}
		return [`${left}${" ".repeat(Math.max(0, width - leftWidth - rightWidth))}${right}`];
	}
}
