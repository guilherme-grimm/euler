/**
 * Scrollable code/diff viewer for the Euler overlay stack.
 *
 * Rendering is plain themed strings; keys arrive through the overlay's input listener (the same
 * pattern as the popup), so the component never competes with the editor for focus.
 */

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../interactive/theme/theme.ts";
import { BRAND_MARK, brand } from "./euler-look.ts";

export type ViewerKeyResult = "close" | "handled" | "ignored";

export interface EulerViewerOptions {
	title: string;
	lines: readonly string[];
	height: number;
	focusLine?: number;
}

export class EulerViewer implements Component {
	private readonly title: string;
	private readonly lines: readonly string[];
	private readonly viewport: number;
	private scrollTop = 0;
	private pendingG = false;

	constructor(options: EulerViewerOptions) {
		this.title = options.title;
		this.lines = options.lines;
		this.viewport = Math.max(3, options.height - 3);
		if (options.focusLine !== undefined) {
			this.scrollTop = this.clamp(options.focusLine - 1 - Math.floor(this.viewport / 2));
		}
	}

	invalidate(): void {}

	private maxScroll(): number {
		return Math.max(0, this.lines.length - this.viewport);
	}

	private clamp(value: number): number {
		return Math.max(0, Math.min(value, this.maxScroll()));
	}

	scrollBy(delta: number): void {
		this.scrollTop = this.clamp(this.scrollTop + delta);
	}

	scrollToEnd(): void {
		this.scrollTop = this.maxScroll();
	}

	/** `q`/`esc` close, movement keys scroll; other keys are ignored (caller consumes them). */
	handleKey(data: string): ViewerKeyResult {
		if (data === "q" || data === "\x1b" || data === "\x03") return "close";
		if (data.length > 1 && /^[\x20-\x7e]+$/.test(data)) {
			for (const char of data) {
				const result = this.handleKey(char);
				if (result === "close") return result;
			}
			return "handled";
		}
		const half = Math.max(1, Math.floor(this.viewport / 2));
		const page = Math.max(1, this.viewport - 1);
		switch (data) {
			case "j":
			case "\x1b[B":
				this.scrollBy(1);
				return "handled";
			case "k":
			case "\x1b[A":
				this.scrollBy(-1);
				return "handled";
			case "\x04":
			case "\x1b[6~":
				this.scrollBy(data === "\x04" ? half : page);
				return "handled";
			case "\x15":
			case "\x1b[5~":
				this.scrollBy(data === "\x15" ? -half : -page);
				return "handled";
			case "\x06":
				this.scrollBy(page);
				return "handled";
			case "\x02":
				this.scrollBy(-page);
				return "handled";
			case "G":
				this.scrollToEnd();
				return "handled";
			case "g":
				if (this.pendingG) {
					this.scrollTop = 0;
					this.pendingG = false;
				} else {
					this.pendingG = true;
				}
				return "handled";
			default:
				this.pendingG = false;
				return "ignored";
		}
	}

	render(width: number): string[] {
		const panelWidth = Math.max(20, Math.min(width, 160));
		const inner = panelWidth - 4;
		const title = ` ${brand(BRAND_MARK)} ${theme.bold(theme.fg("text", "euler view"))} ${theme.fg("dim", `· ${this.title}`)} `;
		const topDash = Math.max(1, panelWidth - 2 - visibleWidth(title) - 1);
		const frame = (text: string) => theme.fg("borderAccent", text);
		const paint = (text: string) => theme.bg("toolPendingBg", text);
		const finalLine = this.lines.length === 0 ? 0 : Math.min(this.lines.length, this.scrollTop + this.viewport);
		const position = this.lines.length === 0 ? "0/0" : `${this.scrollTop + 1}-${finalLine}/${this.lines.length}`;
		const lines: string[] = [paint(frame(`╭─${title}${"─".repeat(topDash)}╮`))];
		for (let index = 0; index < this.viewport; index++) {
			const line = this.lines[this.scrollTop + index] ?? "";
			lines.push(paint(`${frame("│")} ${truncateToWidth(line, inner, "…", true)} ${frame("│")}`));
		}
		lines.push(
			paint(
				`${frame("│")} ${truncateToWidth(theme.fg("dim", ` ${position} · j/k · ctrl+d/u · g/G · q close`), inner, "…", true)} ${frame("│")}`,
			),
		);
		lines.push(paint(frame(`╰${"─".repeat(panelWidth - 2)}╯`)));
		return lines;
	}
}
