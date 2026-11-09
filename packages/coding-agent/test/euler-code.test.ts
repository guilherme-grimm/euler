import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterAll, describe, it } from "vitest";
import { detectPathAt, formatDiff, loadFileView, resolveCodePath } from "../src/modes/euler/euler-code.ts";
import { EulerViewer } from "../src/modes/euler/euler-viewer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

const directory = mkdtempSync(join(tmpdir(), "euler-code-"));
writeFileSync(join(directory, "sample.ts"), "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n");

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("euler code", () => {
	it("resolves path:line and detects paths in rendered text", () => {
		const target = resolveCodePath(directory, "sample.ts:2");
		assert.ok(target);
		assert.equal(target.line, 2);
		assert.equal(resolveCodePath(directory, "missing.ts"), undefined);
		const detected = detectPathAt("see sample.ts:3 for the call", directory);
		assert.equal(detected?.line, 3);
	});

	it("loads a numbered, highlighted file view", () => {
		const target = resolveCodePath(directory, "sample.ts:2");
		assert.ok(target);
		const view = loadFileView(directory, target);
		assert.ok(view.title.includes("sample.ts:2"));
		assert.equal(view.focusLine, 2);
		const plain = view.lines.map((line) => stripTerminalSequences(line));
		assert.ok(plain[0]?.includes("1 │"));
		assert.ok(plain[2]?.includes("console.log"));
	});

	it("formats unified diff lines", () => {
		const lines = formatDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context\n").map(
			(line) => stripTerminalSequences(line),
		);
		assert.ok(
			lines.some((line) => line === "x"),
			"file header",
		);
		assert.ok(lines.includes("@@ -1 +1 @@"));
		assert.ok(lines.includes("-old"));
		assert.ok(lines.includes("+new"));
	});

	it("scrolls the viewer", () => {
		const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
		const viewer = new EulerViewer({ title: "x", lines, height: 10 });
		assert.equal(viewer.render(80).length, 10);
		viewer.handleKey("j");
		viewer.handleKey("G");
		assert.ok(stripTerminalSequences(viewer.render(80).join("\n")).includes("line 50"));
		viewer.handleKey("g");
		viewer.handleKey("g");
		assert.ok(stripTerminalSequences(viewer.render(80).join("\n")).includes("line 1"));
		assert.equal(viewer.handleKey("q"), "close");
	});
});
