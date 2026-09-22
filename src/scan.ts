import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { isDestination, loadConfig } from "./config.ts";
import { HOME, expand } from "./util.ts";

export type Fact = {
	path: string;
	name: string;
	ext: string;
	isDir: boolean;
	size: number;
	sizeBucket: string;
	mtimeMs: number;
	ageDays: number;
	root: string;
	parent: string;
	siblings: string[];
	childExt?: Record<string, number>;
	childCount?: number;
	hasGit?: boolean;
	lastCommitDays?: number;
};

const SKIP_EXT = new Set([".app", ".photoslibrary", ".localized", ".musiclibrary", ".xcodeproj", ".xcworkspace", ".framework", ".bundle"]);

export function isProtected(name: string) {
	return loadConfig().protected.includes(name);
}

function sizeBucket(n: number) {
	if (n < 100e3) return "<100KB";
	if (n < 10e6) return "<10MB";
	if (n < 100e6) return "<100MB";
	if (n < 1e9) return "<1GB";
	return ">=1GB";
}

// Does this dir, or anything up to two levels below it, hold a git repo?
export function findGit(dir: string, depth = 2): string | undefined {
	if (existsSync(join(dir, ".git"))) return dir;
	if (depth === 0) return undefined;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return undefined;
	}
	for (const e of entries) {
		if (e.startsWith(".") || e === "node_modules") continue;
		const p = join(dir, e);
		try {
			if (!statSync(p).isDirectory()) continue;
		} catch {
			continue;
		}
		const hit = findGit(p, depth - 1);
		if (hit) return hit;
	}
	return undefined;
}

export function lastCommitDays(repo: string): number | undefined {
	try {
		const out = execFileSync("/usr/bin/git", ["-C", repo, "log", "-1", "--format=%ct"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!out) return undefined;
		return Math.floor((Date.now() / 1000 - Number(out)) / 86400);
	} catch {
		return undefined;
	}
}

function childSummary(dir: string) {
	const hist: Record<string, number> = {};
	let count = 0;
	try {
		for (const e of readdirSync(dir)) {
			if (e === ".DS_Store") continue;
			count++;
			const ext = extname(e).toLowerCase() || "(none)";
			hist[ext] = (hist[ext] || 0) + 1;
		}
	} catch {}
	return { hist, count };
}

// Top-level items only. Tidy never reaches inside folders.
export function scanRoot(root: string): Fact[] {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const visible = entries.filter((e) => !e.startsWith("."));
	const facts: Fact[] = [];
	const isHome = root === HOME;

	for (const name of visible) {
		const path = join(root, name);
		const ext = extname(name).toLowerCase();
		if (isProtected(name) || isDestination(path)) continue;
		// Bundles are never entered or moved, except an .app someone downloaded into an inbox.
		if (SKIP_EXT.has(ext) && !(ext === ".app" && loadConfig().inbox.roots.map(expand).includes(root))) continue;
		let st: ReturnType<typeof statSync>;
		try {
			st = lstatSync(path);
		} catch {
			continue;
		}
		// Symlinks are what Tidy leaves behind after a repo move; never touch them.
		if (st.isSymbolicLink()) continue;
		const isDir = st.isDirectory();
		// In ~ itself only loose files are fair game; dirs there are system or tool homes.
		if (isHome && isDir) continue;
		if (!isDir && !st.isFile()) continue;

		const fact: Fact = {
			path,
			name,
			ext,
			isDir,
			size: st.size,
			sizeBucket: isDir ? "folder" : sizeBucket(st.size),
			mtimeMs: st.mtimeMs,
			ageDays: Math.floor((Date.now() - st.mtimeMs) / 86400e3),
			root,
			parent: isHome ? "home" : basename(root),
			siblings: visible.filter((s) => s !== name).slice(0, 15),
		};
		if (isDir) {
			const { hist, count } = childSummary(path);
			fact.childExt = hist;
			fact.childCount = count;
			const git = findGit(path);
			fact.hasGit = !!git;
			if (git) fact.lastCommitDays = lastCommitDays(git);
		}
		facts.push(fact);
	}
	return facts;
}

export function scan(roots: string[]) {
	return roots.flatMap(scanRoot);
}
