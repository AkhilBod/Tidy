import { basename, extname } from "node:path";
import { type Registry, matchCourse } from "./classes.ts";
import { loadConfig, resolveTemplate } from "./config.ts";
import type { Fact } from "./scan.ts";

export const COURSEWORK_TYPES = [
	"syllabus", "lecture", "homework", "assignment", "lab", "recitation", "project", "exam", "quiz", "notes",
	"study_guide", "textbook", "reference", "dataset", "starter_code", "submission", "unknown",
] as const;
export type CourseworkType = (typeof COURSEWORK_TYPES)[number];

const TYPE_RULES: [CourseworkType, RegExp][] = [
	["syllabus", /syllabus/i],
	["study_guide", /study[\s_-]?guide|cheat[\s_-]?sheet|review[\s_-]?(sheet|packet)/i],
	["exam", /(?<![a-z])(midterm|final[\s_-]?exam|exam|mid[\s_-]?term)(?![\s_-]?(draft|version|submission))/i],
	["quiz", /(?<![a-z])quiz(zes)?[\s_-]?\d*/i],
	["submission", /submission|submitted|turnin|turn[\s_-]?in/i],
	["starter_code", /starter|skeleton|scaffold|template[\s_-]?code/i],
	["recitation", /(?<![a-z])(recitation|rec)[\s_-]?\d+/i],
	["lab", /(?<![a-z])lab[\s_-]?\d+|(?<![a-z])labs?(?![a-z])/i],
	["homework", /(?<![a-z])(hw|homework)[\s_-]?\d*/i],
	["assignment", /(?<![a-z])(assignment|assign|a)[\s_-]?\d+(?![a-z0-9])|(?<![a-z])assignment/i],
	["project", /(?<![a-z])(project|proj)[\s_-]?\d*/i],
	["lecture", /(?<![a-z])(lecture|lec|slides?|week[\s_-]?\d+|module[\s_-]?\d+|chapter[\s_-]?\d+|ch[\s_-]?\d+)(?![a-z])/i],
	["notes", /(?<![a-z])notes?(?![a-z])/i],
	["textbook", /textbook|(?<![a-z])book(?![a-z])|edition/i],
];

const DATA_EXT = new Set([".csv", ".tsv", ".parquet", ".xlsx", ".json", ".arff"]);

export function courseworkType(name: string): CourseworkType {
	for (const [t, re] of TYPE_RULES) if (re.test(name)) return t;
	if (DATA_EXT.has(extname(name).toLowerCase())) return "dataset";
	return "unknown";
}

/** "cs1555_hw3_part2.pdf" -> "HW3"; "Lab 4 report" -> "Lab4"; "midterm_notes" -> "Midterm" */
export function assignmentId(name: string): string | undefined {
	const m = name.match(/(?<![a-z])(hw|homework|assignment|assign|lab|project|proj|recitation|rec|quiz|exam|ps|pset|problem[\s_-]?set)[\s_-]?(\d+)(?![a-z0-9])/i);
	if (m) {
		const k = m[1].toLowerCase().replace(/[\s_-]/g, "");
		const label =
			k.startsWith("h") ? "HW" :
			k.startsWith("a") ? "Assignment" :
			k === "lab" ? "Lab" :
			k.startsWith("proj") ? "Project" :
			k.startsWith("rec") ? "Recitation" :
			k === "quiz" ? "Quiz" :
			k === "exam" ? "Exam" : "PS";
		return `${label}${m[2]}`;
	}
	const named = name.match(/(?<![a-z])(midterm|final)(?![a-z])/i);
	if (named) return named[1][0].toUpperCase() + named[1].slice(1).toLowerCase();
	return undefined;
}

export type SchoolMatch = {
	course: string;
	type: CourseworkType;
	assignment?: string;
	evidence: "filename" | "folder" | "siblings" | "learned" | "jev";
	confidence: number;
};

/** Deterministic course inference: filename, then parent folder, then what the neighbours agree on. */
export function inferCourse(f: Fact, registry: Registry): { course: string; evidence: SchoolMatch["evidence"] } | undefined {
	if (!Object.keys(registry).length) return undefined;
	const own = matchCourse(f.name, registry);
	if (own) return { course: own, evidence: "filename" };
	const folder = matchCourse(basename(f.root), registry);
	if (folder) return { course: folder, evidence: "folder" };
	// Siblings: at least two neighbours name the same course and none names another.
	const votes = new Map<string, number>();
	for (const s of f.siblings) {
		const c = matchCourse(s, registry);
		if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
	}
	if (votes.size === 1) {
		const [course, n] = [...votes][0];
		if (n >= 2 && (assignmentId(f.name) || courseworkType(f.name) !== "unknown")) return { course, evidence: "siblings" };
	}
	return undefined;
}

export function isCodeHeavy(f: Fact) {
	const exts = loadConfig().school.codeExtensions;
	if (!f.isDir) return exts.includes(f.ext);
	const total = f.childCount ?? 0;
	const code = Object.entries(f.childExt ?? {}).filter(([e]) => exts.includes(e)).reduce((s, [, n]) => s + n, 0);
	return total > 0 && code / total >= 0.4;
}

/** Folder for a piece of coursework. Does not include the filename. */
export function schoolDir(m: { course: string; type: CourseworkType; assignment?: string }, registry: Registry, codeHeavy: boolean) {
	const c = loadConfig();
	const course = registry[m.course];
	const typeDir = c.school.typeDirs[m.type] ?? "";
	if (codeHeavy) {
		return resolveTemplate(`${c.school.codeTemplate}/{typeDir}/{assignment}`, {
			course: m.course,
			institution: course?.institution,
			typeDir: typeDir.toLowerCase(),
			assignment: m.assignment?.toLowerCase(),
		});
	}
	return resolveTemplate(c.school.docsTemplate, {
		course: m.course,
		institution: course?.institution,
		typeDir,
		assignment: m.assignment,
	});
}
