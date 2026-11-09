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

import { type Component, type Focusable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../interactive/theme/theme.ts";
import { BRAND_MARK, brand, spinnerFrame } from "./euler-look.ts";
import { threadMeta } from "./euler-voice.ts";

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

/** Two-line rows with metadata, or one dense line per thread. */
export type SidebarDensity = "comfortable" | "compact";

export interface SidebarOptions {
	/** Snapshot of the threads to render; the host owns loading and caching. */
	read: () => SidebarSnapshot;
	/** Terminal height, used to window the list so the selection stays visible. */
	readHeight: () => number;
	/** Terminal width, used to size the rail itself (`basis: "auto"` in the layout). */
	readWidth: () => number;
	/** Two-line rows with metadata, or one dense line per thread. */
	density: () => SidebarDensity;
	onDensity: (density: SidebarDensity) => void;
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
			case "v":
				this.options.onDensity(this.options.density() === "compact" ? "comfortable" : "compact");
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
		const density = this.options.density();
		const now = Date.now();
		// The rail owns its width so the layout can use `basis: "auto"` and follow resizes.
		const width = Math.min(38, Math.max(26, Math.floor(this.options.readWidth() * 0.28)));
		const inner = Math.max(10, width - 1);
		const totalHeight = Math.max(6, this.options.readHeight());
		const available = Math.max(3, totalHeight - CHROME_ROWS);
		const border = theme.fg("dim", "│");

		// One display list: section headers and rows share the window, so it scrolls like text. Items are
		// whole — a two-line row is never cut in half by the viewport.
		interface RailItem {
			height: number;
			offset: number;
			row?: number;
			lines: string[];
		}
		const items: RailItem[] = [];
		const section = (
			title: string,
			live: boolean,
			note: string | undefined,
			entries: Array<{ row: SidebarRow; index: number }>,
		): void => {
			const count = String(entries.length);
			const label = live ? theme.bold(brand(title.toUpperCase())) : theme.bold(theme.fg("dim", title.toUpperCase()));
			const total = live ? brand(count) : theme.fg("dim", count);
			const tail = note ? `${theme.fg("dim", note)} ${total}` : total;
			const lead = ` ${label}`;
			const gap = Math.max(1, inner - visibleWidth(lead) - visibleWidth(tail));
			items.push({ height: 1, offset: 0, lines: [clampLine(`${lead}${" ".repeat(gap)}${tail}`, inner)] });
			for (const entry of entries) {
				const lines = this.renderRow(entry.row, entry.index, { inner, density, now, live });
				items.push({ height: lines.length, offset: 0, row: entry.index, lines });
			}
		};

		const older = all.length > rows.length ? `+${all.length - rows.length} older` : undefined;
		if (rows.length === 0) {
			items.push({ height: 1, offset: 0, lines: [clampLine(this.emptyState(snapshot), inner)] });
		} else if (this.searchActive()) {
			section(
				this.query.length > 0 ? "matches" : "all threads",
				false,
				undefined,
				rows.map((row, index) => ({ row, index })),
			);
		} else {
			const entries = rows.map((row, index) => ({ row, index }));
			const working = entries.filter((entry) => entry.row.current && snapshot.live);
			const idle = entries.filter((entry) => !working.includes(entry));
			if (working.length > 0) section("working", true, idle.length === 0 ? older : undefined, working);
			if (idle.length > 0) section("idle", false, older, idle);
		}

		let offset = 0;
		for (const item of items) {
			item.offset = offset;
			offset += item.height;
		}
		// Keep the selected thread in the window, then snap to an item boundary so nothing renders half.
		const selected = items.find((item) => item.row === this.selected);
		if (selected) {
			const bottom = selected.offset + selected.height;
			if (selected.offset < this.scrollTop) this.scrollTop = selected.offset;
			else if (bottom > this.scrollTop + available) this.scrollTop = bottom - available;
		}
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, offset - available)));
		const start = items.findIndex((item) => item.offset + item.height > this.scrollTop);
		if (start >= 0 && items[start]) this.scrollTop = items[start].offset;

		const body: string[] = [];
		for (let index = Math.max(0, start); index < items.length; index++) {
			const item = items[index];
			if (!item || body.length + item.height > available) break;
			body.push(...item.lines);
		}
		while (body.length < available) body.push(" ".repeat(inner));

		const searching = this.searchActive();
		const lead = ` ${brand(BRAND_MARK)} ${theme.bold(theme.fg("text", "euler"))}`;
		const trail = searching
			? theme.fg("dim", `/${this.query}`)
			: snapshot.loading || snapshot.live
				? brand(spinnerFrame(now))
				: "";
		const headerGap = Math.max(1, inner - visibleWidth(lead) - visibleWidth(trail));
		// Longest hint that still fits, so narrow rails stay readable instead of showing "e hi…".
		const hints = searching
			? [" type to filter · ↑↓ move · ⏎ open", " filter · ↑↓ · ⏎ · esc", " /"]
			: [" j/k · / search · v view · ⏎ open", " j/k · / · v view · ⏎", " j/k · / · v · ⏎"];
		const hint = hints.find((candidate) => visibleWidth(candidate) <= inner) ?? hints.at(-1) ?? "";
		return [
			`${clampLine(`${lead}${" ".repeat(headerGap)}${trail}`, inner)}${border}`,
			`${theme.fg("borderMuted", "─".repeat(inner))}${border}`,
			...body.map((line) => `${line}${border}`),
			`${clampLine(theme.fg("dim", hint), inner)}${border}`,
		];
	}

	/** One thread: a title line plus metadata (comfortable), or a single dense line (compact). */
	private renderRow(
		row: SidebarRow,
		index: number,
		options: { inner: number; density: SidebarDensity; now: number; live: boolean | undefined },
	): string[] {
		const { inner, density, now } = options;
		const live = row.current && options.live === true;
		const marker = live
			? spinnerFrame(now)
			: row.current
				? "●"
				: row.unread
					? "◆"
					: row.messageCount === 0
						? "·"
						: "○";
		const markerColor: ThemeColor =
			live || row.current ? "text" : row.unread ? "accent" : row.messageCount === 0 ? "dim" : "muted";
		const paintedMarker = live || row.current ? brand(marker) : theme.fg(markerColor, marker);
		const gutter = row.current ? brand("▎") : " ";
		const branch = row.depth > 0 ? `${" ".repeat(Math.max(0, row.depth - 1) * INDENT)}${theme.fg("dim", "└ ")}` : "";
		const lead = `${gutter}${paintedMarker} ${branch}`;
		const title = oneLine(row.title);
		const titleColor: ThemeColor = row.current || row.unread ? "text" : "muted";
		const selected = this.focused && index === this.selected;
		const paint = (text: string): string => {
			const fitted = clampLine(text, inner);
			return selected ? theme.bg("selectedBg", fitted) : fitted;
		};

		if (density === "compact") {
			const age = relativeAge(row.modified, now).padStart(AGE_WIDTH);
			const titleWidth = Math.max(4, inner - visibleWidth(lead) - AGE_WIDTH - 1);
			const painted = `${lead}${theme.fg(titleColor, truncateToWidth(title, titleWidth, "…"))}`;
			const gap = Math.max(1, inner - visibleWidth(painted) - AGE_WIDTH);
			return [paint(`${painted}${" ".repeat(gap)}${theme.fg("dim", age)}`)];
		}

		const meta = threadMeta(row.messageCount, row.depth > 0, relativeAge(row.modified, now));
		const indent = " ".repeat(visibleWidth(lead));
		const titleWidth = Math.max(4, inner - visibleWidth(lead) - 1);
		return [
			paint(`${lead}${theme.fg(titleColor, truncateToWidth(title, titleWidth, "…"))}`),
			paint(`${indent}${theme.fg("dim", truncateToWidth(meta, Math.max(4, inner - visibleWidth(indent)), "…"))}`),
		];
	}

	/** Empty states get a sentence, not a shrug. */
	private emptyState(snapshot: SidebarSnapshot): string {
		if (snapshot.loading) return ` ${spinnerFrame()} loading threads…`;
		if (this.searchActive()) {
			return this.query.length > 0 ? ` no match: ${this.query}` : " no threads yet · n starts one";
		}
		return " nothing this week · / searches all";
	}
}
