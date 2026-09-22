import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, expand, readJson, writeJson } from "./util.ts";

export const CONFIG_DIR = process.env.TIDY_CONFIG_DIR || join(HOME, ".config", "tidy");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const CLASSES_FILE = join(CONFIG_DIR, "classes.json");
export const LEARNED_FILE = join(CONFIG_DIR, "learned.json");
export const ENV_FILE = join(CONFIG_DIR, "env");

export type CategoryDef = {
	description: string;
	/** Template using {destinationKey}, {yyyy}, {mm}, {project}. null = never moved (review). */
	destination: string | null;
	/** Offered to Jev as a choice. Rule-only categories (screenshots) set this false. */
	jev?: boolean;
	enabled?: boolean;
};

export type Config = {
	roots: string[];
	/** Sort loose files sitting directly in ~. Folders in ~ are never touched. */
	homeLooseFiles: boolean;
	/** Roots treated as an inbox: files younger than graceDays are left alone. */
	inbox: { roots: string[]; graceDays: number };
	stateDir: string;
	destinations: Record<string, string>;
	thresholds: { move: number; hold: number };
	parkUnsureFromInbox: boolean;
	/** Folder names never entered or moved, wherever they appear. */
	protected: string[];
	categories: Record<string, CategoryDef>;
	code: {
		buckets: string[];
		/** Folder name -> bucket. Repos found inside such a folder inherit the bucket. */
		containers: Record<string, string>;
		dormantDays: number;
		compatSymlink: boolean;
	};
	school: {
		/** Where documents for a course go. Vars: {institution}, {course}, {typeDir}, {assignment}. */
		docsTemplate: string;
		/** Where code-heavy coursework and school repos go. */
		codeTemplate: string;
		typeDirs: Record<string, string>;
		codeExtensions: string[];
	};
	clean: {
		regenerable: string[];
		caches: string[];
		minSizeMB: number;
		dormantDays: number;
	};
};

export const DEFAULT_CONFIG: Config = {
	roots: ["~/Desktop", "~/Downloads", "~/Documents", "~/Pictures", "~/Movies"],
	homeLooseFiles: true,
	inbox: { roots: ["~/Downloads"], graceDays: 0 },
	stateDir: "~/Tidy",
	destinations: {
		code: "~/Code",
		documents: "~/Documents",
		archive: "~/Archive",
		school: "~/Documents/School",
		career: "~/Documents/Career",
		finance: "~/Documents/Finance-Legal",
		personal: "~/Documents/Personal",
		reference: "~/Documents/Reference",
		screenshots: "~/Pictures/Screenshots",
		recordings: "~/Movies/Recordings",
		pictures: "~/Pictures/Personal",
		movies: "~/Movies/Personal",
		installers: "~/Archive/Installers",
		exports: "~/Archive/Exports",
		datasets: "~/Archive/Datasets",
		// Holding areas. Tidy never deletes; you review these and empty them yourself.
		trash: "~/Tidy/Trash",
		duplicates: "~/Tidy/Duplicates",
		unsure: "~/Tidy/Unsure",
	},
	thresholds: { move: 0.8, hold: 0.9 },
	/** Low-confidence files in inbox roots are parked in {unsure}/<origin>; elsewhere they stay put. */
	parkUnsureFromInbox: true,
	protected: [
		"Library", "Applications", "Public", "Music", "Zoom", "CapCut", "TV", "Photos Library.photoslibrary",
		"Photo Booth Library", "Unreal Projects", "iCloud Drive", "Tidy", "Code", "Archive",
	],
	categories: {
		career_resume: { description: "A resume or CV, in any version or format.", destination: "{career}/Resumes" },
		career_cover_letter: { description: "A cover letter for a job application.", destination: "{career}/Cover Letters" },
		career_offer: {
			description: "A job or internship offer letter, employment contract, onboarding or HR paperwork.",
			destination: "{career}/Offers",
		},
		career_application: {
			description: "A job application export, application confirmation, or interview schedule.",
			destination: "{career}/Applications",
		},
		school: {
			description: "University or school coursework: assignments, lecture slides, syllabi, transcripts, lab files, class datasets or notebooks.",
			destination: "{school}",
		},
		finance_legal: {
			description: "Financial, tax, banking, lease, rental, insurance, government or legal paperwork.",
			destination: "{finance}",
		},
		personal: {
			description: "Personal non-financial paperwork: travel, tickets, medical forms, memberships, IDs.",
			destination: "{personal}",
		},
		reference: {
			description: "A document kept for reference: manual, article, ebook, spec, guide that is not coursework.",
			destination: "{reference}",
		},
		project_asset: {
			description: "A working file for a software or side project: logo, demo video, design export, SQL dump, plan or spec.",
			destination: "{reference}/{project}",
		},
		dataset: { description: "A standalone data file (csv, json, sql, parquet) that is not coursework.", destination: "{datasets}" },
		screenshot: { description: "A screenshot.", destination: "{screenshots}/{yyyy}-{mm}", jev: false },
		screen_recording: { description: "A screen recording.", destination: "{recordings}/{yyyy}-{mm}", jev: false },
		media: { description: "Personal photos, camera videos or downloaded media unrelated to any project.", destination: "{pictures}/{yyyy}" },
		installer: { description: "An app installer, disk image, package, or OS/VM image.", destination: "{installers}" },
		export_archive: {
			description: "A bulk export or backup from a service: mail archive, Takeout, account data export.",
			destination: "{exports}",
		},
		temporary: { description: "A temporary or scratch file that was clearly not meant to be kept.", destination: "{trash}/Temporary" },
		junk: { description: "A generic or throwaway file with no lasting value.", destination: "{trash}/Junk" },
		unknown: { description: "Cannot tell from the name.", destination: null },
	},
	code: {
		buckets: ["personal", "school", "work", "research", "experiments", "archive"],
		containers: {},
		dormantDays: 180,
		// Symlinks at old paths look like folders in Finder and hide the cleanup; off unless you need them.
		compatSymlink: false,
	},
	school: {
		docsTemplate: "{school}/{institution}/{course}/{typeDir}/{assignment}",
		codeTemplate: "{code}/school/{course}",
		typeDirs: {
			syllabus: "Syllabus",
			lecture: "Lectures",
			homework: "Homework",
			assignment: "Homework",
			lab: "Labs",
			recitation: "Recitations",
			project: "Projects",
			exam: "Exams",
			quiz: "Exams",
			notes: "Notes",
			study_guide: "Notes",
			textbook: "Reference",
			reference: "Reference",
			dataset: "Data",
			starter_code: "Code",
			submission: "Submissions",
			unknown: "",
		},
		codeExtensions: [
			".py", ".java", ".c", ".cpp", ".h", ".js", ".ts", ".sql", ".ipynb", ".rs", ".go", ".rb", ".m", ".r", ".jl", ".kt", ".swift", ".scala", ".hs", ".ml", ".asm", ".s", ".v", ".sv",
		],
	},
	clean: {
		regenerable: ["node_modules", ".next", "dist", "build", "target", ".turbo", ".parcel-cache", ".cache", "venv", ".venv", "__pycache__", ".gradle", "DerivedData"],
		caches: ["~/Library/Caches", "~/.cache", "~/.npm/_cacache", "~/.ollama/models", "~/.cache/huggingface", "~/Library/Developer/Xcode/DerivedData"],
		minSizeMB: 50,
		dormantDays: 90,
	},
};

let cached: Config | undefined;

function merge<T>(base: T, over: Partial<T> | undefined): T {
	if (!over || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over)) {
		const b = (base as Record<string, unknown>)[k];
		out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? merge(b, v) : v;
	}
	return out as T;
}

export function loadConfig(): Config {
	if (cached) return cached;
	cached = merge(DEFAULT_CONFIG, readJson<Partial<Config>>(CONFIG_FILE, {}));
	return cached;
}

export function saveConfig(c: Config) {
	writeJson(CONFIG_FILE, c);
	cached = c;
}

export function configExists() {
	return existsSync(CONFIG_FILE);
}

export function dest(key: string) {
	const c = loadConfig();
	const d = c.destinations[key];
	if (!d) throw new Error(`No destination "${key}" in ${CONFIG_FILE}`);
	return expand(d);
}

export function stateDir() {
	return expand(loadConfig().stateDir);
}

/** "{screenshots}/{yyyy}-{mm}" -> "/Users/x/Pictures/Screenshots/2026-09". Empty vars collapse. */
export function resolveTemplate(tpl: string, vars: Record<string, string | undefined> = {}) {
	const c = loadConfig();
	const out = tpl.replace(/\{(\w+)\}/g, (_, k: string) => {
		if (vars[k] !== undefined) return vars[k] ?? "";
		if (c.destinations[k]) return expand(c.destinations[k]);
		return "";
	});
	return out.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

/** Destination folders and every template prefix, expanded. Scans must never treat these as clutter. */
export function destinationPaths() {
	const c = loadConfig();
	const out = new Set<string>();
	for (const d of Object.values(c.destinations)) out.add(expand(d));
	for (const cat of Object.values(c.categories)) {
		if (!cat.destination) continue;
		const fixed = cat.destination.split(/\{(?!\w+\}$)/)[0];
		const p = resolveTemplate(fixed.replace(/\/\{\w+\}.*$/, ""));
		if (p) out.add(p);
	}
	out.add(resolveTemplate(c.school.docsTemplate.split("/{")[0]));
	out.add(resolveTemplate(c.school.codeTemplate.split("/{")[0]));
	return out;
}

export function isDestination(path: string) {
	for (const d of destinationPaths()) if (path === d || d.startsWith(`${path}/`)) return true;
	return false;
}

export function categories() {
	return Object.entries(loadConfig().categories).filter(([, d]) => d.enabled !== false);
}
