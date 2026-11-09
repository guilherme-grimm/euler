import assert from "node:assert";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { type EulerStatusData, EulerStatusLine } from "../src/modes/euler/euler-status.ts";
import { compactTokens, shortModelName } from "../src/modes/euler/euler-voice.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

function statusLine(overrides: Partial<EulerStatusData> = {}): EulerStatusLine {
	return new EulerStatusLine(() => ({
		mode: "normal",
		line: 12,
		total: 512,
		sessionName: "render the ADE persona",
		streaming: false,
		...overrides,
	}));
}

function plain(line: string | undefined): string {
	return stripTerminalSequences(line ?? "");
}

describe("euler statusline", () => {
	it("reads mode, thread and position without decoration", () => {
		const line = plain(statusLine().render(80)[0]);
		assert.ok(line.includes("NORMAL"), `mode: ${line}`);
		assert.ok(line.includes("render the ADE persona"), `thread: ${line}`);
		assert.ok(line.includes("12/512"), `position: ${line}`);
		assert.equal(visibleWidth(line), 80);
	});

	it("says what the turn is doing and for how long", () => {
		const line = plain(statusLine({ streaming: true, workingMs: 72_000 }).render(90)[0]);
		assert.ok(line.includes("working 1m 12s"), `activity: ${line}`);
		assert.ok(/[\u2800-\u28ff]/.test(line), `spinner: ${line}`);
	});

	it("stays one line when the width runs out", () => {
		const lines = statusLine({ message: "quoted 3 lines" }).render(20);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(plain(lines[0])) <= 20);
	});

	it("keeps an idle line free of animation", () => {
		const line = plain(statusLine().render(80)[0]);
		assert.ok(!/[\u2800-\u28ff]/.test(line), `idle spinner: ${line}`);
		assert.ok(!line.includes("working"));
	});

	it("shows the model and thinking level as a chip", () => {
		const line = plain(statusLine({ model: { name: "Opus 4.5", thinking: "high" } }).render(90)[0]);
		assert.ok(line.includes("Opus 4.5 high"), `chip: ${line}`);
	});

	it("shows the quota window next to the activity", () => {
		const line = plain(statusLine({ usage: { label: "5h", percent: 61 } }).render(90)[0]);
		assert.ok(line.includes("5h 61%"), `usage: ${line}`);
	});

	it("drops the chip before the quota window when the line is tight", () => {
		const line = plain(
			statusLine({
				model: { name: "Opus 4.5", thinking: "high" },
				usage: { label: "5h", percent: 61 },
			}).render(52)[0],
		);
		assert.ok(!line.includes("Opus 4.5"), `chip survived: ${line}`);
		assert.ok(line.includes("5h 61%"), `usage dropped: ${line}`);
	});

	it("drops the chip before the thread when the line is tight", () => {
		const line = plain(
			statusLine({ model: { name: "Opus 4.5", thinking: "high" }, message: "quoted 3 lines" }).render(44)[0],
		);
		assert.ok(!line.includes("Opus 4.5"), `chip survived: ${line}`);
		assert.ok(visibleWidth(line) <= 44);
	});

	it("shortens vendor-prefixed model names", () => {
		assert.equal(shortModelName("Claude Opus 4.5", "claude-opus-4-5"), "Opus 4.5");
		assert.equal(shortModelName("Anthropic: Claude Sonnet 5", "x"), "Sonnet 5");
		assert.equal(shortModelName("", "gpt-5.2-codex"), "gpt-5.2-codex");
	});

	it("formats panel token counts", () => {
		assert.equal(compactTokens(999), "999");
		assert.equal(compactTokens(20_000), "20.0k");
		assert.equal(compactTokens(447_138), "447.1k");
		assert.equal(compactTokens(1_000_000), "1.0M");
	});
});
