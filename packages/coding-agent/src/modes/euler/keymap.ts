/**
 * The single source of truth for euler's keys.
 *
 * Dispatch, the `?` cheatsheet and the which-key hint line all read this table, so a binding
 * cannot exist in the UI without existing in the engine (or the other way around).
 */

import { decodePrintableKey, matchesKey } from "@earendil-works/pi-tui";

/** Modal modes a binding can be active in. Insert mode always passes through to the editor. */
export type EulerModeName = "normal" | "visual" | "insert" | "search" | "command";

/** Modes the keymap dispatches; insert passes through, command is an overlay. */
export type BindingMode = "normal" | "visual";

export type GroupName = "move" | "select" | "threads" | "search" | "session" | "mode";

export type EulerAction =
	| "down"
	| "up"
	| "left"
	| "right"
	| "wordForward"
	| "wordBackward"
	| "wordEnd"
	| "bigWordForward"
	| "bigWordBackward"
	| "bigWordEnd"
	| "lineStart"
	| "firstNonBlank"
	| "lineEnd"
	| "docStart"
	| "docEnd"
	| "paragraphUp"
	| "paragraphDown"
	| "viewportTop"
	| "viewportMiddle"
	| "viewportBottom"
	| "halfPageDown"
	| "halfPageUp"
	| "pageDown"
	| "pageUp"
	| "visualChar"
	| "visualLine"
	| "yank"
	| "yankLine"
	| "quote"
	| "forkLeaf"
	| "forkPrompt"
	| "search"
	| "nextMatch"
	| "previousMatch"
	| "help"
	| "insert"
	| "sessions"
	| "tree"
	| "sidebar"
	| "newSession"
	| "command"
	| "focusSidebar"
	| "focusTranscript";

export interface KeymapEntry {
	/** Space-separated key tokens, e.g. `"g g"`, `"space s"`, `"ctrl+d"`. */
	readonly keys: string;
	readonly modes: readonly BindingMode[];
	readonly group: GroupName;
	readonly desc: string;
	readonly action: EulerAction;
}

const BOTH: readonly BindingMode[] = ["normal", "visual"];
const NORMAL: readonly BindingMode[] = ["normal"];

const GROUP_TITLES: Record<GroupName, string> = {
	move: "move",
	select: "select",
	threads: "threads",
	search: "search",
	session: "session",
	mode: "mode",
};

export const KEYMAP: readonly KeymapEntry[] = [
	// movement
	{ keys: "j", modes: BOTH, group: "move", desc: "down", action: "down" },
	{ keys: "k", modes: BOTH, group: "move", desc: "up", action: "up" },
	{ keys: "h", modes: BOTH, group: "move", desc: "left", action: "left" },
	{ keys: "l", modes: BOTH, group: "move", desc: "right", action: "right" },
	{ keys: "w", modes: BOTH, group: "move", desc: "next word", action: "wordForward" },
	{ keys: "b", modes: BOTH, group: "move", desc: "previous word", action: "wordBackward" },
	{ keys: "e", modes: BOTH, group: "move", desc: "word end", action: "wordEnd" },
	{ keys: "W", modes: BOTH, group: "move", desc: "next WORD (whitespace)", action: "bigWordForward" },
	{ keys: "B", modes: BOTH, group: "move", desc: "previous WORD", action: "bigWordBackward" },
	{ keys: "E", modes: BOTH, group: "move", desc: "WORD end", action: "bigWordEnd" },
	{ keys: "0", modes: BOTH, group: "move", desc: "line start", action: "lineStart" },
	{ keys: "^", modes: BOTH, group: "move", desc: "first non-blank", action: "firstNonBlank" },
	{ keys: "$", modes: BOTH, group: "move", desc: "line end", action: "lineEnd" },
	{ keys: "g g", modes: BOTH, group: "move", desc: "first line", action: "docStart" },
	{ keys: "G", modes: BOTH, group: "move", desc: "last line (or N G)", action: "docEnd" },
	{ keys: "{", modes: BOTH, group: "move", desc: "paragraph up", action: "paragraphUp" },
	{ keys: "}", modes: BOTH, group: "move", desc: "paragraph down", action: "paragraphDown" },
	{ keys: "H", modes: BOTH, group: "move", desc: "top of screen", action: "viewportTop" },
	{ keys: "M", modes: BOTH, group: "move", desc: "middle of screen", action: "viewportMiddle" },
	{ keys: "L", modes: BOTH, group: "move", desc: "bottom of screen", action: "viewportBottom" },
	{ keys: "ctrl+d", modes: BOTH, group: "move", desc: "half page down", action: "halfPageDown" },
	{ keys: "ctrl+u", modes: BOTH, group: "move", desc: "half page up", action: "halfPageUp" },
	{ keys: "ctrl+f", modes: BOTH, group: "move", desc: "page down", action: "pageDown" },
	{ keys: "ctrl+b", modes: BOTH, group: "move", desc: "page up", action: "pageUp" },

	// selection and copy
	{ keys: "v", modes: BOTH, group: "select", desc: "character-wise visual", action: "visualChar" },
	{ keys: "V", modes: BOTH, group: "select", desc: "line-wise visual", action: "visualLine" },
	{ keys: "y", modes: ["visual"], group: "select", desc: "yank selection", action: "yank" },
	{ keys: "y y", modes: NORMAL, group: "select", desc: "yank line", action: "yankLine" },
	{ keys: "Y", modes: NORMAL, group: "select", desc: "yank line", action: "yankLine" },
	{ keys: '"', modes: BOTH, group: "select", desc: "quote selection", action: "quote" },
	{ keys: "q", modes: BOTH, group: "select", desc: "quote selection", action: "quote" },

	// threads
	{ keys: "f", modes: BOTH, group: "threads", desc: "fork thread here", action: "forkLeaf" },
	{ keys: "F", modes: BOTH, group: "threads", desc: "rewind-fork at prompt", action: "forkPrompt" },

	// search
	{ keys: "/", modes: BOTH, group: "search", desc: "search transcript", action: "search" },
	{ keys: "n", modes: BOTH, group: "search", desc: "next match", action: "nextMatch" },
	{ keys: "N", modes: BOTH, group: "search", desc: "previous match", action: "previousMatch" },

	// leader
	{ keys: "space e", modes: NORMAL, group: "session", desc: "toggle thread sidebar", action: "sidebar" },
	{ keys: "space n", modes: NORMAL, group: "session", desc: "new thread", action: "newSession" },
	{ keys: "ctrl+h", modes: NORMAL, group: "session", desc: "focus thread sidebar", action: "focusSidebar" },
	{ keys: "ctrl+l", modes: NORMAL, group: "session", desc: "focus transcript", action: "focusTranscript" },
	{ keys: "space s", modes: NORMAL, group: "session", desc: "previous conversations", action: "sessions" },
	{ keys: "space t", modes: NORMAL, group: "session", desc: "session tree", action: "tree" },
	{ keys: "space f", modes: NORMAL, group: "session", desc: "fork thread", action: "forkLeaf" },
	{ keys: "space h", modes: NORMAL, group: "session", desc: "this cheatsheet", action: "help" },

	// mode switches
	{ keys: "i", modes: NORMAL, group: "mode", desc: "insert (editor)", action: "insert" },
	{ keys: "a", modes: NORMAL, group: "mode", desc: "insert (editor)", action: "insert" },
	{ keys: ":", modes: NORMAL, group: "mode", desc: "command line (:q to quit)", action: "command" },
	{ keys: "?", modes: BOTH, group: "mode", desc: "cheatsheet", action: "help" },
] as const;

/** Keys the engine canonicalizes from raw terminal bytes; everything else is a printable char. */
const SPECIAL_KEYS = [
	"ctrl+d",
	"ctrl+u",
	"ctrl+f",
	"ctrl+b",
	"ctrl+e",
	"ctrl+y",
	"ctrl+h",
	"ctrl+l",
	"escape",
] as const;

export function tokens(keys: string): string[] {
	return keys.split(" ").filter(Boolean);
}

export function displayKeys(keys: string): string {
	return tokens(keys)
		.map((token) => (token === "space" ? "<space>" : token))
		.join("");
}

/**
 * Canonical token for a raw input chunk, or undefined for keys the engine ignores.
 *
 * Terminals in the Kitty keyboard protocol send printable keys as CSI-u sequences (space is
 * `\x1b[32u`, `?` is `\x1b[47:63;2u`), so raw single-byte checks are not enough. The same
 * helper the editor uses decodes those, and the plain-byte path keeps terminals without the
 * protocol working.
 */
export function canonicalKey(data: string): string | undefined {
	for (const special of SPECIAL_KEYS) {
		if (matchesKey(data, special)) return special;
	}
	const printable = decodePrintableKey(data) ?? (data.length === 1 ? data : undefined);
	if (printable === undefined) return undefined;
	if (printable === " ") return "space";
	if (printable.length === 1 && printable >= " " && printable !== "\x7f") return printable;
	return undefined;
}

interface KeymapMatch {
	exact?: KeymapEntry;
	/** Bindings that continue with this prefix, e.g. pressing `g` yields `gg`. */
	prefixes: KeymapEntry[];
}

export function matchKeymap(pressed: readonly string[], mode: BindingMode): KeymapMatch {
	let exact: KeymapEntry | undefined;
	const prefixes: KeymapEntry[] = [];
	for (const entry of KEYMAP) {
		if (!entry.modes.includes(mode)) continue;
		const entryTokens = tokens(entry.keys);
		if (entryTokens.length < pressed.length) continue;
		let matches = true;
		for (let index = 0; index < pressed.length; index++) {
			if (entryTokens[index] !== pressed[index]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		if (entryTokens.length === pressed.length) exact = entry;
		else prefixes.push(entry);
	}
	return { exact, prefixes };
}

/** Which-key hint for a pending prefix: the continuations left at this point. */
export function describeContinuations(prefixes: readonly KeymapEntry[]): string {
	return prefixes.map((entry) => `${tokens(entry.keys).at(-1)} ${entry.desc}`).join(" · ");
}

/** Cheatsheet rows grouped by section, ready to render in an overlay. */
export interface CheatsheetEntry {
	keys: string;
	desc: string;
}

export interface CheatsheetSection {
	title: string;
	entries: CheatsheetEntry[];
}

/** Cheatsheet grouped by section, ready to lay out in one or two columns. */
export function cheatsheetSections(): CheatsheetSection[] {
	const sections: CheatsheetSection[] = [];
	for (const group of Object.keys(GROUP_TITLES) as GroupName[]) {
		const entries = KEYMAP.filter((entry) => entry.group === group).map((entry) => ({
			keys: displayKeys(entry.keys),
			desc: entry.desc,
		}));
		if (entries.length === 0) continue;
		sections.push({ title: GROUP_TITLES[group], entries });
	}
	return sections;
}
