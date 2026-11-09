import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, it } from "vitest";
import { initDevStatus, setDevBusy } from "../src/core/dev-status.ts";

const directory = mkdtempSync(join(tmpdir(), "euler-dev-status-"));
const target = join(directory, "status.json");

function read(): { busy: boolean } {
	return JSON.parse(readFileSync(target, "utf8")) as { busy: boolean };
}

afterEach(() => {
	delete process.env.EULER_DEV_STATUS;
	setDevBusy("agent", false);
	setDevBusy("compaction", false);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("dev status", () => {
	it("publishes turn and compaction transitions", () => {
		process.env.EULER_DEV_STATUS = target;
		initDevStatus();
		assert.equal(read().busy, false);
		setDevBusy("agent", true);
		assert.equal(read().busy, true);
		setDevBusy("compaction", true);
		setDevBusy("agent", false);
		assert.equal(read().busy, true, "compaction keeps the app busy");
		setDevBusy("compaction", false);
		assert.equal(read().busy, false);
	});

	it("is a no-op without the supervisor environment", () => {
		assert.doesNotThrow(() => initDevStatus());
		assert.doesNotThrow(() => setDevBusy("agent", true));
	});
});
