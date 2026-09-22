import type { Registry } from "./classes.ts";
import { categories } from "./config.ts";
import { choice, noul } from "./jev.ts";
import type { Fact } from "./scan.ts";
import { COURSEWORK_TYPES } from "./school.ts";

// Names + metadata only. File contents never leave the machine.
export function fileState(f: Fact) {
	return {
		filename: f.name,
		extension: f.ext,
		size: f.sizeBucket,
		daysSinceModified: f.ageDays,
		folder: f.parent,
		otherFilesInFolder: f.siblings,
	};
}

export function categoryCriteria() {
	const out: Record<string, string> = {};
	for (const [k, d] of categories()) if (d.jev !== false) out[k] = d.description;
	return out;
}

export function fileQuestions(projects: string[]) {
	const projectCriteria: Record<string, string> = { none: "The file does not clearly belong to any listed project." };
	for (const p of projects) projectCriteria[p] = `The file clearly belongs to the project named "${p}".`;
	return {
		category: choice("Classify this file from its filename and metadata into exactly one category.", categoryCriteria()),
		project: choice("Which software project does this file belong to, judging by its filename?", projectCriteria),
		disposable: noul("This file can be discarded with no loss because it is re-downloadable, regenerable, or throwaway."),
	};
}

export function schoolState(f: Fact, registry: Registry) {
	return {
		filename: f.name,
		extension: f.ext,
		folder: f.parent,
		otherFilesInFolder: f.siblings,
		daysSinceModified: f.ageDays,
		knownCourses: Object.fromEntries(
			Object.entries(registry).map(([code, c]) => [code, [c.name, ...c.aliases].filter(Boolean).slice(0, 6)]),
		),
	};
}

export function schoolQuestions(registry: Registry) {
	const courseCriteria: Record<string, string> = { none: "The file does not belong to any of the known courses." };
	for (const [code, c] of Object.entries(registry)) {
		courseCriteria[code] = `Belongs to course ${code}${c.name ? ` (${c.name})` : ""}${c.institution ? ` at ${c.institution}` : ""}.`;
	}
	const typeCriteria: Record<string, string> = {};
	for (const t of COURSEWORK_TYPES) typeCriteria[t] = `This coursework file is a ${t.replace("_", " ")}.`;
	return {
		course: choice("Which known course does this coursework file belong to, judging by its name and neighbours?", courseCriteria),
		type: choice("What kind of coursework is this file?", typeCriteria),
	};
}

export function folderState(f: Fact) {
	return {
		folderName: f.name,
		location: f.parent,
		itemCount: f.childCount,
		fileTypesInside: f.childExt,
		isGitRepo: f.hasGit,
		daysSinceLastCommit: f.lastCommitDays,
	};
}

export function folderQuestions(buckets: string[]) {
	const bucketCriteria: Record<string, string> = {};
	const known: Record<string, string> = {
		personal: "A personal product, startup, or side project.",
		school: "A class project, homework, or course repository.",
		work: "Work for an employer or client.",
		research: "Academic or scientific research code.",
		experiments: "A small experiment, bot, script, or prototype.",
		archive: "Finished or abandoned work kept for the record.",
	};
	for (const b of buckets) bucketCriteria[b] = known[b] ?? `Belongs in the "${b}" group.`;
	return {
		kind: choice("What kind of folder is this?", {
			code_project: "A software project or code repository.",
			course_folder: "A folder of school class work or a class programming assignment.",
			export_dump: "An extracted archive, export, or bulk download.",
			scratch: "A scratch, temporary, or placeholder folder.",
			documents: "A folder of documents or media that is not code.",
		}),
		bucket: choice("Which group does this code folder belong in?", bucketCriteria),
	};
}
