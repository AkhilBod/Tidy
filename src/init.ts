import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type Registry, addCourse, codeCandidates, loadClasses, saveClasses } from "./classes.ts";
import { CLASSES_FILE, CONFIG_FILE, type Config, DEFAULT_CONFIG, configExists, saveConfig } from "./config.ts";
import { HOME, rel } from "./util.ts";

type Discovery = {
	roots: string[];
	repos: string[];
	containers: Record<string, string>;
	courses: Record<string, { count: number; examples: string[] }>;
	screenshotLocation?: string;
	resumeFolders: string[];
	downloadsCount: number;
	archiveLike: string[];
};

const SKIP = new Set(["Library", "Applications", "node_modules", ".git", "Music", "Public"]);

function isDir(p: string) {
	try {
		const st = lstatSync(p);
		return st.isDirectory() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

function bucketGuess(name: string) {
	const n = name.toLowerCase();
	if (/school|class|course|homework|uni|college|cs\d|semester|fall|spring/.test(n)) return "school";
	if (/work|client|job|intern/.test(n)) return "work";
	if (/research|thesis|paper|lab/.test(n)) return "research";
	if (/experiment|scratch|sandbox|playground|test/.test(n)) return "experiments";
	if (/archive|old|backup/.test(n)) return "archive";
	return "personal";
}

export function discover(): Discovery {
	const d: Discovery = { roots: [], repos: [], containers: {}, courses: {}, resumeFolders: [], downloadsCount: 0, archiveLike: [] };
	for (const r of DEFAULT_CONFIG.roots) if (isDir(join(HOME, r.slice(2)))) d.roots.push(r);

	const names: string[] = [];
	const walk = (dir: string, depth: number) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		const childRepos: string[] = [];
		for (const e of entries) {
			if (e.startsWith(".") || SKIP.has(e)) continue;
			const p = join(dir, e);
			names.push(e);
			if (!isDir(p)) continue;
			if (/^resumes?$/i.test(e)) d.resumeFolders.push(p);
			if (/^(archive|old|backup)s?$/i.test(e)) d.archiveLike.push(p);
			if (existsSync(join(p, ".git"))) {
				d.repos.push(p);
				childRepos.push(e);
				continue;
			}
			if (depth > 0) walk(p, depth - 1);
		}
		if (childRepos.length >= 2 && dir !== HOME && !DEFAULT_CONFIG.roots.map((r) => join(HOME, r.slice(2))).includes(dir)) {
			d.containers[basename(dir)] = bucketGuess(basename(dir));
		}
	};
	for (const r of d.roots) walk(join(HOME, r.slice(2)), 2);
	walk(HOME, 0);

	// Course codes that show up in more than one name are probably real courses.
	const counts = new Map<string, { count: number; examples: string[] }>();
	for (const n of names) {
		for (const code of new Set(codeCandidates(n))) {
			const row = counts.get(code) ?? { count: 0, examples: [] };
			row.count++;
			if (row.examples.length < 3) row.examples.push(n);
			counts.set(code, row);
		}
	}
	for (const [code, row] of counts) if (row.count >= 2) d.courses[code] = row;

	try {
		d.screenshotLocation = execFileSync("/usr/bin/defaults", ["read", "com.apple.screencapture", "location"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {}
	try {
		d.downloadsCount = readdirSync(join(HOME, "Downloads")).filter((e) => !e.startsWith(".")).length;
	} catch {}
	return d;
}

export function proposeConfig(d: Discovery): Config {
	const c: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	c.roots = d.roots;
	c.code.containers = d.containers;
	if (d.screenshotLocation?.startsWith(HOME)) c.destinations.screenshots = `~${d.screenshotLocation.slice(HOME.length)}`;
	if (d.resumeFolders.length === 1) {
		const r = d.resumeFolders[0];
		c.destinations.career = `~${r.slice(HOME.length)}`.replace(/\/[^/]+$/, "");
		c.categories.career_resume.destination = `{career}/${basename(r)}`;
	}
	return c;
}

export function proposeClasses(d: Discovery, existing: Registry): Registry {
	const r: Registry = { ...existing };
	for (const [code, row] of Object.entries(d.courses)) {
		if (r[code]) continue;
		addCourse(r, code, { source: "init", aliases: [] });
	}
	return r;
}

export function runInit(opts: { write: boolean; force: boolean }) {
	const d = discover();
	const config = proposeConfig(d);
	const classes = proposeClasses(d, loadClasses());

	console.log(`Roots: ${d.roots.join(", ")}`);
	console.log(`Git repos: ${d.repos.length}${d.repos.length ? ` (e.g. ${d.repos.slice(0, 3).map(rel).join(", ")})` : ""}`);
	console.log(`Project containers: ${Object.entries(d.containers).map(([k, v]) => `${k} -> ${v}`).join(", ") || "none"}`);
	console.log(`Courses seen: ${Object.entries(d.courses).map(([k, v]) => `${k} (${v.count}x, e.g. ${v.examples[0]})`).join("; ") || "none"}`);
	console.log(`Screenshots land in: ${d.screenshotLocation ? rel(d.screenshotLocation) : "~/Desktop (macOS default)"}`);
	console.log(`Resume folders: ${d.resumeFolders.map(rel).join(", ") || "none"}`);
	console.log(`Downloads: ${d.downloadsCount} items`);
	console.log(`Archive-like folders: ${d.archiveLike.map(rel).join(", ") || "none"}\n`);
	console.log("Proposed config:");
	console.log(JSON.stringify({ roots: config.roots, destinations: config.destinations, thresholds: config.thresholds, code: config.code }, null, 2));
	console.log(`\nProposed classes: ${Object.keys(classes).join(", ") || "none"}`);

	if (!opts.write) {
		console.log("\nDry run. Re-run without --dry-run to write the config. Nothing is moved by init.");
		return;
	}
	if (configExists() && !opts.force) {
		console.log(`\n${rel(CONFIG_FILE)} already exists; pass --force to overwrite it.`);
		return;
	}
	saveConfig(config);
	saveClasses(classes);
	console.log(`\nWrote ${rel(CONFIG_FILE)} and ${rel(CLASSES_FILE)}.`);
	console.log("Next: edit the config if you like, add course names with `tidy class edit <CODE> --name ... --institution ...`,");
	console.log("put TYPESAFE_API_KEY in ~/.config/tidy/env, then `tidy plan`.");
}
