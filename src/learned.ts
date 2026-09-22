import { basename, dirname } from "node:path";
import { LEARNED_FILE } from "./config.ts";
import { readJson, writeJson } from "./util.ts";

/** Explicit rules learned from user corrections. Checked before any heuristic or Jev call. */
export type Learned = {
	/** Leading filename token (before the first separator), lowercased. */
	prefixes: Record<string, Correction>;
	/** Absolute source folder -> correction for anything found directly inside it. */
	folders: Record<string, Correction>;
	/** Exact filename (lowercased) -> correction. */
	names: Record<string, Correction>;
};

export type Correction = {
	category?: string;
	course?: string;
	type?: string;
	assignment?: string;
	project?: string;
	destination?: string;
	learnedAt: string;
};

export function loadLearned(): Learned {
	return readJson<Learned>(LEARNED_FILE, { prefixes: {}, folders: {}, names: {} });
}

export function saveLearned(l: Learned) {
	writeJson(LEARNED_FILE, l);
}

export function prefixOf(name: string) {
	const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
	const m = stem.match(/^([a-z0-9]+)(?:[\s_.-]|$)/);
	return m && m[1].length >= 3 ? m[1] : undefined;
}

export function lookup(path: string, l: Learned): Correction | undefined {
	const name = basename(path).toLowerCase();
	if (l.names[name]) return l.names[name];
	const p = prefixOf(name);
	if (p && l.prefixes[p]) return l.prefixes[p];
	const dir = dirname(path);
	if (l.folders[dir]) return l.folders[dir];
	return undefined;
}

/** Record a correction: exact name always; prefix when it carries a course or category; folder when asked. */
export function learn(path: string, c: Omit<Correction, "learnedAt">, opts: { folder?: boolean; prefix?: boolean }) {
	const l = loadLearned();
	const row = { ...c, learnedAt: new Date().toISOString() };
	l.names[basename(path).toLowerCase()] = row;
	const p = prefixOf(basename(path));
	if (opts.prefix && p) l.prefixes[p] = { ...row, assignment: undefined };
	if (opts.folder) l.folders[dirname(path)] = { ...row, assignment: undefined, type: undefined };
	saveLearned(l);
	return l;
}
