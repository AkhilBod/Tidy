import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { type Registry, loadClasses, matchCourse } from "./classes.ts";
import { dest, loadConfig, resolveTemplate, stateDir } from "./config.ts";
import { type JevAnswer, decide, mapPool } from "./jev.ts";
import { type Correction, loadLearned, lookup } from "./learned.ts";
import { fileQuestions, fileState, schoolQuestions, schoolState } from "./questions.ts";
import { type Action, applyRules } from "./rules.ts";
import { type CourseworkType, assignmentId, courseworkType, inferCourse, isCodeHeavy, schoolDir } from "./school.ts";
import { type Fact, scan } from "./scan.ts";
import { expand, stripDupeMarker, yearMonth } from "./util.ts";

type FileAnswers = Record<"category" | "project" | "disposable", JevAnswer>;
type SchoolAnswers = Record<"course" | "type", JevAnswer>;

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);

function loadCache() {
	const cache = new Map<string, unknown>();
	const file = join(stateDir(), "cache.jsonl");
	if (!existsSync(file)) return cache;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		const row = JSON.parse(line) as { key: string; answers: unknown };
		cache.set(row.key, row.answers);
	}
	return cache;
}

function remember(cache: Map<string, unknown>, key: string, answers: unknown) {
	cache.set(key, answers);
	mkdirSync(stateDir(), { recursive: true });
	appendFileSync(join(stateDir(), "cache.jsonl"), `${JSON.stringify({ key, answers })}\n`);
}

const cacheKey = (f: Fact, q: string) => `${q}|${f.path}|${f.size}|${Math.floor(f.mtimeMs)}`;

const base = (f: Fact, source: Action["source"]) => ({ from: f.path, source, size: f.size });

const review = (f: Fact, reason: string, confidence: number, source: Action["source"] = "jev"): Action => ({
	...base(f, source),
	op: "review",
	confidence,
	reason,
});

function schoolAction(
	f: Fact,
	m: { course?: string; type: CourseworkType; assignment?: string },
	registry: Registry,
	confidence: number,
	source: Action["source"],
	evidence: string,
): Action {
	const c = loadConfig();
	const dir = m.course
		? schoolDir({ course: m.course, type: m.type, assignment: m.assignment }, registry, isCodeHeavy(f))
		: resolveTemplate("{school}/{typeDir}/{assignment}", { typeDir: c.school.typeDirs[m.type], assignment: m.assignment });
	const name = f.isDir ? f.name : stripDupeMarker(f.name);
	if (dirname(f.path) === dir) return { ...base(f, source), op: "skip", confidence, reason: "already in place" };
	return {
		...base(f, source),
		op: "move",
		to: join(dir, name),
		confidence,
		reason: `school ${m.course ?? "?"} ${m.type}${m.assignment ? ` ${m.assignment}` : ""} (${evidence})`,
		category: "school",
		school: m,
	};
}

const SUPPORT_TYPES = new Set(["starter_code", "dataset", "unknown", "reference", "submission"]);

/** Files of one assignment from one folder stay together, even when some are code and some are PDFs. */
function groupAssignments(actions: Action[], registry: Registry) {
	const groups = new Map<string, Action[]>();
	for (const a of actions) {
		if (a.op !== "move" || !a.school?.course || !a.school.assignment) continue;
		const key = `${dirname(a.from)}|${a.school.course}|${a.school.assignment}`;
		groups.set(key, [...(groups.get(key) ?? []), a]);
	}
	for (const group of groups.values()) {
		if (group.length < 2 || new Set(group.map((a) => dirname(a.to as string))).size === 1) continue;
		const codeHeavy = group.some((a) => loadConfig().school.codeExtensions.includes(extname(a.from).toLowerCase()));
		const type = (group.map((a) => a.school?.type).find((t) => t && !SUPPORT_TYPES.has(t)) ?? "assignment") as CourseworkType;
		const { course, assignment } = group[0].school as { course: string; assignment: string };
		const dir = schoolDir({ course, type, assignment }, registry, codeHeavy);
		for (const a of group) {
			a.to = join(dir, basename(a.to as string));
			a.reason = `${a.reason}, grouped with ${group.length - 1} sibling(s)`;
		}
	}
}

function fromCorrection(f: Fact, corr: Correction, registry: Registry): Action {
	if (corr.destination) {
		return { ...base(f, "learned"), op: "move", to: join(expand(corr.destination), f.name), confidence: 1, reason: "learned destination", category: corr.category };
	}
	if (corr.course || corr.category === "school") {
		return schoolAction(
			f,
			{ course: corr.course, type: (corr.type as CourseworkType) ?? courseworkType(f.name), assignment: corr.assignment ?? assignmentId(f.name) },
			registry,
			1,
			"learned",
			"learned",
		);
	}
	if (corr.category) return categoryAction(f, corr.category, 1, "learned", corr.project);
	return review(f, "learned rule has no destination", 1, "learned");
}

export function categoryAction(f: Fact, cat: string, confidence: number, source: Action["source"], project?: string): Action {
	const c = loadConfig();
	const def = c.categories[cat];
	if (!def || def.enabled === false || !def.destination) return review(f, `category ${cat} has no destination`, confidence, source);
	let tpl = def.destination;
	if (cat === "media" && VIDEO.has(f.ext)) tpl = "{movies}/{yyyy}";
	const dir = resolveTemplate(tpl, { ...yearMonth(f.mtimeMs, f.name), project: project && project !== "none" ? project : undefined });
	if (dirname(f.path) === dir) return { ...base(f, source), op: "skip", confidence, reason: "already in place" };
	const holding = [dest("trash"), dest("unsure"), dest("duplicates")].some((h) => dir.startsWith(h));
	return {
		...base(f, source),
		op: holding ? "hold" : "move",
		to: join(dir, stripDupeMarker(f.name)),
		confidence,
		reason: cat,
		category: cat,
	};
}

export function decideFile(f: Fact, a: FileAnswers): Action {
	const { move, hold } = loadConfig().thresholds;
	const cat = a.category.choice ?? "unknown";
	const conf = a.category.confidence ?? 0;
	if (conf < move) return review(f, `category ${cat} below ${move}`, conf);

	if (cat === "junk" || cat === "temporary") {
		const d = a.disposable.noul ?? 0;
		const dConf = a.disposable.confidence ?? 0;
		if (d >= hold && dConf >= hold && conf >= hold) return categoryAction(f, cat, Math.min(conf, dConf), "jev");
		return review(f, `${cat} but not sure enough to park`, conf);
	}
	const project = (a.project.confidence ?? 0) >= move ? a.project.choice : undefined;
	return categoryAction(f, cat, conf, "jev", project);
}

/** Folder that is itself one assignment or one course: move it whole. */
function folderUnit(f: Fact, registry: Registry): Action | undefined {
	const own = matchCourse(f.name, registry);
	const asg = assignmentId(f.name);
	const parentCourse = matchCourse(basename(f.root), registry);
	if (own && !asg) {
		// A whole course folder: put it where that course lives.
		const dir = dirname(schoolDir({ course: own, type: "unknown" }, registry, isCodeHeavy(f)));
		if (dirname(f.path) === dir) return undefined;
		return { ...base(f, "rule"), op: "move", to: join(dir, f.name), confidence: 1, reason: `course folder ${own}`, category: "school" };
	}
	if (asg && (own || parentCourse)) {
		const course = own ?? parentCourse;
		const type = courseworkType(f.name);
		const dir = dirname(schoolDir({ course: course as string, type: type === "unknown" ? "assignment" : type, assignment: asg }, registry, isCodeHeavy(f)));
		if (dirname(f.path) === dir) return undefined;
		return { ...base(f, "rule"), op: "move", to: join(dir, f.name), confidence: 1, reason: `assignment folder ${course} ${asg}`, category: "school" };
	}
	return undefined;
}

export async function buildPlan(roots: string[], projects: string[], concurrency = 8, force: string[] = []) {
	const c = loadConfig();
	const facts = scan(roots);
	const { actions, rest } = await applyRules(facts, new Set(force));
	const registry = loadClasses();
	const learned = loadLearned();
	const cache = loadCache();
	const questions = fileQuestions(projects);
	const sQuestions = schoolQuestions(registry);
	const hasCourses = Object.keys(registry).length > 0;

	const judged = await mapPool(rest, concurrency, async (f): Promise<Action> => {
		const corr = lookup(f.path, learned);
		if (corr) return fromCorrection(f, corr, registry);

		if (f.isDir) {
			const unit = folderUnit(f, registry);
			if (unit) return unit;
			if (f.hasGit) return { ...base(f, "rule"), op: "skip", confidence: 1, reason: "git repo (see `tidy repos`)" };
			// Folders in an inbox never stay: exports get archived, everything else is parked for review.
			if (c.inbox.roots.map(expand).includes(f.root)) {
				if (/takeout|export|backup/i.test(f.name)) {
					return { ...base(f, "rule"), op: "move", to: join(dest("exports"), f.name), confidence: 1, reason: "exported data folder", category: "export_archive" };
				}
				return { ...base(f, "rule"), op: "hold", to: join(dest("unsure"), basename(f.root), f.name), confidence: 1, reason: "folder left in inbox" };
			}
			return { ...base(f, "rule"), op: "skip", confidence: 1, reason: "folder (see `tidy repos`, or `tidy resolve <folder> --dest <dir>`)" };
		}

		const inferred = inferCourse(f, registry);
		if (inferred) {
			return schoolAction(f, { course: inferred.course, type: courseworkType(f.name), assignment: assignmentId(f.name) }, registry, 1, "rule", inferred.evidence);
		}

		let answers = cache.get(cacheKey(f, "file")) as FileAnswers | undefined;
		if (!answers) {
			try {
				answers = (await decide(fileState(f), questions)) as FileAnswers;
			} catch (err) {
				return review(f, `jev error: ${(err as Error).message.slice(0, 80)}`, 0);
			}
			remember(cache, cacheKey(f, "file"), answers);
		}
		const a = decideFile(f, answers);
		if (a.category !== "school" || a.op !== "move") return a;

		// Coursework: pin it to a course. Deterministic type first, Jev for the course.
		const type = courseworkType(f.name);
		if (!hasCourses) return schoolAction(f, { type, assignment: assignmentId(f.name) }, registry, a.confidence, "jev", "no courses registered");
		let s = cache.get(cacheKey(f, "school")) as SchoolAnswers | undefined;
		if (!s) {
			try {
				s = (await decide(schoolState(f, registry), sQuestions)) as SchoolAnswers;
			} catch (err) {
				return review(f, `jev error: ${(err as Error).message.slice(0, 80)}`, 0);
			}
			remember(cache, cacheKey(f, "school"), s);
		}
		const course = s.course.choice;
		const cConf = s.course.confidence ?? 0;
		if (!course || course === "none" || cConf < c.thresholds.move) return review(f, `school, course ${course ?? "?"} below ${c.thresholds.move}`, cConf);
		const t = type !== "unknown" ? type : ((s.type.confidence ?? 0) >= c.thresholds.move ? (s.type.choice as CourseworkType) : "unknown");
		return schoolAction(f, { course, type: t, assignment: assignmentId(f.name) }, registry, Math.min(a.confidence, cConf), "jev", "jev");
	});

	const all = [...actions, ...judged];
	groupAssignments(all, registry);

	// Park low-confidence inbox files in Unsure so the inbox empties and review happens in one place.
	if (c.parkUnsureFromInbox) {
		const inbox = c.inbox.roots.map(expand);
		for (const a of all) {
			if (a.op !== "review" || !inbox.includes(dirname(a.from)) || a.reason.startsWith("jev error")) continue;
			a.op = "hold";
			a.to = join(dest("unsure"), basename(dirname(a.from)), basename(a.from));
		}
	}
	return { facts, actions: all };
}
