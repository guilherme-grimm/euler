// biome-ignore-all lint/suspicious/noFocusedTests: Focusable requires a field named `focused`.
/**
 * Left-hand thread rail: every session for this workspace, with forks nested under their parent.
 *
 * The default view is the working set: threads touched in the last week. `/` switches to search,
 * which covers all history and filters as you type.
 *
 * It stays a plain component (no timers, no polling): the host refreshes the list when the rail
 * opens, after a session change, and on `r`.
 */

import { type Component, type Focusable, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../interactive/theme/theme.ts";

export interface SidebarThread {
	path: string;
	title: string;
	/** Path of the session this one was forked from, when known. */
	parentPath?: string;
	modified: Date;
	messageCount: number;
	/** Modified after the user last opened it (only within the recent window). */
	unread?: boolean;
}

export interface SidebarRow extends SidebarThread {
	depth: number;
	current: boolean;
}

export interface SidebarSnapshot {
	threads: readonly SidebarThread[];
	currentPath?: string;
	loading: boolean;
	/** The current session has a turn in flight. */
	live?: boolean;
}

export interface SidebarOptions {
	/** Snapshot of the threads to render; the host owns loading and caching. */
	read: () => SidebarSnapshot;
	/** Terminal height, used to window the list so the selection stays visible. */
	readHeight: () => number;
	/** Terminal width, used to size the rail itself (`basis: "auto"` in the layout). */
	readWidth: () => number;
	onOpen: (path: string) => void;
	onNew: () => void;
	onHide: () => void;
	/** Hand focus back to the transcript while keeping the rail visible. */
	onBlur: () => void;
	onRefresh: () => void;
	requestRender: () => void;
}

/** Placeholder path for the live session before it is written to disk. */
export const CURRENT_THREAD_KEY = "<current>";

const INDENT = 2;
const AGE_WIDTH = 4;
/** Header, rule, footer. */
const CHROME_ROWS = 3;
/** Threads older than this are out of the default view; search still reaches them. */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Nest forks under their parent, newest first; orphaned forks fall back to the root level. */
export function orderThreads(threads: readonly SidebarThread[], currentPath: string | undefined): SidebarRow[] {
	const paths = new Set(threads.map((thread) => thread.path));
	const children = new Map<string, SidebarThread[]>();
	const roots: SidebarThread[] = [];
	for (const thread of threads) {
		const parent = thread.parentPath && paths.has(thread.parentPath) ? thread.parentPath : undefined;
		if (!parent) {
			roots.push(thread);
			continue;
		}
		const siblings = children.get(parent);
		if (siblings) siblings.push(thread);
		else children.set(parent, [thread]);
	}
	// A recently updated fork lifts its parent, so the thread you just worked on stays near the top.
	const activityCache = new Map<string, number>();
	const activity = (thread: SidebarThread): number => {
		const cached = activityCache.get(thread.path);
		if (cached !== undefined) return cached;
		let newest = thread.modified.getTime();
		for (const kid of children.get(thread.path) ?? []) newest = Math.max(newest, activity(kid));
		activityCache.set(thread.path, newest);
		return newest;
	};
	const byActivity = (a: SidebarThread, b: SidebarThread) => activity(b) - activity(a);
	roots.sort(byActivity);
	const rows: SidebarRow[] = [];
	const walk = (thread: SidebarThread, depth: number) => {
		rows.push({ ...thread, depth, current: thread.path === currentPath });
		for (const kid of (children.get(thread.path) ?? []).sort(byActivity)) walk(kid, depth + 1);
	};
	for (const root of roots) walk(root, 0);
	return rows;
}

/** Compact age that always fits AGE_WIDTH: 59s, 59m, 23h, 99d, 52w, >9y. */
export function relativeAge(date: Date, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 100) return `${days}d`;
	const weeks = Math.floor(days / 7);
	if (weeks < 100) return `${weeks}w`;
	const years = Math.floor(days / 365);
	return years > 9 ? ">9y" : `${years}y`;
}

/** Clip/pad to an exact cell width so a line can never spill past the rail. */
function clampLine(text: string, width: number): string {
	return truncateToWidth(text, width, "…", true);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export class EulerSidebar implements Component, Focusable {
	focused = false;
	private selected = 0;
	private scrollTop = 0;
	private pendingG = false;
	private searching = false;
	private query = "";
	/** Memoised tree order; `snapshot.threads` keeps its identity between refreshes. */
	private orderCache?: { threads: readonly SidebarThread[]; currentPath?: string; rows: SidebarRow[] };
	private readonly options: SidebarOptions;

	constructor(options: SidebarOptions) {
		this.options = options;
	}

	invalidate(): void {}

	/** Full tree, ordered once per snapshot. */
	private ordered(snapshot: SidebarSnapshot): SidebarRow[] {
		const cache = this.orderCache;
		if (cache && cache.threads === snapshot.threads && cache.currentPath === snapshot.currentPath) return cache.rows;
		const rows = orderThreads(snapshot.threads, snapshot.currentPath);
		this.orderCache = { threads: snapshot.threads, currentPath: snapshot.currentPath, rows };
		return rows;
	}

	/** Apply the recent-window or search filter, then clamp the selection into range. */
	private visible(all: readonly SidebarRow[]): SidebarRow[] {
		const cutoff = Date.now() - RECENT_WINDOW_MS;
		const query = this.query.trim().toLowerCase();
		const rows = this.searchActive()
			? query.length === 0
				? [...all]
				: all.filter((row) => oneLine(row.title).toLowerCase().includes(query))
			: all.filter((row) => row.current || row.modified.getTime() >= cutoff);
		if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
		if (this.selected < 0) this.selected = 0;
		return rows;
	}

	/** Rows the rail actually shows: the recent working set, or search results. */
	rows(): SidebarRow[] {
		return this.visible(this.ordered(this.options.read()));
	}

	private searchActive(): boolean {
		return this.searching || this.query.length > 0;
	}

	selectCurrent(): void {
		const index = this.rows().findIndex((row) => row.current);
		if (index >= 0) this.selected = index;
	}

	handleInput(data: string): void {
		const rows = this.rows();
		const last = Math.max(0, rows.length - 1);
		const wasPendingG = this.pendingG;
		this.pendingG = false;

		if (wasPendingG && data === "g") {
			this.selected = 0;
			this.options.requestRender();
			return;
		}

		// Search: typing filters across all history; arrows move, Enter opens, Esc clears.
		if (this.searching) {
			if (data === "\x1b") {
				if (this.query.length > 0) this.query = "";
				else this.searching = false;
			} else if (data === "\x7f" || data === "\x08") {
				this.query = this.query.slice(0, -1);
			} else if (data === "\r" || data === "\n") {
				const row = rows[this.selected];
				this.searching = this.query.length > 0;
				if (row && !row.current) this.options.onOpen(row.path);
				else if (row?.current) this.searching = false;
			} else if (data === "\x1b[A") {
				this.selected = Math.max(0, this.selected - 1);
			} else if (data === "\x1b[B") {
				this.selected = Math.min(last, this.selected + 1);
			} else if (data.length === 1 && data >= " ") {
				this.query += data;
				this.selected = 0;
			}
			this.options.requestRender();
			return;
		}

		switch (data) {
			case "j":
			case "\x1b[B":
				this.selected = Math.min(last, this.selected + 1);
				break;
			case "k":
			case "\x1b[A":
				this.selected = Math.max(0, this.selected - 1);
				break;
			case "g":
				this.pendingG = true;
				this.options.requestRender();
				return;
			case "G":
				this.selected = last;
				break;
			case "\x04":
				this.selected = Math.min(last, this.selected + 5);
				break;
			case "\x15":
				this.selected = Math.max(0, this.selected - 5);
				break;
			case "/":
				this.searching = true;
				this.query = "";
				this.selected = 0;
				break;
			case "\r":
			case "\n": {
				const row = rows[this.selected];
				if (row && !row.current) this.options.onOpen(row.path);
				else this.options.onHide();
				return;
			}
			case "n":
				this.options.onNew();
				return;
			case "r":
				this.options.onRefresh();
				return;
			case "\x0c":
				this.options.onBlur();
				return;
			case "e":
			case "q":
			case "\x1b":
				this.options.onHide();
				return;
			default:
				return;
		}
		this.options.requestRender();
	}

	render(_width: number): string[] {
		const snapshot = this.options.read();
		const all = this.ordered(snapshot);
		const rows = this.visible(all);
		// The rail owns its width so the layout can use `basis: "auto"` and follow resizes.
		const width = Math.min(38, Math.max(26, Math.floor(this.options.readWidth() * 0.28)));
		const inner = Math.max(10, width - 1);
		const totalHeight = Math.max(6, this.options.readHeight());
		const border = theme.fg("dim", "│");
		const ruleColor = this.focused ? "borderAccent" : "borderMuted";
		const lines: string[] = [];

		// Header + rule: the rail's "winbar", brighter while it owns focus.
		const hidden = all.length - rows.length;
		const header = this.searchActive()
			? ` /${this.query}`
			: ` threads ${rows.length}${hidden > 0 ? ` · +${hidden} older` : ""} `;
		lines.push(clampLine(theme.bold(theme.fg(ruleColor as never, header.padEnd(inner))), inner));
		lines.push(clampLine(theme.fg(ruleColor as never, "─".repeat(inner)), inner));

		if (rows.length === 0) {
			const message = snapshot.loading
				? " loading…"
				: this.searchActive()
					? " no match"
					: " nothing this week · / searches all";
			lines.push(clampLine(theme.fg("muted", message), inner));
		} else {
			const viewHeight = Math.max(3, totalHeight - CHROME_ROWS);
			if (this.selected < this.scrollTop) this.scrollTop = this.selected;
			if (this.selected >= this.scrollTop + viewHeight) this.scrollTop = this.selected - viewHeight + 1;
			const end = Math.min(rows.length, this.scrollTop + viewHeight);

			for (let index = this.scrollTop; index < end; index++) {
				const row = rows[index] as SidebarRow;
				const live = row.current && snapshot.live;
				const marker = live ? "◉" : row.current ? "●" : row.unread ? "◆" : row.messageCount === 0 ? "·" : "○";
				const glyphColor = live ? "success" : row.current || row.unread ? "accent" : "muted";
				const connector = row.depth > 0 ? "└ " : "";
				const indent = " ".repeat(Math.max(0, row.depth - 1) * INDENT);
				const age = relativeAge(row.modified).padStart(AGE_WIDTH);
				const prefixWidth = visibleWidth(connector) + visibleWidth(marker) + 1 + visibleWidth(indent);
				const titleWidth = Math.max(4, inner - prefixWidth - AGE_WIDTH - 1);
				const title = sliceByColumn(oneLine(row.title), 0, titleWidth, true);
				const gap = " ".repeat(Math.max(1, inner - prefixWidth - visibleWidth(title) - AGE_WIDTH));
				const titleColor = row.current || row.unread ? "text" : "muted";
				const body = `${connector}${theme.fg(glyphColor as never, marker)} ${indent}${theme.fg(titleColor, title)}${gap}${theme.fg("dim", age)}`;
				const fitted = clampLine(body, inner);
				const selected = this.focused && index === this.selected;
				lines.push(selected ? theme.bg("selectedBg", fitted) : fitted);
			}

			if (rows.length > viewHeight) {
				lines.push(clampLine(theme.fg("dim", ` ${this.selected + 1}/${rows.length}`), inner));
			}
		}

		while (lines.length < totalHeight - 1) lines.push(" ".repeat(inner));
		// Longest hint that still fits, so narrow rails stay readable instead of showing "e hi…".
		const hints = this.searchActive()
			? [" type to filter · ↑↓ move · ⏎ open · esc clear", " filter · ↑↓ · ⏎ · esc", " /"]
			: [" j/k move · / search · ⏎ open · n new · e hide", " j/k · / search · ⏎ open · e hide", " j/k · / · ⏎ · e"];
		const hint = hints.find((candidate) => visibleWidth(candidate) <= inner) ?? hints.at(-1) ?? "";
		lines.push(clampLine(theme.fg("dim", hint), inner));
		return lines.map((line) => `${line}${border}`);
	}
}
