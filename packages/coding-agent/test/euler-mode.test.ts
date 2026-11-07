import assert from "node:assert";
import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { type EulerHost, EulerMode, type EulerPrompt } from "../src/modes/euler/euler-mode.ts";

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
}

function setup() {
	const terminal = new VirtualTerminal(60, 20);
	const tui = new TuiAltScreen(terminal);
	const scroll = new ScrollView({ render: () => TRANSCRIPT, invalidate() {} }, { follow: "end", primary: true });
	tui.setLayoutRoot(scroll);
	tui.start();
	const recorded: Recorded = { quotes: [], copies: [], forks: [], rewinds: [] };
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
		openSessions: () => {},
		openTree: () => {},
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
});
