import assert from "node:assert";
import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { type EulerHost, EulerMode, type EulerPrompt } from "../src/modes/euler/euler-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const TRANSCRIPT = [
	" > refactor the auth module",
	"",
	" Here is the plan.",
	" - extract session store",
	" - add tests",
	"",
	" > now compare with option B",
	"",
	" Option B keeps the store inline.",
];

interface Recorded {
	quotes: Array<{ text: string; details: Record<string, unknown> }>;
	copies: string[];
	forks: string[];
	rewinds: EulerPrompt[];
	opened: string[];
}

function setup() {
	const terminal = new VirtualTerminal(60, 20);
	const tui = new TuiAltScreen(terminal);
	const scroll = new ScrollView({ render: () => TRANSCRIPT, invalidate() {} }, { follow: "end", primary: true });
	tui.setLayoutRoot(scroll);
	tui.start();
	const recorded: Recorded = { quotes: [], copies: [], forks: [], rewinds: [], opened: [] };
	const state = { streaming: false };
	const prompts: EulerPrompt[] = [
		{ entryId: "e1", text: "refactor the auth module" },
		{ entryId: "e2", text: "now compare with option B" },
	];
	const host: EulerHost = {
		ui: tui,
		renderer: tui,
		transcript: scroll,
		forkAtLeaf: async () => {
			recorded.forks.push("leaf");
		},
		forkBeforePrompt: async (prompt) => {
			recorded.rewinds.push(prompt);
		},
		prompts: () => prompts,
		addQuote: (text, details) => {
			recorded.quotes.push({ text, details });
		},
		copy: async (text) => {
			recorded.copies.push(text);
			return true;
		},
		openSessions: () => {
			recorded.opened.push("sessions");
		},
		openTree: () => {
			recorded.opened.push("tree");
		},
		focusEditor: () => {},
		blurEditor: () => {},
		showStatus: () => {},
		showError: () => {},
		isStreaming: () => state.streaming,
		sessionName: () => "test-session",
		parentName: () => undefined,
	};
	const mode = new EulerMode(host);
	mode.attach();
	created.push({ tui, mode });
	return { terminal, tui, scroll, recorded, mode, state };
}

const created: Array<{ tui: TuiAltScreen; mode: EulerMode }> = [];

// The cheatsheet renders through the real theme.
initTheme("dark");

afterEach(() => {
	while (created.length > 0) {
		const entry = created.pop();
		entry?.mode.dispose();
		entry?.tui.stop();
	}
});

async function settle(terminal: VirtualTerminal): Promise<void> {
	await terminal.waitForRender();
}

describe("EulerMode", () => {
	it("starts in insert mode and switches to normal on Escape", async () => {
		const { terminal, mode } = setup();
		await settle(terminal);
		assert.equal(mode.statusData().mode, "insert");
		terminal.sendInput("\x1b");
		await settle(terminal);
		assert.equal(mode.statusData().mode, "normal");
	});

	it("moves the cursor with j/k and jumps with gg/G", async () => {
		const { terminal, tui, scroll } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		await settle(terminal);
		terminal.sendInput("G");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.row, TRANSCRIPT.length - 1);
		terminal.sendInput("gg");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.row, 0);
		terminal.sendInput("2j");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.row, 2);
		terminal.sendInput("1G");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.row, TRANSCRIPT.length - 1);
		assert.ok(scroll.scrollTop >= 0);
	});

	it("yanks a linewise visual selection through the host clipboard", async () => {
		const { terminal, recorded } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput("G");
		terminal.sendInput("V");
		terminal.sendInput("k");
		terminal.sendInput("y");
		await settle(terminal);
		assert.deepEqual(recorded.copies, ["\n Option B keeps the store inline."]);
	});

	it("quotes a visual selection as a markdown block with provenance", async () => {
		const { terminal, recorded } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput("G");
		terminal.sendInput("V");
		terminal.sendInput('"');
		await settle(terminal);
		assert.equal(recorded.quotes.length, 1);
		assert.equal(recorded.quotes[0].text, "> Option B keeps the store inline.");
		assert.equal(recorded.quotes[0].details.kind, "euler.quote");
	});

	it("forks the thread at the leaf and rewinds at the prompt under the cursor", async () => {
		const { terminal, recorded } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput("f");
		await settle(terminal);
		assert.deepEqual(recorded.forks, ["leaf"]);

		terminal.sendInput("G");
		terminal.sendInput("F");
		await settle(terminal);
		assert.deepEqual(
			recorded.rewinds.map((prompt) => prompt.entryId),
			["e2"],
		);
	});

	it("does not swallow Escape while a turn is streaming", async () => {
		const { terminal, mode, tui, state } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		await settle(terminal);
		assert.equal(mode.statusData().mode, "normal");
		state.streaming = true;

		// Simulate the escape reaching Pi's abort handler instead of being consumed.
		const consumed: boolean[] = [];
		tui.addInputListener((data) => {
			if (data === "\x1b") consumed.push(true);
			return undefined;
		});
		terminal.sendInput("\x1b");
		await settle(terminal);
		assert.deepEqual(consumed, [true]);
	});

	it("jumps by WORD with W/B/E and inside the viewport with H/M/L", async () => {
		const { terminal, tui } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput("G");
		terminal.sendInput("gg");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.row, 0);

		// WORD motions treat ">" and "refactor" as whole tokens.
		const first = TRANSCRIPT[0];
		const refactorEnd = first.indexOf("refactor") + "refactor".length - 1;
		const theStart = first.indexOf("the");
		terminal.sendInput("0");
		terminal.sendInput("2E");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.row, 0);
		assert.equal(tui.getKeyboardState()?.cursor.col, refactorEnd);

		terminal.sendInput("W");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.col, theStart);
		terminal.sendInput("B");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.col, first.indexOf("refactor"));

		terminal.sendInput("G");
		await settle(terminal);
		terminal.sendInput("H");
		await settle(terminal);
		const top = tui.getKeyboardState()?.cursor.row;
		terminal.sendInput("L");
		await settle(terminal);
		const bottom = tui.getKeyboardState()?.cursor.row;
		terminal.sendInput("M");
		await settle(terminal);
		const middle = tui.getKeyboardState()?.cursor.row;
		assert.ok(top !== undefined && bottom !== undefined && middle !== undefined);
		assert.ok(top >= 0 && bottom >= top && middle >= top && middle <= bottom);
	});

	it("pages with Ctrl-f/Ctrl-b and accepts N G", async () => {
		const { terminal, tui } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput("\x06"); // ctrl+f
		await settle(terminal);
		const paged = tui.getKeyboardState()?.cursor.row ?? 0;
		assert.ok(paged > 0);
		terminal.sendInput("\x02"); // ctrl+b
		await settle(terminal);
		assert.ok((tui.getKeyboardState()?.cursor.row ?? 0) <= paged);
		terminal.sendInput("2G");
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.row, 1);
	});

	it("yanks the current line with Y", async () => {
		const { terminal, recorded } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput("G");
		terminal.sendInput("Y");
		await settle(terminal);
		assert.equal(recorded.copies.length, 1);
		assert.ok(recorded.copies[0].includes("Option B keeps the store inline."));
	});

	it("shows which-key continuations for a pending prefix", async () => {
		const { terminal, mode } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput(" ");
		await settle(terminal);
		const status = mode.statusData();
		assert.equal(status.pending, "<space>");
		assert.ok(status.hint?.includes("s previous conversations"));
		assert.ok(status.hint?.includes("f fork thread"));
	});

	it("opens session pickers from the leader", async () => {
		const { terminal, recorded } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput(" s");
		await settle(terminal);
		assert.deepEqual(recorded.opened, ["sessions"]);
	});

	it("does not leave a binding that is in the keymap but not dispatched", async () => {
		const { terminal, mode } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		for (const key of ["j", "k", "h", "l", "w", "b", "e", "W", "B", "E", "0", "^", "$", "{", "}", "y"]) {
			terminal.sendInput(key);
			await settle(terminal);
			assert.ok(!mode.statusData().message?.includes("unmapped"), `unmapped: ${key}`);
		}
	});

	it("keeps transcript stripping lazy so long sessions stay responsive", async () => {
		const { MotionDoc } = await import("../src/modes/euler/motions.ts");
		const line = "\u001b[38;2;126;136;142m \u2502   const value = await buildContextEntries();\u001b[0m";
		const lines = Array.from({ length: 20000 }, () => line);
		const start = performance.now();
		const doc = new MotionDoc(lines);
		const constructionMs = performance.now() - start;
		assert.ok(constructionMs < 2, `construction took ${constructionMs.toFixed(2)}ms`);
		const read = performance.now();
		assert.ok(doc.text(100).includes("buildContextEntries"));
		assert.ok(doc.lastCol(100) > 0);
		assert.ok(performance.now() - read < 5);
	});

	it("decodes Kitty CSI-u printable keys (space, ?)", async () => {
		const { terminal, tui, recorded, mode } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b[32u"); // space
		await settle(terminal);
		assert.equal(mode.statusData().pending, "<space>");
		assert.ok(mode.statusData().hint?.includes("s previous conversations"));

		terminal.sendInput("\x1b[115u"); // s
		await settle(terminal);
		assert.deepEqual(recorded.opened, ["sessions"]);

		terminal.sendInput("\x1b[47:63;2u"); // shift+/ = ?
		await settle(terminal);
		assert.equal(tui.hasOverlayEntries, true);
		terminal.sendInput("x");
		await settle(terminal);
		assert.equal(tui.hasOverlayEntries, false);
	});

	it("decodes shifted letters from CSI-u as their uppercase binding", async () => {
		const { terminal, tui } = setup();
		await settle(terminal);
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b[103;2u"); // shift+g = G
		await settle(terminal);
		assert.equal(tui.getKeyboardState()?.cursor.row, TRANSCRIPT.length - 1);
		terminal.sendInput("\x1b[103u"); // plain g starts the gg prefix
		await settle(terminal);
		assert.equal(tui.hasOverlayEntries, false);
	});
});
