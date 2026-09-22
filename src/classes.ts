import { CLASSES_FILE } from "./config.ts";
import { readJson, writeJson } from "./util.ts";

export type Course = {
	institution?: string;
	name?: string;
	aliases: string[];
	/** Where evidence came from: "init", "user", "learned". */
	source?: string;
};

export type Registry = Record<string, Course>;

export function loadClasses(): Registry {
	return readJson<Registry>(CLASSES_FILE, {});
}

export function saveClasses(r: Registry) {
	writeJson(CLASSES_FILE, r);
}

// Prefixes that look like course codes but are camera/file conventions.
const NOT_COURSES = new Set([
	"img", "dsc", "dscn", "mov", "mvi", "pxl", "vid", "gopr", "scr", "image", "photo", "file", "doc", "page", "part",
	"ver", "rev", "gpt", "utm", "arm", "x", "iso", "win", "mac", "ios", "sha", "md", "utf", "rgb", "png", "jpg", "pdf",
	"mp", "id", "no", "nr", "ref", "inv", "po", "so", "tx", "rx", "ch", "ep", "pt", "v", "p", "s", "e", "hw", "lab", "wk",
	"week", "day", "fall", "spring", "summer", "winter", "sem", "ex", "q", "qs", "quiz", "exam", "test", "unit", "fig", "tab", "eq", "sec", "vol",
]);

/** Normalize any spelling of a course code: "CS 1555", "cs-1555", "15-213", "6.006" */
export function canonicalCode(raw: string) {
	const t = raw.trim();
	const dept = t.match(/^([A-Za-z]{2,5})[\s_-]?(\d{2,4}[A-Za-z]?)$/);
	if (dept) return `${dept[1].toUpperCase()}${dept[2].toUpperCase()}`;
	const num = t.match(/^(\d{1,2})[.-](\d{3}[A-Za-z]?)$/);
	if (num) return `${num[1]}${t.includes(".") ? "." : "-"}${num[2].toUpperCase()}`;
	return t.toUpperCase().replace(/\s+/g, "");
}

/** Every course-code-shaped token in a name. Not all are courses; the registry decides. */
export function codeCandidates(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(/(?<![A-Za-z0-9])([A-Za-z]{2,5})[\s_-]?(\d{3,4}[A-Za-z]?)(?![A-Za-z0-9])/g)) {
		if (NOT_COURSES.has(m[1].toLowerCase())) continue;
		out.add(canonicalCode(`${m[1]}${m[2]}`));
	}
	for (const m of text.matchAll(/(?<![\d.-])(\d{1,2})[.-](\d{3})(?![\d.]|-\d)/g)) {
		// 6.006 / 15-213 shapes; skip plain dates like 09-213 is impossible, but 12-345 style zips are not.
		if (m[1].startsWith("0")) continue;
		out.add(canonicalCode(`${m[1]}${text[m.index! + m[1].length]}${m[2]}`));
	}
	return [...out];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function aliasRegex(alias: string) {
	// Letters and digits may be separated by space, _ or - in the wild.
	const parts = alias.split(/(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])|[\s_.-]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`(?<![a-z0-9])${parts.join("[\\s_.-]?")}(?![a-z0-9])`, "i");
}

/** Which registered course does this text name? Longest alias wins. */
export function matchCourse(text: string, registry: Registry): string | undefined {
	let best: { code: string; len: number } | undefined;
	for (const [code, c] of Object.entries(registry)) {
		for (const alias of [code, ...c.aliases]) {
			if (norm(alias).length < 3) continue;
			if (aliasRegex(alias).test(text) && (!best || norm(alias).length > best.len)) {
				best = { code, len: norm(alias).length };
			}
		}
	}
	return best?.code;
}

export function addCourse(
	r: Registry,
	code: string,
	fields: { name?: string; institution?: string; aliases?: string[]; source?: string },
) {
	const key = canonicalCode(code);
	const prev = r[key] ?? { aliases: [] };
	const aliases = new Set([...prev.aliases, ...(fields.aliases ?? [])]);
	// Common spellings of the code itself.
	const dept = key.match(/^([A-Z]+)(\d+[A-Z]?)$/);
	if (dept) {
		aliases.add(`${dept[1]} ${dept[2]}`);
		aliases.add(`${dept[1]}-${dept[2]}`);
		aliases.add(`${dept[1]}_${dept[2]}`);
	}
	if (fields.name) aliases.add(fields.name);
	aliases.delete(key);
	r[key] = {
		institution: fields.institution ?? prev.institution,
		name: fields.name ?? prev.name,
		aliases: [...aliases],
		source: fields.source ?? prev.source ?? "user",
	};
	return key;
}
