/**
 * Dev-supervisor interlock.
 *
 * `euler --dev` sets `EULER_DEV_STATUS`; this module publishes whether a turn or a compaction is in
 * flight so the supervisor can queue a reload instead of killing the turn doing the edit.
 *
 * Module state, not instance state: several tests build partial `InteractiveMode` objects, and a
 * method call on those mocks is exactly the kind of breakage the interlock must not introduce.
 */

import { writeFileSync } from "node:fs";

let agentBusy = false;
let compactionBusy = false;

function publish(): void {
	const target = process.env.EULER_DEV_STATUS;
	if (!target) return;
	try {
		writeFileSync(
			target,
			JSON.stringify({ busy: agentBusy || compactionBusy, pid: process.pid, updatedAt: Date.now() }),
		);
	} catch {
		// Best effort: a broken status file must not break the UI.
	}
}

/** Publish an idle state at startup so the supervisor can leave its manual bootstrap mode. */
export function initDevStatus(): void {
	agentBusy = false;
	compactionBusy = false;
	publish();
}

export function setDevBusy(kind: "agent" | "compaction", busy: boolean): void {
	if (kind === "agent") agentBusy = busy;
	else compactionBusy = busy;
	publish();
}
