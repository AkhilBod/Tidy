import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./config.ts";
import type { Action } from "./rules.ts";
import { rel, uniquePath } from "./util.ts";

export type JournalRow = {
	id: string;
	ts: string;
	batch: string;
	op: "move" | "hold" | "undo";
	from: string;
	to: string;
	reason: string;
	confidence: number;
	ref?: string;
	made?: string;
};

export const journalFile = () => join(stateDir(), "journal.jsonl");

function isOpen(path: string) {
	try {
		execFileSync("/usr/sbin/lsof", ["--", path], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function readJournal(): JournalRow[] {
	const file = journalFile();
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as JournalRow);
}

export function writeJournal(row: JournalRow) {
	mkdirSync(stateDir(), { recursive: true });
	appendFileSync(journalFile(), `${JSON.stringify(row)}\n`);
}

/** Executes move/hold actions. Never overwrites, never deletes. */
export function act(actions: Action[]) {
	const batch = new Date().toISOString();
	let done = 0;
	let n = 0;
	for (const a of actions) {
		if ((a.op !== "move" && a.op !== "hold") || !a.to) continue;
		if (!existsSync(a.from)) continue;
		if (statSync(a.from).isFile() && isOpen(a.from)) {
			console.log(`open, skipped: ${rel(a.from)}`);
			continue;
		}
		const to = uniquePath(a.to);
		// Topmost folder this move has to create, so undo can remove it again.
		let made: string | undefined;
		for (let d = dirname(to); !existsSync(d); d = dirname(d)) made = d;
		try {
			mkdirSync(dirname(to), { recursive: true });
			renameSync(a.from, to);
		} catch (err) {
			console.log(`failed: ${rel(a.from)} (${(err as NodeJS.ErrnoException).code})`);
			continue;
		}
		writeJournal({
			id: `${batch}#${n++}`,
			ts: new Date().toISOString(),
			batch,
			op: a.op,
			from: a.from,
			to,
			reason: a.reason,
			confidence: a.confidence,
			made,
		});
		done++;
	}
	return { batch, done };
}
