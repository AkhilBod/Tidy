import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

// TIDY_HOME lets tests point the whole tool at a fixture tree.
export const HOME = process.env.TIDY_HOME || homedir();

export function expand(p: string) {
	if (p === "~") return HOME;
	if (p.startsWith("~/")) return join(HOME, p.slice(2));
	return p;
}

export function rel(p: string) {
	return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

const DUPE_MARKER = /(\s+\(\d+\)|\s+copy(\s+\d+)?|[ _-]\d+)+$/i;

export function hasDupeMarker(name: string) {
	return /(\s+\(\d+\)|\s+copy(\s+\d+)?)+$/i.test(basename(name, extname(name)));
}

export function stripDupeMarker(name: string) {
	const ext = extname(name);
	return basename(name, ext).replace(/(\s+\(\d+\)|\s+copy(\s+\d+)?)+$/i, "").trim() + ext;
}

// "HW3-final.pdf", "HW3 (2).pdf", "HW3_v2.pdf" all share the stem "hw3".
export function revisionStem(name: string) {
	return basename(name, extname(name))
		.toLowerCase()
		.replace(DUPE_MARKER, "")
		.replace(/[ _-]?(final|fixed|updated|revised|submission|submitted|draft|new|old|latest|v\d+)$/g, "")
		.replace(/[ _-]?(final|fixed|updated|revised|submission|submitted|draft|new|old|latest|v\d+)$/g, "")
		.trim();
}

export function kebab(name: string) {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Never overwrite: foo.pdf -> foo-2.pdf -> foo-3.pdf
export function uniquePath(target: string) {
	if (!existsSync(target)) return target;
	const ext = extname(target);
	const stem = join(dirname(target), basename(target, ext));
	for (let i = 2; ; i++) {
		const p = `${stem}-${i}${ext}`;
		if (!existsSync(p)) return p;
	}
}

export function readJson<T>(file: string, fallback: T): T {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function writeJson(file: string, data: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function yearMonth(ms: number, name?: string) {
	const m = name?.match(/(\d{4})-(\d{2})-\d{2}/);
	if (m) return { yyyy: m[1], mm: m[2] };
	const d = new Date(ms);
	return { yyyy: String(d.getFullYear()), mm: String(d.getMonth() + 1).padStart(2, "0") };
}

export function flag(name: string) {
	return process.argv.includes(`--${name}`);
}

export function opt(name: string) {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

export function opts(name: string) {
	const out: string[] = [];
	process.argv.forEach((a, i) => {
		if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
	});
	return out;
}

export function positional(n: number) {
	return process.argv.filter((a, i) => i >= 2 && !a.startsWith("--") && !process.argv[i - 1]?.startsWith("--"))[n];
}
