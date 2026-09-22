import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { readJournal, writeJournal } from "./act.ts";
import { rel } from "./util.ts";

/** Journal rows that have not been undone, newest first. */
export function liveRows() {
	const rows = readJournal();
	const undone = new Set(rows.filter((r) => r.op === "undo").map((r) => r.ref));
	return rows.filter((r) => r.op !== "undo" && !undone.has(r.id)).reverse();
}

/** Replays the journal backwards. Default: the most recent batch. */
export function undo({ last, since, all, ids, batch }: { last?: number; since?: string; all?: boolean; ids?: string[]; batch?: string }) {
	let live = liveRows();
	if (ids?.length) live = live.filter((r) => ids.includes(r.id));
	else if (batch) live = live.filter((r) => r.batch === batch);
	else if (last) live = live.slice(0, last);
	else if (since) live = live.filter((r) => r.ts >= since);
	else if (!all) live = live.filter((r) => r.batch === live[0]?.batch);

	let restored = 0;
	for (const r of live) {
		if (!existsSync(r.to)) {
			console.log(`gone, cannot restore: ${rel(r.to)}`);
			continue;
		}
		if (existsSync(r.from)) {
			console.log(`original path occupied, left in place: ${rel(r.to)}`);
			continue;
		}
		mkdirSync(dirname(r.from), { recursive: true });
		renameSync(r.to, r.from);
		writeJournal({
			id: `${new Date().toISOString()}#undo-${restored}`,
			ts: new Date().toISOString(),
			batch: r.batch,
			op: "undo",
			from: r.to,
			to: r.from,
			reason: "undo",
			confidence: 1,
			ref: r.id,
		});
		restored++;
	}
	// Remove folders Tidy created, if they are empty again.
	for (const r of live) {
		if (!r.made) continue;
		for (let d = dirname(r.to); d.startsWith(r.made); d = dirname(d)) {
			if (!existsSync(d) || readdirSync(d).length > 0) break;
			rmdirSync(d);
		}
	}
	return restored;
}
