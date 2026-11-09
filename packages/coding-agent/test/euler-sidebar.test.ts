import assert from "node:assert";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import {
	EulerSidebar,
	orderThreads,
	relativeAge,
	type SidebarDensity,
	type SidebarSnapshot,
	type SidebarThread,
} from "../src/modes/euler/euler-sidebar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

/** The rail sizes itself from the terminal width (readWidth 120 in the fixture). */
const RAIL_WIDTH = Math.min(38, Math.max(26, Math.floor(120 * 0.28)));

// Relative dates: a fixed fixture would drift out of the rail's recent window as the calendar moves.
const OLD = new Date(Date.now() - 2 * 86_400_000);
const MID = new Date(Date.now() - 3 * 3_600_000);
const NEW = new Date(Date.now() - 5 * 60_000);

function setup(density: SidebarDensity = "comfortable") {
	const events: string[] = [];
	const state = { density };
	const snapshot: SidebarSnapshot = {
		threads: [
			{ path: "/s/parent.jsonl", title: "refactor auth", modified: MID, messageCount: 12 },
			{
				path: "/s/fork.jsonl",
				title: "compare option B",
				modified: NEW,
				messageCount: 4,
				parentPath: "/s/parent.jsonl",
			},
			{ path: "/s/old.jsonl", title: "old thread", modified: OLD, messageCount: 2, unread: true },
			{
				path: "/s/orphan.jsonl",
				title: "orphan fork",
				modified: OLD,
				messageCount: 0,
				parentPath: "/s/missing.jsonl",
			},
		],
		currentPath: "/s/parent.jsonl",
		loading: false,
	};
	const sidebar = new EulerSidebar({
		read: () => snapshot,
		readHeight: () => 20,
		readWidth: () => 120,
		density: () => state.density,
		onDensity: (next) => {
			state.density = next;
			events.push(`density:${next}`);
		},
		onOpen: (path) => events.push(`open:${path}`),
		onOpenExternal: (thread) => events.push(`openExternal:${thread.threadId}`),
		onShowExternal: (thread) => events.push(`showExternal:${thread.threadId}`),
		onSendExternal: (thread) => events.push(`sendExternal:${thread.threadId}`),
		onStartExternal: () => events.push("startExternal"),
		onNew: () => events.push("new"),
		onHide: () => events.push("hide"),
		onBlur: () => events.push("blur"),
		onRefresh: () => events.push("refresh"),
		requestRender: () => {},
	});
	sidebar.focused = true;
	return { sidebar, snapshot, events, state };
}

describe("euler sidebar", () => {
	it("nests forks under their parent and marks the current session", () => {
		const { snapshot } = setup();
		const rows = orderThreads(snapshot.threads, snapshot.currentPath);
		assert.deepEqual(
			rows.map((row) => [row.title, row.depth, row.current]),
			[
				["refactor auth", 0, true],
				["compare option B", 1, false],
				["old thread", 0, false],
				["orphan fork", 0, false],
			],
		);
	});

	it("renders a brand header, sections, markers and metadata", () => {
		const { sidebar } = setup();
		const plain = sidebar.render(30).map((line) => stripTerminalSequences(line));
		assert.ok(plain[0]?.includes("euler"), "brand header");
		assert.ok(
			plain.some((line) => line.includes("IDLE")),
			"section header",
		);
		assert.ok(plain.some((line) => line.includes("●") && line.includes("refactor auth")));
		assert.ok(
			plain.some((line) => line.includes("◆ old thread")),
			"unread marker",
		);
		assert.ok(
			plain.some((line) => line.includes("· orphan fork")),
			"empty marker",
		);
		assert.ok(plain.some((line) => line.includes("└ ") && line.includes("compare option B")));
		assert.ok(
			plain.some((line) => line.includes("12 msgs")),
			"metadata line",
		);
		assert.ok(
			plain.some((line) => line.includes("↳ 4 msgs")),
			"fork metadata",
		);
		assert.ok(
			plain.some((line) => line.includes("j/k")),
			"footer hint",
		);
		for (const line of plain) assert.ok(visibleWidth(line) <= RAIL_WIDTH, `line too wide: ${line}`);
	});

	it("toggles density with v and drops the metadata line", () => {
		const { sidebar, events, state } = setup();
		sidebar.selectCurrent();
		assert.ok(sidebar.render(30).some((line) => stripTerminalSequences(line).includes("12 msgs")));
		sidebar.handleInput("v");
		assert.deepEqual(events, ["density:compact"]);
		assert.equal(state.density, "compact");
		const compact = sidebar.render(30).map((line) => stripTerminalSequences(line));
		assert.ok(compact.some((line) => line.includes("refactor auth")));
		assert.ok(!compact.some((line) => line.includes("12 msgs")), "compact rows have no metadata line");
		assert.equal(compact.length, 20, "rail fills the viewport height");
	});

	it("renders T3 external threads and opens one", () => {
		const { sidebar, snapshot, events } = setup();
		snapshot.external = [
			{
				threadId: "mcp:1",
				title: "add retry",
				status: "running",
				branch: "feat/retry",
				provider: "pi",
				model: "opencode-go/x",
				updatedAt: new Date().toISOString(),
			},
			{
				threadId: "mcp:2",
				title: "dark mode",
				status: "completed",
				branch: "feat/dark",
				updatedAt: new Date().toISOString(),
			},
		];
		const plain = sidebar.render(30).map((line) => stripTerminalSequences(line));
		assert.ok(
			plain.some((line) => line.includes("EXTERNAL")),
			"external section",
		);
		assert.ok(
			plain.some((line) => line.includes("add retry")),
			"title",
		);
		assert.ok(
			plain.some((line) => line.includes("feat/retry")),
			"branch metadata",
		);
		sidebar.selectCurrent();
		sidebar.handleInput("G");
		sidebar.handleInput("d");
		sidebar.handleInput("s");
		sidebar.handleInput("N");
		sidebar.handleInput("\r");
		assert.deepEqual(events, ["showExternal:mcp:2", "sendExternal:mcp:2", "startExternal", "openExternal:mcp:2"]);
	});

	it("navigates with j/k/gg/G and opens with enter", () => {
		const { sidebar, events } = setup();
		sidebar.selectCurrent();
		sidebar.handleInput("j");
		sidebar.handleInput("\r");
		assert.deepEqual(events, ["open:/s/fork.jsonl"]);

		sidebar.handleInput("G");
		assert.equal(sidebar.render(30).join("\n").includes("orphan fork"), true);
		sidebar.handleInput("g");
		sidebar.handleInput("g");
		sidebar.handleInput("k");
		assert.equal(sidebar.rows()[0]?.title, "refactor auth");
	});

	it("enter on the current thread hides the rail, e hides too", () => {
		const { sidebar, events } = setup();
		sidebar.selectCurrent();
		sidebar.handleInput("\r");
		sidebar.handleInput("e");
		assert.deepEqual(events, ["hide", "hide"]);
	});

	it("ctrl+l blurs the rail without hiding it", () => {
		const { sidebar, events } = setup();
		sidebar.handleInput("\x0c");
		assert.deepEqual(events, ["blur"]);
	});

	it("refreshes on r and creates on n", () => {
		const { sidebar, events } = setup();
		sidebar.handleInput("r");
		sidebar.handleInput("n");
		assert.deepEqual(events, ["refresh", "new"]);
	});

	it("formats relative ages inside four cells", () => {
		const now = new Date("2026-11-07T10:00:30Z").getTime();
		assert.equal(relativeAge(new Date("2026-11-07T10:00:00Z"), now), "30s");
		assert.equal(relativeAge(new Date("2026-11-07T09:30:00Z"), now), "30m");
		assert.equal(relativeAge(new Date("2026-11-07T05:00:00Z"), now), "5h");
		assert.equal(relativeAge(new Date("2026-11-04T10:00:00Z"), now), "3d");
		assert.equal(relativeAge(new Date("2026-01-01T10:00:00Z"), now), "44w");
		assert.equal(relativeAge(new Date("2015-01-01T10:00:00Z"), now), ">9y");
		for (const days of [1, 99, 100, 700, 4000]) {
			const age = relativeAge(new Date(now - days * 86_400_000), now);
			assert.ok(visibleWidth(age) <= 4, `age too wide: ${age}`);
		}
	});

	it("marks the live thread with a spinner and never overflows the rail", () => {
		const { sidebar, snapshot } = setup();
		snapshot.live = true;
		snapshot.currentPath = "/s/parent.jsonl";
		const plain = sidebar.render(28).map((line) => stripTerminalSequences(line));
		const live = plain.find((line) => line.includes("refactor auth"));
		assert.ok(live && /[\u2800-\u28ff]/.test(live), "braille spinner on the live thread");
		assert.ok(
			plain.some((line) => line.includes("WORKING")),
			"working section",
		);
		for (const line of plain) assert.ok(visibleWidth(line) <= RAIL_WIDTH, `overflow: ${line}`);
		assert.equal(plain.length, 20, "rail fills the viewport height");
	});

	it("shows only the last week by default and searches all history", () => {
		const { sidebar, snapshot } = setup();
		// Everything in the fixture is inside the window.
		assert.equal(sidebar.rows().length, 4);

		const old = new Date(Date.now() - 40 * 86_400_000);
		// Replace the array: the rail memoises its ordering on array identity (the host always
		// hands it a fresh array after a refresh).
		(snapshot as { threads: readonly SidebarThread[] }).threads = [
			...snapshot.threads,
			{ path: "/s/ancient.jsonl", title: "ancient thread", modified: old, messageCount: 3 },
		];
		assert.equal(sidebar.rows().length, 4, "old thread hidden by default");
		assert.ok(sidebar.render(30).some((line) => stripTerminalSequences(line).includes("+1 older")));

		sidebar.handleInput("/");
		assert.equal(sidebar.rows().length, 5, "search covers all history");
		for (const char of "anci") sidebar.handleInput(char);
		assert.equal(sidebar.rows().length, 1);
		assert.equal(sidebar.rows()[0]?.title, "ancient thread");

		sidebar.handleInput("\x1b");
		assert.equal(sidebar.rows().length, 5, "escape clears the query, keeps searching");
		sidebar.handleInput("\x1b");
		assert.equal(sidebar.rows().length, 4, "second escape leaves search");
	});

	it("backspace narrows the search query", () => {
		const { sidebar } = setup();
		sidebar.handleInput("/");
		for (const char of "refq") sidebar.handleInput(char);
		assert.equal(sidebar.rows().length, 0);
		sidebar.handleInput("\x7f");
		assert.equal(sidebar.rows().length, 1);
	});
});
