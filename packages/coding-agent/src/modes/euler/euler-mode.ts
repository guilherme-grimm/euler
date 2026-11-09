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
	type TUI,
	type TuiAltScreen,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../interactive/theme/theme.ts";
import { BRAND_MARK, brand } from "./euler-look.ts";
import type { EulerModeName, EulerStatusData } from "./euler-status.ts";
import { isT3Live, type T3Snapshot, type T3StartOptions, type T3Thread, type T3ThreadDetail } from "./euler-t3.ts";
import type { UsageSnapshot, UsageWindow } from "./euler-usage.ts";
import { compactTokens, until } from "./euler-voice.ts";
import { EULER_STARTUP_HINT } from "./identity.ts";
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

/** Live window report for `:context`. */
export interface EulerContextReport {
	model?: string;
	tokens: number | null;
	percent: number | null;
	contextWindow: number;
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	compactions: number;
	contextEdits: number;
	lastCompaction?: { tokensBefore: number };
	messages: number;
	turns: number;
	cacheRead?: number;
	freshInput?: number;
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
	/** Compact/comfortable rail rows (`:density`, `v` in the rail). */
	toggleDensity(): void;
	/** Open the rail if needed and focus it. */
	showSidebar(): void;
	/** Return focus to the transcript without closing the rail. */
	leaveSidebar(): void;
	/** Transient confirmation in the alt-screen flash stack. */
	flash(message: string): void;
	/** Leave the application (`:q`). */
	quit(): void;
	/** `:e` — hand the current prompt to $VISUAL/$EDITOR. */
	openEditor(): void;
	/** `:new` — start a fresh session. */
	newSession(): void;
	focusEditor(): void;
	blurEditor(): void;
	showStatus(text: string): void;
	showError(text: string): void;
	isStreaming(): boolean;
	/** True when a component other than the editor holds focus (pi selectors, pickers, dialogs). */
	hasForeignFocus(): boolean;
	sessionName(): string;
	parentName(): string | undefined;
	/** Active model + thinking level for the statusline chip. */
	modelInfo(): { name: string; thinking?: string } | undefined;
	/** Open pi's model picker (`:model`). */
	showModels(): void;
	/** Compact quota segment for the statusline, for the active model's provider. */
	usageSegment(): { label: string; percent: number } | undefined;
	/** Subscription quota snapshot (windows + loading) for `:usage`. */
	usage(): UsageSnapshot;
	/** Force a usage refresh before `:usage` renders. */
	refreshUsage(): void;
	/** Live context window report for `:context`. */
	contextReport(): EulerContextReport | undefined;
	/** Start a background T3 Code thread; returns its id. */
	t3Start(message: string, options: T3StartOptions): Promise<string>;
	/** Steer a T3 thread and return the reply (or its terminal status). */
	t3Send(threadId: string, message: string): Promise<string>;
	t3Refresh(): void;
	t3Open(link: string): void;
	t3Snapshot(): T3Snapshot;
	t3Show(threadId: string): Promise<T3ThreadDetail>;
	t3Defaults(): T3StartOptions;
}

const SCROLL_OFF = 10;
/** Actions that make sense before any transcript exists (host-level or overlay actions). */
const DOC_FREE_ACTIONS = new Set<EulerAction>([
	"help",
	"sessions",
	"tree",
	"sidebar",
	"newSession",
	"focusSidebar",
	"focusTranscript",
	"insert",
	"command",
]);
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
	/** When the current turn started, for the `working 12s` label; cleared when it settles. */
	private streamingSince?: number;
	private overlay?: OverlayHandle;
	/** One-shot listener that closes an informational overlay; removed with the overlay. */
	private overlayKeyListener?: (data: string) => { consume?: boolean } | undefined;
	private detach?: () => void;
	private readonly host: EulerHost;

	constructor(host: EulerHost) {
		this.host = host;
	}

	attach(): void {
		this.detach = this.host.ui.addInputListener((data) => this.handleInput(data));
		// First-run discoverability: cleared as soon as the user presses anything.
		this.message = EULER_STARTUP_HINT;
		this.syncCursor({ jumpToBottom: true });
	}

	dispose(): void {
		this.detach?.();
		this.detach = undefined;
		this.host.renderer.setKeyboardState(undefined);
		this.overlay?.hide();
		this.overlay = undefined;
		this.clearOverlayListener();
	}

	statusData(): EulerStatusData {
		const total = this.host.renderer.getViewportSnapshot(this.host.transcript)?.lines.length ?? 0;
		const count = this.count > 0 ? String(this.count) : "";
		const pending = this.pendingTokens.length > 0 ? displayKeys(this.pendingTokens.join(" ")) : "";
		const streaming = this.host.isStreaming();
		if (streaming) this.streamingSince ??= Date.now();
		else this.streamingSince = undefined;
		return {
			mode: this.mode,
			line: Math.min(this.cursor.row + 1, Math.max(1, total)),
			total,
			sessionName: this.host.sessionName(),
			parent: this.host.parentName(),
			model: this.host.modelInfo(),
			usage: this.host.usageSegment(),
			streaming,
			workingMs: this.streamingSince === undefined ? undefined : Date.now() - this.streamingSince,
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
		if (!doc && !DOC_FREE_ACTIONS.has(action)) {
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
			case "newSession":
				this.host.newSession();
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
		const input = new Input({ prompt: ":", placeholder: "q · model · usage · context · help" });
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
		if (command === "t3" || command.startsWith("t3 ")) {
			this.runT3(command.slice(2).trim());
			return;
		}
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
			case "e":
			case "edit":
				this.host.openEditor();
				return;
			case "threads":
			case "t":
				this.host.toggleSidebar();
				return;
			case "density":
				this.host.toggleDensity();
				return;
			case "model":
				this.host.showModels();
				return;
			case "usage":
				this.showUsage();
				return;
			case "context":
				this.showContext();
				return;
			case "new":
				this.host.newSession();
				return;
			case "fork":
				void this.forkAtLeaf();
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

	private clearOverlayListener(): void {
		if (!this.overlayKeyListener) return;
		this.host.ui.removeInputListener(this.overlayKeyListener);
		this.overlayKeyListener = undefined;
	}

	private closeOverlay(): void {
		this.clearOverlayListener();
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

	/** `?`: a vim-style floating cheatsheet, generated from the keymap table. */
	private showHelp(): void {
		const terminalWidth = this.host.ui.terminal.columns;
		const sections = cheatsheetSections();
		type Section = (typeof sections)[number];
		const keyPad = Math.max(
			6,
			...sections.flatMap((section) => section.entries.map((entry) => visibleWidth(entry.keys))),
		);
		const renderSection = (section: Section, pad: number): string[] => [
			theme.bold(theme.fg("accent", section.title)),
			...section.entries.map(
				(entry) => `  ${theme.fg("warning", entry.keys.padEnd(pad))} ${theme.fg("muted", entry.desc)}`,
			),
			"",
		];

		// Two columns when the terminal allows it; each section lands in the shorter column.
		const twoColumns = terminalWidth >= 84 && sections.length > 2;
		const columnSections: Section[][] = twoColumns ? [[], []] : [sections];
		if (twoColumns) {
			const heights = [0, 0];
			for (const section of sections) {
				const target = heights[0] <= heights[1] ? 0 : 1;
				columnSections[target]?.push(section);
				heights[target] = (heights[target] ?? 0) + section.entries.length + 2;
			}
		}
		// Size each column to its own content: the popup should hug the keys, not the terminal.
		const paddings = columnSections.map((column) =>
			Math.max(4, ...column.flatMap((section) => section.entries.map((entry) => visibleWidth(entry.keys)))),
		);
		const sectionWidth = (section: Section, pad: number): number =>
			Math.max(
				visibleWidth(section.title),
				...section.entries.map((entry) => 2 + pad + 1 + visibleWidth(entry.desc)),
			);
		const widths = columnSections.map((column, index) =>
			Math.max(10, ...column.map((section) => sectionWidth(section, paddings[index] ?? 6))),
		);
		const gap = 4;
		const contentWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
		const rendered = columnSections.map((column, index) =>
			column.flatMap((section) => renderSection(section, paddings[index] ?? keyPad)),
		);
		const height = Math.max(...rendered.map((column) => column.length));
		const content: string[] = [];
		for (let index = 0; index < height; index++) {
			const cells = rendered.map((column, cell) => clampLine(column[index] ?? "", widths[cell] ?? 10));
			content.push(cells.join(" ".repeat(gap)).trimEnd());
		}
		while (content.at(-1) === "") content.pop();
		content.push("", theme.fg("dim", "rail: ⠹ working · ● current · ◆ unread · · empty · v density"));
		content.push(theme.fg("dim", "press any key to close"));

		this.showPopup("keys", () => content, Math.max(24, Math.min(contentWidth + 4, terminalWidth - 4)));
	}

	/** `:t3` — T3 Code background threads: list, start, steer, open. */
	private runT3(rest: string): void {
		const tokens = rest.split(/\s+/).filter(Boolean);
		const sub = tokens.shift() ?? "";
		if (sub === "" || sub === "list" || sub === "help") {
			this.showT3();
			return;
		}
		if (sub === "start") {
			const options: T3StartOptions = {};
			const message: string[] = [];
			for (let index = 0; index < tokens.length; index++) {
				const token = tokens[index];
				const value = tokens[index + 1];
				if (
					(token === "--worktree" ||
						token === "--branch" ||
						token === "--provider" ||
						token === "--model" ||
						token === "--title") &&
					value
				) {
					const key = token.slice(2) as keyof T3StartOptions;
					options[key] = value;
					index++;
				} else message.push(token ?? "");
			}
			const text = message.join(" ").trim();
			if (text.length === 0) {
				this.message = "usage: :t3 start [--worktree ref] [--provider id --model slug] <message>";
				this.syncCursor();
				return;
			}
			this.message = "starting t3 thread…";
			this.syncCursor();
			void this.host
				.t3Start(text, options)
				.then((threadId) => {
					this.host.t3Refresh();
					this.message = `t3 started · ${threadId.split(":").at(-1)?.slice(0, 8) ?? threadId}`;
					this.syncCursor();
				})
				.catch((error) => {
					this.message = `t3: ${error instanceof Error ? error.message : String(error)}`;
					this.syncCursor();
				});
			return;
		}
		if (sub === "send") {
			const thread = this.resolveT3Thread(tokens.shift());
			const text = tokens.join(" ").trim();
			if (!thread || text.length === 0) {
				this.message = "usage: :t3 send <n|id> <message>";
				this.syncCursor();
				return;
			}
			this.message = "t3: sending…";
			this.syncCursor();
			void this.host
				.t3Send(thread.threadId, text)
				.then((reply) => {
					this.host.t3Refresh();
					this.message = `t3 · ${firstLine(reply).slice(0, 70)}`;
					this.syncCursor();
				})
				.catch((error) => {
					this.message = `t3: ${error instanceof Error ? error.message : String(error)}`;
					this.syncCursor();
				});
			return;
		}
		if (sub === "open") {
			const thread = this.resolveT3Thread(tokens.shift());
			if (!thread?.link) {
				this.message = "t3: no link for that thread";
				this.syncCursor();
				return;
			}
			this.host.t3Open(thread.link);
			this.message = "t3: opened";
			this.syncCursor();
			return;
		}
		if (sub === "show") {
			const thread = this.resolveT3Thread(tokens.shift());
			if (!thread) {
				this.message = "t3: unknown thread";
				this.syncCursor();
				return;
			}
			this.showT3Detail(thread);
			return;
		}
		this.message = `not a t3 command: ${sub}`;
		this.syncCursor();
	}

	private resolveT3Thread(target: string | undefined): T3Thread | undefined {
		if (!target) return undefined;
		const threads = this.host.t3Snapshot().threads;
		const index = Number(target);
		return Number.isInteger(index) && index > 0
			? threads[index - 1]
			: threads.find((thread) => thread.threadId === target);
	}

	/** Rail `d`: detail for the selected external thread, without opening the browser. */
	showT3Thread(threadId: string): void {
		const thread = this.host.t3Snapshot().threads.find((candidate) => candidate.threadId === threadId);
		if (thread) this.showT3Detail(thread);
	}

	/** Rail `s`: send to the selected external thread. */
	promptT3Send(threadId: string): void {
		const short = threadId.split(":").at(-1)?.slice(0, 8) ?? threadId;
		this.openT3Input("t3> ", `message to ${short}`, (text) => {
			if (text.length === 0) return;
			this.message = "t3: sending…";
			this.syncCursor();
			void this.host
				.t3Send(threadId, text)
				.then((reply) => {
					this.host.t3Refresh();
					this.message = `t3 · ${firstLine(reply).slice(0, 70)}`;
					this.syncCursor();
				})
				.catch((error) => {
					this.message = `t3: ${error instanceof Error ? error.message : String(error)}`;
					this.syncCursor();
				});
		});
	}

	/** Rail `N`: start a thread with the last provider/model/worktree defaults. */
	promptT3Start(): void {
		const defaults = this.host.t3Defaults();
		if (!defaults.provider || !defaults.model) {
			this.message = "t3: set defaults once with :t3 start [--provider id --model slug] <message>";
			this.syncCursor();
			return;
		}
		const hint = [defaults.worktree ? `on ${defaults.worktree}` : "", `${defaults.provider} ${defaults.model}`]
			.filter(Boolean)
			.join(" · ");
		this.openT3Input("t3 start> ", hint, (text) => {
			if (text.length === 0) return;
			this.message = "starting t3 thread…";
			this.syncCursor();
			void this.host
				.t3Start(text, defaults)
				.then((threadId) => {
					this.host.t3Refresh();
					this.message = `t3 started · ${threadId.split(":").at(-1)?.slice(0, 8) ?? threadId}`;
					this.syncCursor();
				})
				.catch((error) => {
					this.message = `t3: ${error instanceof Error ? error.message : String(error)}`;
					this.syncCursor();
				});
		});
	}

	private showT3Detail(thread: T3Thread): void {
		this.message = "t3: reading…";
		this.syncCursor();
		void this.host
			.t3Show(thread.threadId)
			.then((detail) => {
				const shown = detail.thread;
				const statusColor = shown.status === "failed" ? "error" : isT3Live(shown.status) ? "success" : "muted";
				const lines = [
					theme.bold(theme.fg("text", shown.title)),
					`${theme.fg("dim", "status")} ${theme.fg(statusColor, shown.status)}${shown.model ? theme.fg("dim", ` · ${[shown.provider, shown.model].filter(Boolean).join(" ")}`) : ""}`,
					shown.branch ? `${theme.fg("dim", "branch")} ${shown.branch}` : "",
					shown.worktreePath ? `${theme.fg("dim", "worktree")} ${shown.worktreePath}` : "",
					shown.link ? `${theme.fg("dim", "link")} ${shown.link}` : "",
					"",
					...detail.messages.map(
						(message) => `${theme.fg("dim", `${message.role}:`)} ${firstLine(message.text).slice(0, 100)}`,
					),
					"",
					theme.fg("dim", ":t3 open <n> to review in T3 · any key closes"),
				].filter((line) => line.length > 0);
				this.message = "";
				this.showPopup("t3 thread", () => lines, 76);
			})
			.catch((error) => {
				this.message = `t3: ${error instanceof Error ? error.message : String(error)}`;
				this.syncCursor();
			});
	}

	private openT3Input(prompt: string, placeholder: string, submit: (value: string) => void): void {
		if (this.overlay) this.closeOverlay();
		const input = new Input({ prompt, placeholder });
		const box = new Box(1, 0, (text) => theme.bg("selectedBg", text));
		box.addChild(input);
		input.onSubmit = (value) => {
			this.closeOverlay();
			submit(value.trim());
		};
		input.onEscape = () => this.closeOverlay();
		this.overlay = this.host.ui.showOverlay(box, { anchor: "bottom-left", width: "70%", offsetY: -3 });
		this.host.ui.setFocus(input);
		this.mode = "command";
		this.host.ui.requestRender();
	}

	private showT3(): void {
		this.host.t3Refresh();
		this.showPopup("t3", () => this.t3Lines(), 70);
	}

	private t3Lines(): string[] {
		const snapshot = this.host.t3Snapshot();
		if (!snapshot.available) {
			return [
				"",
				theme.fg("muted", ` ${snapshot.error ?? "t3 unavailable"}`),
				theme.fg("dim", " install the server: ~/.t3/bin/t3 service install"),
				"",
			];
		}
		const threads = snapshot.threads;
		const lines: string[] = [
			`${theme.bold(theme.fg("text", "T3 Code"))}${theme.fg("dim", ` · ${threads.length} thread${threads.length === 1 ? "" : "s"}`)}`,
		];
		if (threads.length === 0) {
			lines.push("", theme.fg("muted", " no background threads"));
		}
		for (const [index, thread] of threads.entries()) {
			const color = thread.status === "failed" ? "error" : isT3Live(thread.status) ? "success" : "muted";
			lines.push(
				"",
				`${theme.fg("dim", String(index + 1).padStart(2))} ${theme.fg(color, thread.status.padEnd(9))} ${theme.bold(theme.fg("text", thread.title))}`,
			);
			const meta = [thread.branch, [thread.provider, thread.model].filter(Boolean).join(" ")]
				.filter(Boolean)
				.join(" · ");
			if (meta.length > 0) lines.push(`   ${theme.fg("dim", meta)}`);
		}
		lines.push("", theme.fg("dim", " :t3 start [--worktree ref] [--provider id --model slug] <message>"));
		lines.push(theme.fg("dim", " :t3 send <n> <message> · :t3 open <n> · Enter in the rail opens"));
		return lines;
	}

	/** `:usage` — subscription quota windows in percent, refreshed on open. */
	private showUsage(): void {
		this.host.refreshUsage();
		this.showPopup("usage", () => this.usageLines(), 64);
	}

	private usageLines(): string[] {
		const { accounts, loading } = this.host.usage();
		if (accounts.length === 0) {
			return [
				"",
				theme.fg("muted", loading ? " reading usage…" : " no subscription usage to show"),
				theme.fg("dim", " log in with Claude Pro/Max or ChatGPT · i then /login"),
				"",
			];
		}
		const windows = accounts.flatMap((account) => account.windows);
		const labelWidth = Math.max(5, ...windows.map((window) => visibleWidth(window.label)));
		const lines: string[] = [];
		for (const account of accounts) {
			const plan = account.plan
				? ` ${theme.fg(
						"dim",
						account.plan.replace(/^[a-z]/, (c) => c.toUpperCase()),
					)}`
				: "";
			lines.push(`${theme.bold(theme.fg("text", account.label))}${plan}`);
			if (account.error) lines.push(`  ${theme.fg("warning", account.error)}`);
			else if (account.note) lines.push(`  ${theme.fg("dim", account.note)}`);
			for (const window of account.windows) lines.push(this.usageRow(window, labelWidth));
			lines.push("");
		}
		while (lines.at(-1) === "") lines.pop();
		lines.push(
			"",
			theme.fg("dim", loading ? " reading usage…" : " provider windows · cached 60s · :usage refreshes"),
		);
		return lines;
	}

	private usageRow(window: UsageWindow, labelWidth: number): string {
		const percent = Math.round(window.usedPercent);
		const color = percent >= 80 ? "error" : percent >= 50 ? "warning" : "success";
		const filled = Math.round((percent / 100) * 10);
		const bar = theme.fg(color, `${"█".repeat(filled)}${"░".repeat(10 - filled)}`);
		const reset = window.resetsAt ? `  ${theme.fg("dim", this.resetLabel(window.resetsAt))}` : "";
		const value = theme.fg(color, `${String(percent).padStart(3)}%`);
		return `  ${theme.fg("muted", window.label.padEnd(labelWidth))}  ${value}${reset}  ${bar}`;
	}

	private resetLabel(resetsAt: string): string {
		const at = Date.parse(resetsAt);
		if (!Number.isFinite(at)) return "";
		const ms = at - Date.now();
		return ms <= 0 ? "resets now" : `resets in ${until(ms)}`;
	}

	/** `:context` — live window state, compaction threshold and cache split. */
	private showContext(): void {
		this.showPopup("context", () => this.contextLines(), 64);
	}

	private contextLines(): string[] {
		const report = this.host.contextReport();
		if (!report) return ["", theme.fg("muted", " context unavailable · no active model window"), ""];
		const row = (label: string, value: string) => `  ${theme.fg("muted", label.padEnd(10))} ${value}`;
		const header = `${theme.bold(theme.fg("text", "Context"))}${report.model ? ` ${theme.fg("dim", report.model)}` : ""}`;
		if (report.tokens === null) {
			return [
				header,
				"",
				row("window", theme.fg("muted", compactTokens(report.contextWindow))),
				row("used", theme.fg("dim", "unknown until the next reply")),
			];
		}
		const percent = report.percent ?? 0;
		const color = percent >= 80 ? "error" : percent >= 50 ? "warning" : "success";
		const filled = Math.round((percent / 100) * 20);
		const bar = theme.fg(color, `${"█".repeat(filled)}${"░".repeat(20 - filled)}`);
		const threshold = report.enabled
			? theme.fg("text", compactTokens(report.contextWindow - report.reserveTokens))
			: theme.fg("dim", "disabled");
		const lines = [
			header,
			`  ${theme.fg("muted", `${compactTokens(report.tokens)} / ${compactTokens(report.contextWindow)}`)}  ${theme.fg(color, `${percent.toFixed(1)}%`)}`,
			`  ${bar}`,
			"",
			row("threshold", threshold),
			row(
				"reserve",
				theme.fg(
					"dim",
					`${compactTokens(report.reserveTokens)} · keeps ${compactTokens(report.keepRecentTokens)} after compaction`,
				),
			),
		];
		if (report.cacheRead !== undefined && report.freshInput !== undefined) {
			const total = report.cacheRead + report.freshInput;
			const rate = total > 0 ? (report.cacheRead / total) * 100 : 0;
			lines.push(
				row(
					"cache",
					theme.fg(
						"dim",
						`${compactTokens(report.cacheRead)} cached · ${compactTokens(report.freshInput)} fresh (${rate.toFixed(1)}%)`,
					),
				),
			);
		}
		lines.push(row("session", theme.fg("dim", `${report.messages} msgs · ${report.turns} turns`)));
		const parts: string[] = [
			report.compactions === 0
				? "none"
				: `${report.compactions}${report.lastCompaction ? ` · last at ${compactTokens(report.lastCompaction.tokensBefore)}` : ""}`,
		];
		if (report.contextEdits > 0) parts.push(`${report.contextEdits} context edits`);
		lines.push(row("compaction", theme.fg("dim", parts.join(" · "))));
		return lines;
	}

	/**
	 * Floating popup shared by `?`, `:usage` and `:context`: opaque, one-cell drop shadow, no backdrop
	 * so the transcript stays visible around it. `content` is lazy, so a probe that lands while the
	 * panel is open shows up on the next frame. Any key closes it.
	 */
	private showPopup(title: string, content: () => string[], width?: number): void {
		const terminalWidth = this.host.ui.terminal.columns;
		const terminalHeight = this.host.ui.terminal.rows;
		const widest = Math.max(1, ...content().map((line) => visibleWidth(line)));
		const panelWidth = Math.max(24, Math.min(width ?? widest + 4, terminalWidth - 4));
		const titleText = ` ${brand(BRAND_MARK)} ${theme.bold(theme.fg("text", `euler ${title}`))} `;
		const popup: Component = {
			render: () => this.renderPopup(titleText, content(), panelWidth, terminalHeight),
			invalidate: () => {},
		};
		const box = new Box(0, 0);
		box.addChild(popup);
		this.overlay = this.host.ui.showOverlay(box, {
			anchor: "center",
			width: panelWidth + 1,
			maxHeight: terminalHeight,
		});
		const listener = (data: string) => {
			// The release of the key that opened the panel arrives after showOverlay(); closing on it
			// would make the panel flash for one frame.
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

	private renderPopup(title: string, content: string[], panelWidth: number, terminalHeight: number): string[] {
		const textWidth = panelWidth - 4;
		const frame = (text: string) => theme.fg("borderAccent", text);
		const paint = (text: string) => theme.bg("toolPendingBg", text);
		const topDash = Math.max(1, panelWidth - 2 - visibleWidth(title) - 1);
		const rows = Math.min(content.length, Math.max(4, terminalHeight - 4));
		const lines: string[] = [paint(frame(`╭─${title}${"─".repeat(topDash)}╮`))];
		for (let index = 0; index < rows; index++) {
			lines.push(paint(`${frame("│")} ${clampLine(content[index] ?? "", textWidth)} ${frame("│")}`));
		}
		lines.push(paint(frame(`╰${"─".repeat(panelWidth - 2)}╯`)));
		const shadow = theme.bg("selectedBg", " ");
		const shadowRow = theme.bg("selectedBg", " ".repeat(panelWidth));
		return [...lines.map((line) => `${line}${shadow}`), ` ${shadowRow}`];
	}
}

/** Clip and pad to an exact cell width (ANSI aware). */
function clampLine(text: string, width: number): string {
	return truncateToWidth(text, width, "…", true);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}
