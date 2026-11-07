/**
 * Euler: a modal, vim-flavoured interaction layer over Pi's fullscreen transcript.
 *
 * The layer stays out of the renderer's way: it owns a keyboard cursor in transcript content
 * space, paints it through `TuiAltScreen.setKeyboardState`, and only consumes keys while in
 * normal/visual mode so insert mode keeps Pi's editor untouched.
 */

import {
	Box,
	Input,
	matchesKey,
	type OverlayHandle,
	type ScrollView,
	stripTerminalSequences,
	Text,
	type TUI,
	type TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../interactive/theme/theme.ts";
import type { EulerModeName, EulerStatusData } from "./euler-status.ts";
import {
	type Cursor,
	characterwiseText,
	linewiseText,
	MotionDoc,
	moveDocEnd,
	moveDocStart,
	moveDown,
	moveFirstNonBlank,
	moveLeft,
	moveLineEnd,
	moveLineStart,
	moveParagraphDown,
	moveParagraphUp,
	moveRight,
	moveUp,
	moveWordBackward,
	moveWordEnd,
	moveWordForward,
} from "./motions.ts";

export interface EulerPrompt {
	entryId: string;
	text: string;
}

export interface EulerHost {
	readonly ui: TUI;
	readonly renderer: TuiAltScreen;
	readonly transcript: ScrollView;
	/** Fork at the active leaf: same context, new session file, both threads continue. */
	forkAtLeaf(): Promise<void>;
	/** Fork before a user message: rewinds context, returns its text for the editor. */
	forkBeforePrompt(prompt: EulerPrompt): Promise<void>;
	prompts(): EulerPrompt[];
	/** Append a persistent quote entry to the live session. */
	addQuote(text: string, details: Record<string, unknown>): void;
	copy(text: string): Promise<boolean>;
	openSessions(): void;
	openTree(): void;
	focusEditor(): void;
	blurEditor(): void;
	showStatus(text: string): void;
	showError(text: string): void;
	isStreaming(): boolean;
	sessionName(): string;
	parentName(): string | undefined;
}

const SCROLL_OFF = 10;

function stripMarkers(line: string): string {
	return stripTerminalSequences(line).replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g, "");
}

export class EulerMode {
	private mode: EulerModeName = "insert";
	private cursor: Cursor = { row: 0, col: 0 };
	private anchor?: Cursor;
	private linewise = false;
	private desiredCol?: number;
	private count = 0;
	private pending: "" | "g" | "y" | "leader" = "";
	private searchQuery = "";
	private searchMatches: Cursor[] = [];
	private searchIndex = -1;
	private message = "";
	private overlay?: OverlayHandle;
	private detach?: () => void;
	private readonly host: EulerHost;

	constructor(host: EulerHost) {
		this.host = host;
	}

	attach(): void {
		this.detach = this.host.ui.addInputListener((data) => this.handleInput(data));
		this.syncCursor({ jumpToBottom: true });
	}

	dispose(): void {
		this.detach?.();
		this.detach = undefined;
		this.host.renderer.setKeyboardState(undefined);
		this.overlay?.hide();
		this.overlay = undefined;
	}

	statusData(): EulerStatusData {
		const total = this.host.renderer.getViewportSnapshot(this.host.transcript)?.lines.length ?? 0;
		const pending = this.count > 0 || this.pending ? `${this.pending}${this.count || ""}` : undefined;
		return {
			mode: this.mode,
			line: Math.min(this.cursor.row + 1, Math.max(1, total)),
			total,
			sessionName: this.host.sessionName(),
			parent: this.host.parentName(),
			streaming: this.host.isStreaming(),
			pending,
			message: this.message || undefined,
		};
	}

	/** Re-read the transcript snapshot into a motion document. */
	private doc(): MotionDoc | undefined {
		const snapshot = this.host.renderer.getViewportSnapshot(this.host.transcript);
		if (!snapshot) return undefined;
		const lines = snapshot.lines.map(stripMarkers);
		return new MotionDoc(lines);
	}

	private handleInput(data: string): { consume?: boolean } | undefined {
		if (this.overlay) return undefined;
		if (this.mode === "insert") {
			if (matchesKey(data, "escape")) {
				this.enterNormal();
				return { consume: true };
			}
			return undefined;
		}
		if (data.length > 1 && /^[\x20-\x7e]+$/.test(data)) {
			let consume = true;
			for (const char of data) {
				const result = this.handleVimKey(char);
				consume = consume && Boolean(result?.consume);
				if (this.overlay) break;
			}
			this.host.ui.requestRender();
			return { consume };
		}
		const result = this.handleVimKey(data);
		this.host.ui.requestRender();
		return result;
	}

	private handleVimKey(key: string): { consume?: boolean } | undefined {
		this.message = "";
		if (matchesKey(key, "escape")) {
			if (this.mode === "visual") {
				this.exitVisual();
				return { consume: true };
			}
			if (this.pending || this.count > 0) {
				this.clearPending();
				this.syncCursor();
				return { consume: true };
			}
			// Esc aborts a running turn, as it does in Pi; otherwise it is a no-op in normal mode.
			if (this.host.isStreaming()) return undefined;
			this.message = "";
			this.syncCursor();
			return { consume: true };
		}

		// Counts: 1-9 always, 0 only when a count is in progress.
		if (/^[1-9]$/.test(key) || (key === "0" && this.count > 0)) {
			this.count = this.count * 10 + Number(key);
			this.syncCursor();
			return { consume: true };
		}
		const count = this.count || 1;

		if (this.pending === "g") {
			this.pending = "";
			this.clearCount();
			const doc = this.doc();
			if (!doc) return { consume: true };
			if (key === "g") this.cursor = moveDocStart(doc, this.cursor);
			else this.message = `unsupported: g${key}`;
			this.afterMotion(doc);
			return { consume: true };
		}

		if (this.pending === "y") {
			this.pending = "";
			this.clearCount();
			if (key === "y") void this.yankCurrentLine();
			this.syncCursor();
			return { consume: true };
		}

		if (this.pending === "leader") {
			this.pending = "";
			this.clearCount();
			if (key === "s") this.host.openSessions();
			else if (key === "t") this.host.openTree();
			else if (key === "f") void this.forkAtLeaf();
			else if (key === "?") this.showHelp();
			else this.message = `no mapping: <space>${key}`;
			this.syncCursor();
			return { consume: true };
		}

		const doc = this.doc();
		if (!doc) {
			this.message = "no transcript yet";
			return { consume: true };
		}

		switch (key) {
			case "i":
			case "a":
			case "A":
			case "o":
			case "O":
				this.clearPending();
				this.enterInsert();
				return { consume: true };
			case "j":
				this.cursor = moveDown(doc, this.cursor, count, this.desiredCol);
				this.afterMotion(doc);
				return { consume: true };
			case "k":
				this.cursor = moveUp(doc, this.cursor, count, this.desiredCol);
				this.afterMotion(doc);
				return { consume: true };
			case "h":
				this.cursor = moveLeft(doc, this.cursor, count);
				this.desiredCol = undefined;
				this.afterMotion(doc);
				return { consume: true };
			case "l":
				this.cursor = moveRight(doc, this.cursor, count);
				this.desiredCol = undefined;
				this.afterMotion(doc);
				return { consume: true };
			case "w":
				this.cursor = moveWordForward(doc, this.cursor, count);
				this.afterMotion(doc);
				return { consume: true };
			case "b":
				this.cursor = moveWordBackward(doc, this.cursor, count);
				this.afterMotion(doc);
				return { consume: true };
			case "e":
				this.cursor = moveWordEnd(doc, this.cursor, count);
				this.afterMotion(doc);
				return { consume: true };
			case "0":
				this.cursor = moveLineStart(doc, this.cursor);
				this.desiredCol = undefined;
				this.afterMotion(doc);
				return { consume: true };
			case "^":
				this.cursor = moveFirstNonBlank(doc, this.cursor);
				this.afterMotion(doc);
				return { consume: true };
			case "$":
				this.cursor = moveLineEnd(doc, this.cursor);
				this.afterMotion(doc);
				return { consume: true };
			case "G":
				this.cursor = moveDocEnd(doc, this.cursor);
				this.afterMotion(doc);
				return { consume: true };
			case "g":
				this.pending = "g";
				this.syncCursor();
				return { consume: true };
			case "{":
				this.cursor = moveParagraphUp(doc, this.cursor, count);
				this.afterMotion(doc);
				return { consume: true };
			case "}":
				this.cursor = moveParagraphDown(doc, this.cursor, count);
				this.afterMotion(doc);
				return { consume: true };
			case "v":
				this.clearCount();
				if (this.mode === "visual" && !this.linewise) this.exitVisual();
				else this.startVisual(false);
				return { consume: true };
			case "V":
				this.clearCount();
				if (this.mode === "visual" && this.linewise) this.exitVisual();
				else this.startVisual(true);
				return { consume: true };
			case "y":
				this.clearCount();
				if (this.mode === "visual") {
					void this.yankSelection();
				} else {
					this.pending = "y";
					this.syncCursor();
				}
				return { consume: true };
			case '"':
			case "q":
				this.clearPending();
				void this.quoteSelection();
				return { consume: true };
			case "f":
				this.clearPending();
				void this.forkAtLeaf();
				return { consume: true };
			case "F":
				this.clearPending();
				void this.forkBeforeCursor(doc);
				return { consume: true };
			case "/":
				this.clearPending();
				this.openSearch();
				return { consume: true };
			case "n":
				this.clearPending();
				this.jumpToMatch(1);
				return { consume: true };
			case "N":
				this.clearPending();
				this.jumpToMatch(-1);
				return { consume: true };
			case "?":
				this.clearPending();
				this.showHelp();
				return { consume: true };
			case " ":
				this.pending = "leader";
				this.syncCursor();
				return { consume: true };
			default:
				if (matchesKey(key, "ctrl+d")) {
					this.cursor = moveDown(doc, this.cursor, this.halfPage(), this.desiredCol);
					this.afterMotion(doc);
					return { consume: true };
				}
				if (matchesKey(key, "ctrl+u")) {
					this.cursor = moveUp(doc, this.cursor, this.halfPage(), this.desiredCol);
					this.afterMotion(doc);
					return { consume: true };
				}
				if (matchesKey(key, "ctrl+e")) {
					this.cursor = moveDown(doc, this.cursor, 1, this.desiredCol);
					this.afterMotion(doc);
					return { consume: true };
				}
				if (matchesKey(key, "ctrl+y")) {
					this.cursor = moveUp(doc, this.cursor, 1, this.desiredCol);
					this.afterMotion(doc);
					return { consume: true };
				}
				this.clearPending();
				this.message = `unmapped: ${key}`;
				this.syncCursor();
				return { consume: true };
		}
	}

	private halfPage(): number {
		const height = this.host.renderer.getViewportSnapshot(this.host.transcript)?.height ?? 20;
		return Math.max(1, Math.floor(height / 2));
	}

	private clearCount(): void {
		this.count = 0;
	}

	private clearPending(): void {
		this.pending = "";
		this.count = 0;
	}

	private enterInsert(): void {
		this.mode = "insert";
		this.anchor = undefined;
		this.host.focusEditor();
		this.host.transcript.scrollToEnd();
		this.syncCursor();
	}

	private enterNormal(): void {
		this.mode = "normal";
		this.host.blurEditor();
		this.syncCursor({ jumpToBottom: true });
	}

	private startVisual(linewise: boolean): void {
		this.mode = "visual";
		this.linewise = linewise;
		this.anchor = { ...this.cursor };
		this.syncCursor();
	}

	private exitVisual(): void {
		this.mode = "normal";
		this.anchor = undefined;
		this.linewise = false;
		this.syncCursor();
	}

	private afterMotion(doc: MotionDoc): void {
		if (this.pending === "") this.count = 0;
		this.desiredCol ??= this.cursor.col;
		if (this.desiredCol !== undefined && this.cursor.col !== this.desiredCol) {
			// Only keep the sticky column while the cursor is still clamped short of it.
			if (this.cursor.col > this.desiredCol) this.desiredCol = this.cursor.col;
		}
		this.cursor = doc.clamp(this.cursor);
		this.syncCursor();
	}

	/** Push cursor/selection to the renderer and keep the cursor inside the scrolloff band. */
	private syncCursor(options: { jumpToBottom?: boolean } = {}): void {
		const doc = this.doc();
		if (doc) this.cursor = doc.clamp(this.cursor);
		if (this.anchor) this.anchor = doc ? doc.clamp(this.anchor) : this.anchor;

		const snapshot = this.host.renderer.getViewportSnapshot(this.host.transcript);
		if (snapshot) {
			if (options.jumpToBottom) {
				const row = doc ? doc.lastContentRow() : Math.max(0, snapshot.top + snapshot.height - 1);
				this.cursor = { row, col: this.cursor.col };
				if (doc) this.cursor = doc.clamp(this.cursor);
			}
			const margin = Math.min(SCROLL_OFF, Math.max(0, Math.floor(snapshot.height / 2)));
			if (this.cursor.row < snapshot.top + margin) {
				this.host.transcript.scrollTo(Math.max(0, this.cursor.row - margin), { disableFollow: true });
			} else if (this.cursor.row > snapshot.top + snapshot.height - 1 - margin) {
				this.host.transcript.scrollTo(this.cursor.row - snapshot.height + 1 + margin, { disableFollow: true });
			}
		}

		this.host.renderer.setKeyboardState({
			scrollView: this.host.transcript,
			cursor: this.cursor,
			anchor: this.anchor,
			linewise: this.linewise,
		});
		this.host.ui.requestRender();
	}

	/** Selected text for yank/quote, honouring visual mode and linewise selection. */
	private extractSelection(doc: MotionDoc): { text: string; rows: [number, number]; label: string } | undefined {
		if (this.mode === "visual" && this.anchor) {
			if (this.linewise) {
				const result = linewiseText(doc, this.anchor.row, this.cursor.row);
				return { text: result.text, rows: [result.startRow, result.endRow], label: "lines" };
			}
			const result = characterwiseText(doc, this.anchor, this.cursor);
			return { text: result.text, rows: [result.startRow, result.endRow], label: "selection" };
		}
		const text = doc.text(this.cursor.row);
		return { text, rows: [this.cursor.row, this.cursor.row], label: "line" };
	}

	private async yankSelection(): Promise<void> {
		const doc = this.doc();
		if (!doc) return;
		const selection = this.extractSelection(doc);
		if (!selection || selection.text.trim().length === 0) {
			this.message = "nothing to yank";
			this.syncCursor();
			return;
		}
		const ok = await this.host.copy(selection.text);
		this.message = ok ? `yanked ${selection.label}` : "clipboard failed";
		if (this.mode === "visual") this.exitVisual();
		this.syncCursor();
	}

	private async yankCurrentLine(): Promise<void> {
		const doc = this.doc();
		if (!doc) return;
		await this.host.copy(doc.text(this.cursor.row));
		this.message = "yanked line";
		this.syncCursor();
	}

	private async quoteSelection(): Promise<void> {
		const doc = this.doc();
		if (!doc) return;
		const selection = this.extractSelection(doc);
		const text = selection?.text.trimEnd() ?? "";
		if (text.trim().length === 0) {
			this.message = "nothing to quote";
			this.syncCursor();
			return;
		}
		// Transcript rows carry one cell of left padding; drop it so quotes read cleanly without
		// flattening real indentation deeper in a code block.
		const quoted = text
			.split("\n")
			.map((line) => `> ${line.startsWith(" ") ? line.slice(1) : line}`.trimEnd())
			.join("\n");
		this.host.addQuote(quoted, {
			kind: "euler.quote",
			line: this.cursor.row,
			rows: selection?.rows,
			source: selection?.label,
			createdAt: new Date().toISOString(),
		});
		this.message = `quoted ${selection?.label ?? "text"}`;
		if (this.mode === "visual") this.exitVisual();
		this.syncCursor();
	}

	private async forkAtLeaf(): Promise<void> {
		this.message = "forking…";
		this.host.showStatus("Forking to a new session…");
		this.syncCursor();
		try {
			await this.host.forkAtLeaf();
		} catch (error) {
			this.host.showError(error instanceof Error ? error.message : String(error));
		}
		this.message = "forked";
		this.enterNormal();
	}

	private async forkBeforeCursor(doc: MotionDoc): Promise<void> {
		const prompts = this.host.prompts();
		if (prompts.length === 0) {
			this.message = "no prompt to fork from";
			this.syncCursor();
			return;
		}
		const target = this.promptAboveCursor(doc, prompts) ?? this.promptBelowCursor(doc, prompts);
		if (!target) {
			this.message = "no prompt found in transcript";
			this.syncCursor();
			return;
		}
		this.host.showStatus(`Forking before: ${firstLine(target.text)}`);
		try {
			await this.host.forkBeforePrompt(target);
		} catch (error) {
			this.host.showError(error instanceof Error ? error.message : String(error));
		}
		this.message = "forked";
		this.enterNormal();
	}

	/** Nearest prompt at or above the cursor, matched on its first rendered line. */
	private promptAboveCursor(doc: MotionDoc, prompts: readonly EulerPrompt[]): EulerPrompt | undefined {
		let best: { prompt: EulerPrompt; row: number } | undefined;
		for (const prompt of prompts) {
			const needle = firstLine(prompt.text).trim();
			if (needle.length === 0) continue;
			for (let row = Math.min(this.cursor.row, doc.lineCount - 1); row >= 0; row--) {
				if (doc.text(row).includes(needle)) {
					if (!best || row > best.row) best = { prompt, row };
					break;
				}
			}
		}
		return best?.prompt;
	}

	/** First prompt below the cursor, used when the cursor sits above every rendered prompt. */
	private promptBelowCursor(doc: MotionDoc, prompts: readonly EulerPrompt[]): EulerPrompt | undefined {
		let best: { prompt: EulerPrompt; row: number } | undefined;
		for (const prompt of prompts) {
			const needle = firstLine(prompt.text).trim();
			if (needle.length === 0) continue;
			for (let row = Math.max(0, this.cursor.row); row < doc.lineCount; row++) {
				if (doc.text(row).includes(needle)) {
					if (!best || row < best.row) best = { prompt, row };
					break;
				}
			}
		}
		return best?.prompt;
	}

	private openSearch(): void {
		const input = new Input({ prompt: "/", placeholder: "search transcript" });
		const box = new Box(1, 0, (text) => theme.bg("selectedBg", text));
		box.addChild(input);
		input.onSubmit = (value) => {
			this.closeOverlay();
			this.searchQuery = value;
			this.searchMatches = this.findMatches(value);
			this.searchIndex = -1;
			if (this.searchMatches.length === 0) {
				this.message = `no match: ${value}`;
				this.syncCursor();
				return;
			}
			this.jumpToMatch(1);
		};
		input.onEscape = () => {
			this.closeOverlay();
			this.syncCursor();
		};
		this.overlay = this.host.ui.showOverlay(box, { anchor: "bottom-left", width: "70%", offsetY: -3 });
		this.host.ui.setFocus(input);
		this.mode = "search";
		this.host.ui.requestRender();
	}

	private closeOverlay(): void {
		this.overlay?.hide();
		this.overlay = undefined;
		this.mode = this.anchor ? "visual" : "normal";
		if (this.mode === "normal") this.host.blurEditor();
		this.syncCursor();
	}

	private findMatches(query: string): Cursor[] {
		const doc = this.doc();
		if (!doc || query.length === 0) return [];
		const needle = query.toLowerCase();
		const matches: Cursor[] = [];
		for (let row = 0; row < doc.lineCount; row++) {
			const haystack = doc.text(row).toLowerCase();
			let index = haystack.indexOf(needle);
			while (index !== -1) {
				matches.push({ row, col: visibleWidth(haystack.slice(0, index)) });
				index = haystack.indexOf(needle, index + needle.length);
			}
		}
		return matches;
	}

	private jumpToMatch(direction: 1 | -1): void {
		if (this.searchMatches.length === 0) {
			this.message = "no active search";
			this.syncCursor();
			return;
		}
		this.searchIndex = (this.searchIndex + direction + this.searchMatches.length) % this.searchMatches.length;
		this.cursor = this.searchMatches[this.searchIndex];
		this.message = `/ ${this.searchQuery}`;
		this.syncCursor();
	}

	private showHelp(): void {
		const lines = [
			theme.bold(theme.fg("accent", "euler — modal transcript navigation")),
			"",
			`${theme.fg("warning", "mode")}      Esc normal · i insert · v char-visual · V line-visual`,
			`${theme.fg("warning", "motion")}    h j k l · w b e · 0 ^ $ · gg G · { } · 3j · Ctrl-d/u`,
			`${theme.fg("warning", "select")}    y yank (yy line) · " quote selection · q quote`,
			`${theme.fg("warning", "threads")}   f fork thread here (same context) · F rewind-fork at prompt`,
			`${theme.fg("warning", "sessions")}  <space>s sessions · <space>t tree · <space>f fork`,
			`${theme.fg("warning", "search")}    / query · n next · N previous`,
			"",
			theme.fg("dim", "any key to close"),
		];
		const box = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		this.overlay = this.host.ui.showOverlay(box, { anchor: "center", width: "70%" });
		const listener = (data: string) => {
			if (matchesKey(data, "escape") || data.length > 0) {
				this.host.ui.removeInputListener(listener);
				this.closeOverlay();
				return { consume: true };
			}
			return undefined;
		};
		this.host.ui.addInputListener(listener);
	}
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}
