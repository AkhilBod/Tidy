import { createHash } from "node:crypto";
import { createReadStream, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dest, loadConfig, resolveTemplate } from "./config.ts";
import type { Fact } from "./scan.ts";
import { expand, hasDupeMarker, revisionStem, yearMonth } from "./util.ts";

export type Action = {
	/** hold = moved into a holding folder (Trash / Duplicates / Unsure under ~/Tidy). Never deleted. */
	op: "move" | "hold" | "review" | "skip";
	from: string;
	to?: string;
	confidence: number;
	reason: string;
	source: "rule" | "learned" | "jev";
	size: number;
	category?: string;
	school?: { course?: string; type: string; assignment?: string };
};

const SETTLE_MS = 10 * 60e3;
const PARTIAL = new Set([".crdownload", ".download", ".part", ".tmp", ".partial"]);
const INSTALLER = new Set([".dmg", ".pkg"]);

export function sha256(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const h = createHash("sha256");
		createReadStream(path)
			.on("data", (c) => h.update(c))
			.on("end", () => resolve(h.digest("hex")))
			.on("error", reject);
	});
}

const normApp = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

function installedApps(): string[] {
	try {
		return readdirSync("/Applications")
			.filter((a) => a.endsWith(".app"))
			.map((a) => normApp(a.slice(0, -4)))
			.filter((a) => a.length >= 5);
	} catch {
		return [];
	}
}

export const rule = (f: Fact, op: Action["op"], reason: string, to?: string, category?: string): Action => ({
	op,
	from: f.path,
	to,
	confidence: 1,
	reason,
	source: "rule",
	size: f.size,
	category,
});

/** Park in a holding folder: {trash}/<bucket>/<origin>/<name>. */
export const hold = (f: Fact, area: "trash" | "duplicates" | "unsure", bucket: string, reason: string): Action =>
	rule(f, "hold", reason, join(dest(area), bucket, f.name));

function inboxGrace(f: Fact) {
	const c = loadConfig();
	if (!c.inbox.roots.map(expand).includes(f.root)) return false;
	return f.ageDays < c.inbox.graceDays;
}

/** Deterministic pre-pass. Returns actions it is certain of, and the facts left for the classifier. */
export async function applyRules(facts: Fact[], force: Set<string> = new Set()) {
	const c = loadConfig();
	const actions: Action[] = [];
	const rest: Fact[] = [];
	const apps = installedApps();
	const now = Date.now();
	const settling = (f: Fact) => !force.has(f.path) && (now - f.mtimeMs < SETTLE_MS || PARTIAL.has(f.ext));
	const decided = new Set<string>();

	// 1. Exact duplicates: hash only files that share a size with another file in the same scan.
	const bySize = new Map<number, Fact[]>();
	for (const f of facts) {
		if (f.isDir || f.size === 0 || settling(f)) continue;
		bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
	}
	for (const group of bySize.values()) {
		if (group.length < 2) continue;
		const byHash = new Map<string, Fact[]>();
		for (const f of group) {
			const h = await sha256(f.path);
			byHash.set(h, [...(byHash.get(h) ?? []), f]);
		}
		for (const same of byHash.values()) {
			if (same.length < 2) continue;
			const [keep, ...extra] = same.sort(
				(a, b) => Number(hasDupeMarker(a.name)) - Number(hasDupeMarker(b.name)) || a.mtimeMs - b.mtimeMs,
			);
			for (const f of extra) {
				decided.add(f.path);
				actions.push(hold(f, "duplicates", basename(f.root), `exact duplicate of ${keep.path}`));
			}
		}
	}

	// 2. Possible revisions: same stem, different content. Never guess which one matters.
	const byStem = new Map<string, Fact[]>();
	for (const f of facts) {
		if (f.isDir || decided.has(f.path) || settling(f)) continue;
		const key = `${f.root}|${revisionStem(f.name)}|${f.ext}`;
		byStem.set(key, [...(byStem.get(key) ?? []), f]);
	}
	for (const group of byStem.values()) {
		if (group.length < 2) continue;
		for (const f of group) {
			decided.add(f.path);
			actions.push(rule(f, "review", `possible revision of ${group.filter((g) => g !== f).map((g) => g.name).join(", ")}`));
		}
	}

	for (const f of facts) {
		if (decided.has(f.path)) continue;
		if (f.isDir && (f.childCount ?? 0) === 0 && f.parent !== "home") {
			actions.push(hold(f, "trash", "Empty folders", "empty folder"));
		} else if (settling(f)) {
			actions.push(rule(f, "skip", "still settling or partial download"));
		} else if (inboxGrace(f)) {
			actions.push(rule(f, "skip", `inbox grace period (${c.inbox.graceDays}d)`));
		} else if (f.name === "__MACOSX" || f.ext === ".crswap") {
			actions.push(hold(f, "trash", "Debris", "archive/editor debris"));
		} else if (f.ext === ".app") {
			if (apps.some((a) => a === normApp(f.name.slice(0, -4)))) actions.push(hold(f, "trash", "Installed apps", "app already in /Applications"));
			else actions.push(rule(f, "move", "downloaded app", join(dest("installers"), f.name), "installer"));
		} else if (f.isDir) {
			rest.push(f);
		} else if (/^(Screenshot|Screen Shot|Clean ?Shot|Capture) /i.test(f.name)) {
			const tpl = c.categories.screenshot?.destination ?? "{screenshots}/{yyyy}-{mm}";
			actions.push(rule(f, "move", "screenshot", join(resolveTemplate(tpl, yearMonth(f.mtimeMs, f.name)), f.name), "screenshot"));
		} else if (/^(Screen Recording|ScreenRecording|Recording)[ _]/i.test(f.name)) {
			const tpl = c.categories.screen_recording?.destination ?? "{recordings}/{yyyy}-{mm}";
			actions.push(rule(f, "move", "screen recording", join(resolveTemplate(tpl, yearMonth(f.mtimeMs, f.name)), f.name), "screen_recording"));
		} else if (INSTALLER.has(f.ext) && apps.some((a) => normApp(f.name).includes(a))) {
			actions.push(hold(f, "trash", "Installed apps", "installer for an app already in /Applications"));
		} else if (f.ext === ".zip" && readdirSync(dirname(f.path)).includes(basename(f.name, ".zip"))) {
			actions.push(hold(f, "trash", "Extracted zips", "zip already extracted next to it"));
		} else {
			rest.push(f);
		}
	}
	return { actions, rest };
}
