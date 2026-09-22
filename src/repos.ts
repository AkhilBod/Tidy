import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { writeJournal } from "./act.ts";
import { type Registry, loadClasses, matchCourse } from "./classes.ts";
import { dest, loadConfig, resolveTemplate } from "./config.ts";
import { decide, mapPool } from "./jev.ts";
import { folderQuestions, folderState } from "./questions.ts";
import { type Fact, isProtected, scanRoot } from "./scan.ts";
import { HOME, expand, kebab, rel, uniquePath } from "./util.ts";

export type RepoMove = {
	from: string;
	to?: string;
	op: "move" | "review" | "skip";
	reason: string;
	confidence: number;
	warnings?: string[];
};

const claudeSlug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

function containerBucket(name: string) {
	const containers = loadConfig().code.containers;
	const key = Object.keys(containers).find((k) => k.trim().toLowerCase() === name.trim().toLowerCase());
	return key ? containers[key] : undefined;
}

function candidates(): { fact: Fact; bucket?: string }[] {
	const out: { fact: Fact; bucket?: string }[] = [];
	const walk = (root: string, bucket?: string) => {
		for (const f of scanRoot(root)) {
			if (!f.isDir || isProtected(f.name)) continue;
			const container = containerBucket(f.name);
			if (container && !existsSync(join(f.path, ".git"))) walk(f.path, container);
			else out.push({ fact: f, bucket });
		}
	};
	for (const r of loadConfig().roots.map(expand)) if (existsSync(r)) walk(r);
	return out;
}

function codeDest(bucket: string, name: string, registry: Registry) {
	const c = loadConfig();
	if (bucket === "school") {
		const course = matchCourse(name, registry);
		if (course) return join(resolveTemplate(c.school.codeTemplate, { course, institution: registry[course]?.institution }), name);
	}
	return join(dest("code"), bucket, name);
}

export async function planRepos(only?: string[], forceBucket?: string): Promise<RepoMove[]> {
	const c = loadConfig();
	const registry = loadClasses();
	let list = candidates();
	if (only?.length) list = list.filter((x) => only.includes(x.fact.path));
	if (forceBucket && only?.length) list = list.map((x) => ({ ...x, bucket: forceBucket }));
	const cwd = process.cwd();
	const questions = folderQuestions(c.code.buckets);
	const { move } = c.thresholds;

	return mapPool(list, 8, async ({ fact: f, bucket }) => {
		const base = { from: f.path };
		if (cwd === f.path || cwd.startsWith(`${f.path}/`)) {
			return { ...base, op: "skip", reason: "current working directory is inside it", confidence: 1 };
		}
		if ((f.childCount ?? 0) === 0) return { ...base, op: "skip", reason: "empty (file pass parks it)", confidence: 1 };
		const name = kebab(f.name);
		if (name.length < 3) return { ...base, op: "review", reason: `name "${f.name}" needs a human rename`, confidence: 0 };

		// A repo inside a named container, or an explicit bucket, needs no judgement call.
		if ((f.hasGit || forceBucket) && bucket) {
			return { ...base, op: "move", to: codeDest(bucket, name, registry), reason: `repo in ${bucket} container`, confidence: 1 };
		}
		// A repo named after a registered course is school work.
		const course = matchCourse(f.name, registry);
		if (f.hasGit && course && c.code.buckets.includes("school")) {
			return { ...base, op: "move", to: codeDest("school", name, registry), reason: `repo for course ${course}`, confidence: 1 };
		}

		let a: Awaited<ReturnType<typeof decide<typeof questions>>>;
		try {
			a = await decide(folderState(f), questions);
		} catch (err) {
			return { ...base, op: "review", reason: `jev error: ${(err as Error).message.slice(0, 80)}`, confidence: 0 };
		}
		const kind = a.kind.choice;
		const kindConf = a.kind.confidence ?? 0;
		if (kindConf < move) return { ...base, op: "review", reason: `kind ${kind} below ${move}`, confidence: kindConf };
		if (kind === "export_dump") return { ...base, op: "move", to: join(dest("exports"), name), reason: kind, confidence: kindConf };
		if (kind === "documents" || (kind === "scratch" && !f.hasGit)) {
			return { ...base, op: "review", reason: `${kind} folder, not code`, confidence: kindConf };
		}
		const dormant = f.hasGit && (f.lastCommitDays ?? 0) > c.code.dormantDays && kind !== "code_project" && c.code.buckets.includes("archive");
		let group = dormant ? "archive" : bucket;
		let conf = kindConf;
		if (!group) {
			conf = Math.min(conf, a.bucket.confidence ?? 0);
			if (conf < move) return { ...base, op: "review", reason: `bucket ${a.bucket.choice} below ${move}`, confidence: conf };
			group = a.bucket.choice as string;
		}
		return {
			...base,
			op: "move",
			to: codeDest(group, name, registry),
			reason: dormant ? `${kind}, dormant ${f.lastCommitDays}d` : `${kind} -> ${group}`,
			confidence: conf,
		};
	});
}

function dirty(repo: string) {
	if (!existsSync(join(repo, ".git"))) return false;
	const out = execFileSync("/usr/bin/git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
	return out.trim().length > 0;
}

function gitHead(repo: string) {
	try {
		return execFileSync("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function processesInside(dir: string) {
	try {
		const out = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return out.split("\n").some((l) => l === `n${dir}` || l.startsWith(`n${dir}/`));
	} catch {
		return false;
	}
}

const TEXT_EXT = new Set([".env", ".json", ".plist", ".yml", ".yaml", ".toml", ".sh", ".code-workspace", ".ini", ".cfg", ".xml"]);

/** Files (inside the repo, two levels deep, and in LaunchAgents) that spell out the repo's absolute path. */
export function hardcodedPaths(repo: string): string[] {
	const hits: string[] = [];
	const check = (file: string) => {
		try {
			if (statSync(file).size > 512e3) return;
			if (readFileSync(file, "utf8").includes(repo)) hits.push(file);
		} catch {}
	};
	const walk = (dir: string, depth: number) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			if (e === "node_modules" || e === ".git") continue;
			const p = join(dir, e);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (depth > 0) walk(p, depth - 1);
			} else if (TEXT_EXT.has(extname(e)) || e.startsWith(".env")) check(p);
		}
	};
	walk(repo, 2);
	const agents = join(HOME, "Library", "LaunchAgents");
	if (existsSync(agents)) for (const f of readdirSync(agents)) check(join(agents, f));
	return hits;
}

/** Moves one project, optionally leaves a symlink at the old path, and carries its Claude memory along. */
export function moveRepo(m: RepoMove, opts: { allowDirty?: boolean; symlink?: boolean } = {}) {
	if (m.op !== "move" || !m.to) return false;
	const c = loadConfig();
	if (!opts.allowDirty && dirty(m.from)) {
		console.log(`uncommitted changes, skipped: ${rel(m.from)} (--allow-dirty to move anyway)`);
		return false;
	}
	if (processesInside(m.from)) {
		console.log(`a running process is using it, skipped: ${rel(m.from)}`);
		return false;
	}
	const headBefore = gitHead(m.from);
	const refs = hardcodedPaths(m.from);
	const to = uniquePath(m.to);
	const batch = new Date().toISOString();
	const log = (from: string, destPath: string, reason: string, n: number) =>
		writeJournal({ id: `${batch}#${n}`, ts: new Date().toISOString(), batch, op: "move", from, to: destPath, reason, confidence: m.confidence });

	mkdirSync(dirname(to), { recursive: true });
	renameSync(m.from, to);
	if (opts.symlink ?? c.code.compatSymlink) symlinkSync(to, m.from);
	log(m.from, to, `repo: ${m.reason}`, 0);

	if (headBefore && gitHead(to) !== headBefore) console.log(`  WARNING: git HEAD changed for ${rel(to)}`);

	const projects = join(HOME, ".claude", "projects");
	const oldSlug = claudeSlug(m.from);
	const newSlug = claudeSlug(to);
	let n = 1;
	if (existsSync(projects)) {
		for (const d of readdirSync(projects)) {
			if (d !== oldSlug && !d.startsWith(`${oldSlug}-`)) continue;
			const target = join(projects, newSlug + d.slice(oldSlug.length));
			if (existsSync(target)) continue;
			renameSync(join(projects, d), target);
			log(join(projects, d), target, "claude project memory follows repo", n++);
		}
	}
	for (const hit of refs) console.log(`  fix by hand, references old path: ${rel(hit.replace(m.from, to))}`);
	console.log(`moved ${rel(m.from)} -> ${rel(to)}`);
	return true;
}
