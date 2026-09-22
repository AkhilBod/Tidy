import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJournal } from "./act.ts";
import { dest, stateDir } from "./config.ts";
import type { Action } from "./rules.ts";
import { rel } from "./util.ts";

const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

export function summarize(actions: Action[]) {
	const by = (op: Action["op"]) => actions.filter((a) => a.op === op);
	const sum = (xs: Action[]) => xs.reduce((s, a) => s + a.size, 0);
	return { move: by("move").length, hold: by("hold").length, holdBytes: sum(by("hold")), review: by("review").length, skip: by("skip").length };
}

export function printPlan(actions: Action[], showSkips = false) {
	const order = { hold: 0, move: 1, review: 2, skip: 3 };
	for (const a of [...actions].sort((x, y) => order[x.op] - order[y.op])) {
		if (a.op === "skip" && !showSkips) continue;
		const c = a.source === "rule" ? "rule" : a.confidence.toFixed(2);
		const to = a.to ? ` -> ${rel(a.to)}` : "";
		console.log(`${a.op.padEnd(6)} ${c.padEnd(4)} ${rel(a.from)}${to}  [${a.reason}]`);
	}
	const s = summarize(actions);
	console.log(`\n${s.move} move, ${s.hold} to holding (${gb(s.holdBytes)}), ${s.review} review, ${s.skip} skip`);
}

export function writeReview(actions: Action[]) {
	mkdirSync(stateDir(), { recursive: true });
	const rows = actions.filter((a) => a.op === "review" || (a.op === "hold" && a.to?.startsWith(dest("unsure"))));
	const lines = [
		"# Tidy review queue",
		"",
		`Updated ${new Date().toISOString().slice(0, 16)}. Tidy was not sure about these. Teach it with:`,
		"",
		"    tidy resolve <path> --course CS1555 --type homework --assignment HW4",
		"    tidy resolve <path> --category finance_legal",
		"",
		...rows.map((a) => `- \`${rel(a.to ?? a.from)}\` — ${a.reason} (${a.confidence.toFixed(2)})`),
	];
	writeFileSync(join(stateDir(), "Review.md"), `${lines.join("\n")}\n`);
	return rows.length;
}

function diskFree() {
	try {
		return execFileSync("/bin/df", ["-h", "/"], { encoding: "utf8" }).split("\n")[1];
	} catch {
		return "n/a";
	}
}

function dirSize(p: string) {
	try {
		return Number(execFileSync("/usr/bin/du", ["-sk", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\t")[0]) * 1024;
	} catch {
		return 0;
	}
}

function countItems(p: string) {
	try {
		let n = 0;
		const walk = (d: string) => {
			for (const e of readdirSync(d)) {
				const q = join(d, e);
				if (statSync(q).isDirectory()) walk(q);
				else n++;
			}
		};
		walk(p);
		return n;
	} catch {
		return 0;
	}
}

export function holdingSummary() {
	return (["trash", "duplicates", "unsure"] as const).map((k) => {
		const p = dest(k);
		return { key: k, path: p, items: existsSync(p) ? countItems(p) : 0, bytes: existsSync(p) ? dirSize(p) : 0 };
	});
}

export function printHolding() {
	for (const h of holdingSummary()) console.log(`${h.key.padEnd(11)} ${String(h.items).padStart(5)} items  ${gb(h.bytes).padStart(9)}  ${rel(h.path)}`);
	console.log("\nTidy never deletes. Review these in Finder and delete what you don't want; `tidy undo` puts things back.");
}

function failedAgents() {
	try {
		return execFileSync("/bin/launchctl", ["list"], { encoding: "utf8" })
			.split("\n")
			.slice(1)
			.map((l) => l.split("\t"))
			.filter(([, status, label]) => label && !label.startsWith("com.apple") && status !== "0" && status !== "-")
			.map(([, status, label]) => `${label} (exit ${status})`);
	} catch {
		return [];
	}
}

export function weeklyReport(actions: Action[]) {
	const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
	const recent = readJournal().filter((r) => r.ts >= weekAgo && r.op !== "undo");
	const s = summarize(actions);
	const d = new Date();
	const week = Math.ceil(((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400e3 + 1) / 7);
	const file = join(stateDir(), "reports", `${d.getFullYear()}-W${String(week).padStart(2, "0")}.md`);
	mkdirSync(join(stateDir(), "reports"), { recursive: true });
	const failed = failedAgents();
	const lines = [
		`# Tidy weekly — ${d.toISOString().slice(0, 10)}`,
		"",
		`Disk: \`${diskFree()}\``,
		"",
		"## Holding folders (review and delete by hand)",
		...holdingSummary().map((h) => `- ${h.key}: ${h.items} items, ${gb(h.bytes)} — \`${rel(h.path)}\``),
		"",
		`## Last 7 days: ${recent.length} actions`,
		...recent.slice(-40).map((r) => `- ${r.op} \`${rel(r.from)}\` -> \`${rel(r.to)}\` (${r.reason})`),
		"",
		`## Pending: ${s.review} in review, ${s.hold} headed to holding (${gb(s.holdBytes)})`,
		...actions.filter((a) => a.op === "hold").sort((a, b) => b.size - a.size).slice(0, 10).map((a) => `- ${gb(a.size)} \`${rel(a.from)}\` (${a.reason})`),
		"",
		"## Failed LaunchAgents",
		...(failed.length ? failed.map((x) => `- ${x}`) : ["- none"]),
		"",
	];
	writeFileSync(file, lines.join("\n"));
	return file;
}
