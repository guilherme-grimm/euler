/**
 * Euler: a modal, vim-flavoured interaction layer over Pi's fullscreen transcript.
 *
 * The layer stays out of the renderer's way: it owns a keyboard cursor in transcript content
 * space, paints it through `TuiAltScreen.setKeyboardState`, and only consumes keys while in
 * normal/visual mode so insert mode keeps Pi's editor untouched.
 *
 * Dispatch comes from `keymap.ts`, which also feeds the which-key hints and the cheatsheet.
 */

import {
	Box,
	type Component,
	Input,
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	type ScrollView,
	Text,
	type TUI,
	type TuiAltScreen,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../interactive/theme/theme.ts";
import type { EulerModeName, EulerStatusData } from "./euler-status.ts";
import {
	canonicalKey,
	cheatsheetSections,
	describeContinuations,
	displayKeys,
	type EulerAction,
	matchKeymap,
} from "./keymap.ts";
import {
	type Cursor,
	characterwiseText,
	linewiseText,
	MotionDoc,
	moveBigWordBackward,
	moveBigWordEnd,
	moveBigWordForward,
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
	/** Show/hide the persistent thread rail on the left. */
	toggleSidebar(): void;
	/** Open the rail if needed and focus it. */
	showSidebar(): void;
	/** Return focus to the transcript without closing the rail. */
	leaveSidebar(): void;
	/** Transient confirmation in the alt-screen flash stack. */
	flash(message: string): void;
	/** Leave the application (`:q`). */
	quit(): void;
	focusEditor(): void;
	blurEditor(): void;
	showStatus(text: string): void;
	showError(text: string): void;
	isStreaming(): boolean;
	/** True when a component other than the editor holds focus (pi selectors, pickers, dialogs). */
	hasForeignFocus(): boolean;
	sessionName(): string;
	parentName(): string | undefined;
}

const SCROLL_OFF = 10;
const PAGE_OVERLAP = 2;

export class EulerMode {
	private mode: EulerModeName = "insert";
	private cursor: Cursor = { row: 0, col: 0 };
	private anchor?: Cursor;
	private linewise = false;
	private desiredCol?: number;
	private count = 0;
	private pendingTokens: string[] = [];
	private pendingHint = "";
	private searchQuery = "";
	private searchMatches: Cursor[] = [];
	private searchIndex = -1;
	private message = "";
	private overlay?: OverlayHandle;
	private backdrop?: OverlayHandle;
	private detach?: () => void;
	private readonly host: EulerHost;

	constructor(host: EulerHost) {
		this.host = host;
	}

	attach(): void {
		this.detach = this.host.ui.addInputListener((data) => this.handleInput(data));
		// First-run discoverability: cleared as soon as the user presses anything.
		this.message = "Esc for vim mode · ? for keys";
		this.syncCursor({ jumpToBottom: true });
	}

	dispose(): void {
		this.detach?.();
		this.detach = undefined;
		this.host.renderer.setKeyboardState(undefined);
		this.overlay?.hide();
		this.overlay = undefined;
		this.backdrop?.hide();
		this.backdrop = undefined;
	}

	statusData(): EulerStatusData {
		const total = this.host.renderer.getViewportSnapshot(this.host.transcript)?.lines.length ?? 0;
		const count = this.count > 0 ? String(this.count) : "";
		const pending = this.pendingTokens.length > 0 ? displayKeys(this.pendingTokens.join(" ")) : "";
		return {
			mode: this.mode,
			line: Math.min(this.cursor.row + 1, Math.max(1, total)),
			total,
			sessionName: this.host.sessionName(),
			parent: this.host.parentName(),
			streaming: this.host.isStreaming(),
			pending: `${pending}${count}` || undefined,
			hint: this.pendingHint || undefined,
			message: this.message || undefined,
		};
	}

	/** Transcript snapshot as a lazily-stripped motion document. */
	private doc(): MotionDoc | undefined {
		const snapshot = this.host.renderer.getViewportSnapshot(this.host.transcript);
		return snapshot ? new MotionDoc(snapshot.lines) : undefined;
	}

	private viewport(): { top: number; height: number; total: number } | undefined {
		const snapshot = this.host.renderer.getViewportSnapshot(this.host.transcript);
		if (!snapshot) return undefined;
		return { top: snapshot.top, height: snapshot.height, total: snapshot.lines.length };
	}

	private handleInput(data: string): { consume?: boolean } | undefined {
		// Input listeners run before pi's per-component release filter, and the Kitty protocol
		// reports a release for every key (`\x1b[32;1:3u` for space). Decoding one would fire the
		// binding twice, which turns a prefix like <space> into "<space><space>".
		if (isKeyRelease(data)) return undefined;
		if (this.overlay) return undefined;
		// Pi renders its selectors (tree, sessions, models, settings) in the editor dock and gives
		// them focus. Those keys belong to the selector, not to the transcript cursor.
		if (this.host.hasForeignFocus()) {
			// Something else owns focus, so we are not really inserting. Dropping back to normal mode
			// keeps the statusline honest instead of showing INSERT while keys go nowhere.
			if (this.mode === "insert") this.mode = "normal";
			return undefined;
		}
		// Any keystroke dismisses the previous one-shot status message (including the startup hint).
		if (this.message) {
			this.message = "";
			this.host.ui.requestRender();
		}
		if (this.mode === "insert") {
			if (matchesKey(data, "escape")) {
				this.enterNormal();
				return { consume: true };
			}
			return undefined;
		}
		// Fast typing can arrive as one chunk; treat printable runs as individual vim keys.
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

	private handleVimKey(data: string): { consume?: boolean } | undefined {
		const key = canonicalKey(data);
		if (!key) return undefined;

		if (key === "escape") {
			if (this.mode === "visual") {
				this.exitVisual();
				return { consume: true };
			}
			if (this.pendingTokens.length > 0 || this.count > 0) {
				this.clearPending();
				this.syncCursor();
				return { consume: true };
			}
			// Esc aborts a running turn, as it does in Pi; otherwise it is a no-op in normal mode.
			if (this.host.isStreaming()) return undefined;
			this.clearPending();
			this.syncCursor();
			return { consume: true };
		}

		// Counts: 1-9 always, 0 only when a count is already in progress.
		if (/^[1-9]$/.test(key) || (key === "0" && this.count > 0 && this.pendingTokens.length === 0)) {
			this.count = this.count * 10 + Number(key);
			this.syncCursor();
			return { consume: true };
		}

		const bindingMode = this.mode === "visual" ? "visual" : "normal";
		const pressed = [...this.pendingTokens, key];
		const match = matchKeymap(pressed, bindingMode);

		if (match.exact && match.prefixes.length === 0) {
			const count = this.count || 1;
			this.clearPending();
			this.runAction(match.exact.action, count);
			return { consume: true };
		}
		if (match.prefixes.length > 0) {
			this.pendingTokens = pressed;
			this.pendingHint = describeContinuations(match.prefixes);
			this.syncCursor();
			return { consume: true };
		}

		const pressedLabel = displayKeys(pressed.join(" "));
		this.clearPending();
		this.message = `${pressedLabel} is unmapped — ? for keys`;
		this.syncCursor();
		return { consume: true };
	}

	private runAction(action: EulerAction, count: number): void {
		const doc = this.doc();
		if (
			!doc &&
			action !== "help" &&
			action !== "sessions" &&
			action !== "tree" &&
			action !== "sidebar" &&
			action !== "focusSidebar" &&
			action !== "focusTranscript" &&
			action !== "insert" &&
			action !== "command"
		) {
			this.message = "no transcript yet";
			return;
		}
		switch (action) {
			case "down":
				this.cursor = moveDown(doc as MotionDoc, this.cursor, count, this.desiredCol);
				this.afterMotion(doc as MotionDoc);
				return;
			case "up":
				this.cursor = moveUp(doc as MotionDoc, this.cursor, count, this.desiredCol);
				this.afterMotion(doc as MotionDoc);
				return;
			case "left":
				this.cursor = moveLeft(doc as MotionDoc, this.cursor, count);
				this.desiredCol = undefined;
				this.afterMotion(doc as MotionDoc);
				return;
			case "right":
				this.cursor = moveRight(doc as MotionDoc, this.cursor, count);
				this.desiredCol = undefined;
				this.afterMotion(doc as MotionDoc);
				return;
			case "wordForward":
				this.cursor = moveWordForward(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "wordBackward":
				this.cursor = moveWordBackward(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "wordEnd":
				this.cursor = moveWordEnd(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "bigWordForward":
				this.cursor = moveBigWordForward(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "bigWordBackward":
				this.cursor = moveBigWordBackward(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "bigWordEnd":
				this.cursor = moveBigWordEnd(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "lineStart":
				this.cursor = moveLineStart(doc as MotionDoc, this.cursor);
				this.desiredCol = undefined;
				this.afterMotion(doc as MotionDoc);
				return;
			case "firstNonBlank":
				this.cursor = moveFirstNonBlank(doc as MotionDoc, this.cursor);
				this.afterMotion(doc as MotionDoc);
				return;
			case "lineEnd":
				this.cursor = moveLineEnd(doc as MotionDoc, this.cursor);
				this.afterMotion(doc as MotionDoc);
				return;
			case "docStart":
				this.cursor = moveDocStart(doc as MotionDoc, this.cursor);
				this.afterMotion(doc as MotionDoc);
				return;
			case "docEnd":
				this.cursor = moveDocEnd(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "paragraphUp":
				this.cursor = moveParagraphUp(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "paragraphDown":
				this.cursor = moveParagraphDown(doc as MotionDoc, this.cursor, count);
				this.afterMotion(doc as MotionDoc);
				return;
			case "viewportTop":
				this.jumpToViewportRow(0, count);
				return;
			case "viewportMiddle":
				this.jumpToViewportRow(0.5, count);
				return;
			case "viewportBottom":
				this.jumpToViewportRow(1, count);
				return;
			case "halfPageDown":
				this.moveByViewport(Math.floor(this.pageSize() / 2) * count);
				return;
			case "halfPageUp":
				this.moveByViewport(-Math.floor(this.pageSize() / 2) * count);
				return;
			case "pageDown":
				this.moveByViewport(this.pageSize() * count);
				return;
			case "pageUp":
				this.moveByViewport(-this.pageSize() * count);
				return;
			case "visualChar":
				if (this.mode === "visual" && !this.linewise) this.exitVisual();
				else this.startVisual(false);
				return;
			case "visualLine":
				if (this.mode === "visual" && this.linewise) this.exitVisual();
				else this.startVisual(true);
				return;
			case "yank":
				void this.yankSelection();
				return;
			case "yankLine":
				void this.yankCurrentLine();
				return;
			case "quote":
				void this.quoteSelection();
				return;
			case "forkLeaf":
				void this.forkAtLeaf();
				return;
			case "forkPrompt":
				void this.forkBeforeCursor(doc as MotionDoc);
				return;
			case "search":
				this.openSearch();
				return;
			case "nextMatch":
				this.jumpToMatch(1);
				return;
			case "previousMatch":
				this.jumpToMatch(-1);
				return;
			case "help":
				this.showHelp();
				return;
			case "insert":
				this.enterInsert();
				return;
			case "command":
				this.openCommand();
				return;
			case "sessions":
				this.host.openSessions();
				return;
			case "tree":
				this.host.openTree();
				return;
			case "sidebar":
				this.host.toggleSidebar();
				return;
			case "focusSidebar":
				this.host.showSidebar();
				return;
			case "focusTranscript":
				this.host.leaveSidebar();
				return;
		}
	}

	private pageSize(): number {
		return Math.max(1, (this.viewport()?.height ?? 20) - PAGE_OVERLAP);
	}

	/** H/M/L: jump inside the visible window without changing scroll follow behaviour. */
	private jumpToViewportRow(fraction: number, count: number): void {
		const doc = this.doc();
		const viewport = this.viewport();
		if (!doc || !viewport) return;
		const offset = fraction === 1 ? viewport.height - 1 : Math.floor((viewport.height - 1) * fraction);
		const row = viewport.top + offset + (count > 1 ? (count - 1) * (offset || 1) : 0);
		this.cursor = doc.clamp({ row, col: this.cursor.col });
		this.afterMotion(doc);
	}

	private moveByViewport(lines: number): void {
		const doc = this.doc();
		if (!doc) return;
		this.cursor = moveDown(doc, this.cursor, lines, this.desiredCol);
		if (lines < 0) this.cursor = moveUp(doc, this.cursor, -lines, this.desiredCol);
		this.afterMotion(doc);
	}

	private clearPending(): void {
		this.pendingTokens = [];
		this.pendingHint = "";
		this.count = 0;
	}

	private enterInsert(): void {
		this.clearPending();
		this.mode = "insert";
		this.anchor = undefined;
		this.host.focusEditor();
		this.host.transcript.scrollToEnd();
		this.syncCursor();
	}

	private enterNormal(): void {
		this.mode = "normal";
		this.clearPending();
		this.host.blurEditor();
		this.syncCursor({ jumpToBottom: true });
	}

	private startVisual(linewise: boolean): void {
		this.clearPending();
		this.mode = "visual";
		this.linewise = linewise;
		this.anchor = { ...this.cursor };
		this.syncCursor();
	}

	private exitVisual(): void {
		this.mode = "normal";
		this.anchor = undefined;
		this.linewise = false;
		this.clearPending();
		this.syncCursor();
	}

	private afterMotion(doc: MotionDoc): void {
		this.desiredCol ??= this.cursor.col;
		if (this.cursor.col > this.desiredCol) this.desiredCol = this.cursor.col;
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
		return { text: doc.text(this.cursor.row), rows: [this.cursor.row, this.cursor.row], label: "line" };
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
		if (ok) this.host.flash(`Yanked ${selection.label}`);
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
		this.host.flash("Quoted into the thread");
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
		this.host.flash("Forked thread");
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

	/** `:` command line, vim-style: `:q` quits, `:help` opens the cheatsheet. */
	private openCommand(): void {
		const input = new Input({ prompt: ":", placeholder: "q · help" });
		const box = new Box(1, 0, (text) => theme.bg("selectedBg", text));
		box.addChild(input);
		input.onSubmit = (value) => {
			this.closeOverlay();
			this.runCommand(value.trim());
		};
		input.onEscape = () => this.closeOverlay();
		this.overlay = this.host.ui.showOverlay(box, { anchor: "bottom-left", width: "60%", offsetY: -3 });
		this.host.ui.setFocus(input);
		this.mode = "command";
		this.host.ui.requestRender();
	}

	private runCommand(raw: string): void {
		const command = raw.replace(/^\s*:?\s*/, "");
		switch (command) {
			case "":
				return;
			case "q":
			case "q!":
			case "quit":
			case "qa":
			case "wq":
			case "x":
				this.host.quit();
				return;
			case "help":
				this.showHelp();
				return;
			default:
				this.message = `not a command: :${command}`;
				this.syncCursor();
		}
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
		this.backdrop?.hide();
		this.backdrop = undefined;
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

	/** `?`: a vim-style floating cheatsheet, generated from the keymap table. */
	private showHelp(): void {
		const terminalWidth = this.host.ui.terminal.columns;
		const terminalHeight = this.host.ui.terminal.rows;
		const sections = cheatsheetSections();
		const columns = terminalWidth >= 96 && sections.length > 2 ? 2 : 1;
		const keyPad = 11;
		const renderSection = (section: (typeof sections)[number]): string[] => [
			theme.bold(theme.fg("accent", section.title)),
			...section.entries.map(
				(entry) => `  ${theme.fg("warning", entry.keys.padEnd(keyPad))} ${theme.fg("muted", entry.desc)}`,
			),
			"",
		];

		const content: string[] = [];
		if (columns === 1) {
			for (const section of sections) content.push(...renderSection(section));
		} else {
			const columnsData: Array<typeof sections> = [[], []];
			const heights = [0, 0];
			for (const section of sections) {
				const target = heights[0] <= heights[1] ? 0 : 1;
				columnsData[target].push(section);
				heights[target] += section.entries.length + 2;
			}
			const rendered = columnsData.map((column) => column.flatMap(renderSection));
			const height = Math.max(...rendered.map((column) => column.length));
			const gap = 4;
			const colWidth = Math.floor((Math.min(terminalWidth - 12, 100) - gap) / 2);
			for (let index = 0; index < height; index++) {
				const left = rendered[0][index] ?? "";
				const right = rendered[1][index] ?? "";
				content.push(`${left}${" ".repeat(Math.max(1, colWidth - visibleWidth(left)))}${right}`.trimEnd());
			}
		}

		content.push("", theme.fg("dim", "rail: ◉ live · ● current · ◆ unread · · empty start"));
		content.push(theme.fg("dim", "press any key to close"));

		// Vim float: rounded frame, title in the top border, body on its own background.
		const width = Math.min(Math.max(40, terminalWidth - 6), 106);
		const inner = width - 2;
		const title = " euler keys ";
		const topDash = Math.max(1, inner - visibleWidth(title) - 1);
		const frame = (text: string) => theme.fg("borderAccent", text);
		const paint = (text: string) => theme.bg("toolPendingBg", text);

		const rows = Math.min(content.length, Math.max(4, terminalHeight - 4));
		const lines: string[] = [paint(frame(`╭─${title}${"─".repeat(topDash)}╮`))];
		for (let index = 0; index < rows; index++) {
			lines.push(paint(`${frame("│")} ${clampLine(content[index] ?? "", inner - 2)} ${frame("│")}`));
		}
		lines.push(paint(frame(`╰${"─".repeat(inner)}╯`)));

		const box = new Box(0, 0, (text) => theme.bg("userMessageBg", text));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		const backdrop: Component = {
			render: (backdropWidth: number) =>
				Array.from({ length: terminalHeight }, () => theme.bg("userMessageBg", " ".repeat(backdropWidth))),
			invalidate: () => {},
		};
		this.backdrop = this.host.ui.showOverlay(backdrop, {
			anchor: "center",
			width: terminalWidth,
			maxHeight: terminalHeight,
			nonCapturing: true,
		});
		this.overlay = this.host.ui.showOverlay(box, { anchor: "center", width, maxHeight: terminalHeight });
		const listener = (data: string) => {
			// The release of the key that opened the cheatsheet arrives after showOverlay(); closing
			// on it would make the panel flash for one frame.
			if (isKeyRelease(data)) return undefined;
			if (data.length > 0) {
				this.host.ui.removeInputListener(listener);
				this.closeOverlay();
				return { consume: true };
			}
			return undefined;
		};
		this.host.ui.addInputListener(listener);
	}
}

/** Clip and pad to an exact cell width (ANSI aware). */
function clampLine(text: string, width: number): string {
	return truncateToWidth(text, width, "…", true);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}
