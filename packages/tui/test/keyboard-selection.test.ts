import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const CONTENT = ["alpha beta gamma", "second line here", "third line", "fourth"];

function createScreen(columns = 24, rows = 6) {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TuiAltScreen(terminal);
	const scroll = new ScrollView({ render: () => CONTENT, invalidate() {} }, { follow: "end", primary: true });
	tui.setLayoutRoot(scroll);
	return { terminal, tui, scroll };
}

describe("TuiAltScreen keyboard state", () => {
	it("exposes viewport content and geometry", async () => {
		const { terminal, tui, scroll } = createScreen();
		tui.start();
		await terminal.waitForRender();

		const snapshot = tui.getViewportSnapshot(scroll);
		assert.ok(snapshot);
		assert.equal(snapshot.lines.length, CONTENT.length);
		assert.equal(snapshot.height, 6);
		assert.equal(snapshot.top, 0);
		assert.ok(snapshot.width > 0);
		tui.stop();
	});

	it("reports the character under the keyboard cursor", async () => {
		const { terminal, tui, scroll } = createScreen();
		tui.start();
		await terminal.waitForRender();

		tui.setKeyboardState({ scrollView: scroll, cursor: { row: 1, col: 2 } });
		await terminal.waitForRender();
		assert.equal(tui.getKeyboardSelectionText(), "c");

		tui.setKeyboardState({ scrollView: scroll, cursor: { row: 0, col: 0 } });
		await terminal.waitForRender();
		assert.equal(tui.getKeyboardSelectionText(), "a");
		tui.stop();
	});

	it("extracts a characterwise selection across rows", async () => {
		const { terminal, tui, scroll } = createScreen();
		tui.start();
		await terminal.waitForRender();

		tui.setKeyboardState({ scrollView: scroll, cursor: { row: 1, col: 2 }, anchor: { row: 0, col: 0 } });
		await terminal.waitForRender();
		assert.equal(tui.getKeyboardSelectionText(), "alpha beta gamma\nsec");

		tui.setKeyboardState({ scrollView: scroll, cursor: { row: 0, col: 4 }, anchor: { row: 1, col: 2 } });
		await terminal.waitForRender();
		assert.equal(tui.getKeyboardSelectionText(), "a beta gamma\nsec");
		tui.stop();
	});

	it("extracts whole lines in linewise mode", async () => {
		const { terminal, tui, scroll } = createScreen();
		tui.start();
		await terminal.waitForRender();

		tui.setKeyboardState({
			scrollView: scroll,
			cursor: { row: 2, col: 3 },
			anchor: { row: 1, col: 5 },
			linewise: true,
		});
		await terminal.waitForRender();
		assert.equal(tui.getKeyboardSelectionText(), "second line here\nthird line");
		tui.stop();
	});

	it("renders the cursor cell without breaking the frame", async () => {
		const { terminal, tui, scroll } = createScreen(24, 6);
		tui.start();
		await terminal.waitForRender();

		tui.setKeyboardState({ scrollView: scroll, cursor: { row: 1, col: 2 } });
		const viewport = await terminal.flushAndGetViewport();
		assert.equal(viewport[0].trimEnd(), CONTENT[0]);
		assert.equal(viewport[1].trimEnd(), CONTENT[1]);
		tui.stop();
	});
});
