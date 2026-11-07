import assert from "node:assert";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { EulerSidebar, orderThreads, relativeAge, type SidebarSnapshot } from "../src/modes/euler/euler-sidebar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

const OLD = new Date("2026-11-01T10:00:00Z");
const MID = new Date("2026-11-06T10:00:00Z");
const NEW = new Date("2026-11-07T10:00:00Z");

function setup() {
	const events: string[] = [];
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
			{ path: "/s/old.jsonl", title: "old thread", modified: OLD, messageCount: 2 },
			{
				path: "/s/orphan.jsonl",
				title: "orphan fork",
				modified: OLD,
				messageCount: 1,
				parentPath: "/s/missing.jsonl",
			},
		],
		currentPath: "/s/parent.jsonl",
		loading: false,
	};
	const sidebar = new EulerSidebar({
		read: () => snapshot,
		readHeight: () => 20,
		onOpen: (path) => events.push(`open:${path}`),
		onNew: () => events.push("new"),
		onHide: () => events.push("hide"),
		onBlur: () => events.push("blur"),
		onRefresh: () => events.push("refresh"),
		requestRender: () => {},
	});
	sidebar.focused = true;
	return { sidebar, snapshot, events };
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

	it("renders a header, markers and ages", () => {
		const { sidebar } = setup();
		const lines = sidebar.render(30).join("\n");
		assert.ok(lines.includes("threads 4"));
		assert.ok(lines.includes("● refactor auth"));
		assert.ok(lines.includes("○ old thread"));
		const plain = sidebar.render(30).map((line) => stripTerminalSequences(line));
		assert.ok(plain.some((line) => line.startsWith("└ ○ ") && line.includes("compare option B")));
		assert.ok(
			plain.some((line) => line.includes("j/k move")),
			"footer hint",
		);
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

	it("formats relative ages", () => {
		const now = new Date("2026-11-07T10:00:30Z").getTime();
		assert.equal(relativeAge(new Date("2026-11-07T10:00:00Z"), now), "30s");
		assert.equal(relativeAge(new Date("2026-11-07T09:30:00Z"), now), "30m");
		assert.equal(relativeAge(new Date("2026-11-07T05:00:00Z"), now), "5h");
		assert.equal(relativeAge(new Date("2026-11-04T10:00:00Z"), now), "3d");
	});
});
