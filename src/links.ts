import { existsSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { readJournal, writeJournal } from "./act.ts";
import { rel } from "./util.ts";

/** Compatibility symlinks Tidy left at old repo paths, still pointing where the repo went. */
export function tidyLinks() {
	const out: { from: string; to: string }[] = [];
	for (const r of readJournal()) {
		if (r.op !== "move" || !r.reason.startsWith("repo:")) continue;
		try {
			if (lstatSync(r.from).isSymbolicLink() && readlinkSync(r.from) === r.to && existsSync(r.to)) out.push({ from: r.from, to: r.to });
		} catch {}
	}
	return out;
}

export function removeLinks() {
	const batch = new Date().toISOString();
	let n = 0;
	for (const l of tidyLinks()) {
		unlinkSync(l.from);
		writeJournal({ id: `${batch}#${n++}`, ts: new Date().toISOString(), batch, op: "undo", from: l.from, to: l.to, reason: "removed compatibility symlink", confidence: 1 });
		console.log(`unlinked ${rel(l.from)}`);
	}
	return n;
}
