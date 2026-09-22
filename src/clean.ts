import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeJournal } from "./act.ts";
import { dest, loadConfig } from "./config.ts";
import { findGit, isProtected, lastCommitDays } from "./scan.ts";
import { expand, rel } from "./util.ts";

export type Reclaim = {
	path: string;
	sizeMB: number;
	lastModified: string;
	reason: string;
	/** safe = regenerable and its project is dormant; candidate = report only. */
	tier: "safe" | "candidate";
	repo?: string;
};

function sizeMB(path: string) {
	try {
		const out = execFileSync("/usr/bin/du", ["-sk", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return Math.round(Number(out.split("\t")[0]) / 1024);
	} catch {
		return 0;
	}
}

function repoOf(path: string) {
	for (let d = dirname(path); d !== "/" && d.length > 1; d = dirname(d)) if (existsSync(join(d, ".git"))) return d;
	return undefined;
}

function processesInside(dir: string) {
	try {
		const out = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return out.split("\n").some((l) => l === `n${dir}` || l.startsWith(`n${dir}/`));
	} catch {
		return false;
	}
}

/** Regenerable build/dependency folders under the roots and the code tree, plus known caches. */
export function scanReclaim(): Reclaim[] {
	const c = loadConfig();
	const regen = new Set(c.clean.regenerable);
	const out: Reclaim[] = [];
	const seen = new Set<string>();

	const walk = (dir: string, depth: number) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e);
			let st: ReturnType<typeof lstatSync>;
			try {
				st = lstatSync(p);
			} catch {
				continue;
			}
			if (!st.isDirectory() || st.isSymbolicLink()) continue;
			if (regen.has(e)) {
				if (seen.has(p)) continue;
				seen.add(p);
				const mb = sizeMB(p);
				if (mb < c.clean.minSizeMB) continue;
				const repo = repoOf(p);
				const dormant = repo ? (lastCommitDays(repo) ?? 0) > c.clean.dormantDays : st.mtimeMs < Date.now() - c.clean.dormantDays * 86400e3;
				const busy = repo ? processesInside(repo) : false;
				out.push({
					path: p,
					sizeMB: mb,
					lastModified: new Date(st.mtimeMs).toISOString().slice(0, 10),
					reason: repo
						? `${e} in ${basename(repo)} (last commit ${lastCommitDays(repo) ?? "?"}d ago${busy ? ", in use" : ""})`
						: `${e} outside any repo`,
					tier: dormant && !busy ? "safe" : "candidate",
					repo,
				});
				continue;
			}
			if (e.startsWith(".") || isProtected(e) || e === "Library" || e.endsWith(".app")) continue;
			if (depth > 0) walk(p, depth - 1);
		}
	};
	for (const r of [...c.roots.map(expand), dest("code")]) if (existsSync(r)) walk(r, 4);

	for (const cache of c.clean.caches.map(expand)) {
		if (!existsSync(cache)) continue;
		const mb = sizeMB(cache);
		if (mb < c.clean.minSizeMB) continue;
		out.push({
			path: cache,
			sizeMB: mb,
			lastModified: new Date(lstatSync(cache).mtimeMs).toISOString().slice(0, 10),
			reason: "application or package cache; the owning app rebuilds it",
			tier: "candidate",
		});
	}
	// Stale exports and installers already parked.
	for (const key of ["exports", "installers"]) {
		const d = dest(key);
		if (!existsSync(d)) continue;
		for (const e of readdirSync(d)) {
			const p = join(d, e);
			let st: ReturnType<typeof lstatSync>;
			try {
				st = lstatSync(p);
			} catch {
				continue;
			}
			const ageDays = (Date.now() - st.mtimeMs) / 86400e3;
			if (ageDays < 365) continue;
			const mb = st.isDirectory() ? sizeMB(p) : Math.round(st.size / 1048576);
			if (mb < c.clean.minSizeMB) continue;
			out.push({ path: p, sizeMB: mb, lastModified: new Date(st.mtimeMs).toISOString().slice(0, 10), reason: `${key} item untouched for a year`, tier: "candidate" });
		}
	}
	return out.sort((a, b) => b.sizeMB - a.sizeMB);
}

/** Park safe-tier items in {trash}/Reclaim/<repo>/<name>. Reversible with undo. */
export function applyReclaim(items: Reclaim[]) {
	const batch = new Date().toISOString();
	let n = 0;
	for (const it of items) {
		if (it.tier !== "safe") continue;
		const to = join(dest("trash"), "Reclaim", it.repo ? basename(it.repo) : "loose", `${basename(it.path)}-${batch.slice(0, 10)}`);
		if (existsSync(to)) continue;
		mkdirSync(dirname(to), { recursive: true });
		renameSync(it.path, to);
		writeJournal({ id: `${batch}#${n}`, ts: new Date().toISOString(), batch, op: "hold", from: it.path, to, reason: `reclaim: ${it.reason}`, confidence: 1 });
		console.log(`parked ${rel(it.path)} (${it.sizeMB} MB)`);
		n++;
	}
	return n;
}

export function printReclaim(items: Reclaim[]) {
	for (const it of items) {
		console.log(`${it.tier.padEnd(9)} ${String(it.sizeMB).padStart(7)} MB  ${it.lastModified}  ${rel(it.path)}  [${it.reason}]`);
	}
	const safe = items.filter((i) => i.tier === "safe").reduce((s, i) => s + i.sizeMB, 0);
	const all = items.reduce((s, i) => s + i.sizeMB, 0);
	console.log(`\n${items.length} items, ${(all / 1024).toFixed(1)} GB total, ${(safe / 1024).toFixed(1)} GB safe to park (\`tidy clean --apply\`)`);
}
