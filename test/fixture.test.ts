import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "tidy-home-"));
process.env.TIDY_HOME = home;
process.env.TIDY_CONFIG_DIR = join(home, ".config", "tidy");

const { act } = await import("../src/act.ts");
const { decideFile } = await import("../src/plan.ts");
const { applyRules } = await import("../src/rules.ts");
const { scan } = await import("../src/scan.ts");
const { undo } = await import("../src/undo.ts");
const { kebab, stripDupeMarker } = await import("../src/util.ts");

const old = new Date(Date.now() - 3 * 86400e3);
function file(p: string, content = "x") {
	mkdirSync(join(home, p, ".."), { recursive: true });
	writeFileSync(join(home, p), content);
	utimesSync(join(home, p), old, old);
}
function dir(p: string) {
	mkdirSync(join(home, p), { recursive: true });
	utimesSync(join(home, p), old, old);
}

file("Downloads/Screenshot 2026-06-13 at 2.14.13 PM.png", "img");
file("Downloads/Screenshot 2026-06-13 at 2.14.13 PM copy.png", "img");
file("Downloads/report.pdf", "aaaa");
file("Downloads/report (1).pdf", "aaaa");
file("Downloads/HW3.pdf", "bbbb");
file("Downloads/HW3-final.pdf", "cccc");
file("Downloads/Firefox 130.dmg", "dmg");
file("Downloads/site.zip", "zip");
file("Downloads/site/index.html");
utimesSync(join(home, "Downloads/site"), old, old);
file("Downloads/still.crdownload", "partial");
file("Downloads/notes.crswap");
dir("Downloads/__MACOSX");
dir("Downloads/untitled folder 2");
mkdirSync(join(home, "Desktop"));
writeFileSync(join(home, "Desktop/fresh.txt"), "new");

const snapshot = () =>
	execFileSync("/usr/bin/find", [home, "-not", "-path", "*/Tidy*", "-not", "-path", "*/.config*"], { encoding: "utf8" })
		.split("\n")
		.sort()
		.join("\n");
const before = snapshot();

test("rules", async () => {
	const facts = scan([join(home, "Downloads"), join(home, "Desktop")]);
	const { actions, rest } = await applyRules(facts);
	const byName = Object.fromEntries(actions.map((a) => [a.from.slice(home.length + 1), a]));

	assert.equal(byName["Desktop/fresh.txt"].op, "skip");
	assert.equal(byName["Downloads/still.crdownload"].op, "skip");
	assert.equal(byName["Downloads/notes.crswap"].op, "hold");
	assert.match(byName["Downloads/notes.crswap"].to ?? "", /Tidy\/Trash\/Debris\//);
	assert.equal(byName["Downloads/__MACOSX"].op, "hold");
	assert.equal(byName["Downloads/untitled folder 2"].op, "hold");
	assert.equal(byName["Downloads/site.zip"].op, "hold");
	assert.match(byName["Downloads/site.zip"].to ?? "", /Tidy\/Trash\/Extracted zips\//);
	assert.match(byName["Downloads/Screenshot 2026-06-13 at 2.14.13 PM.png"].to ?? "", /Pictures\/Screenshots\/2026-06\//);
	assert.equal(byName["Downloads/Screenshot 2026-06-13 at 2.14.13 PM copy.png"].op, "hold");
	assert.match(byName["Downloads/Screenshot 2026-06-13 at 2.14.13 PM copy.png"].to ?? "", /Tidy\/Duplicates\/Downloads\//);
	assert.equal(byName["Downloads/report (1).pdf"].op, "hold");
	assert.match(byName["Downloads/report (1).pdf"].reason, /duplicate of .*\/report\.pdf$/);
	assert.equal(byName["Downloads/Firefox 130.dmg"]?.op, "hold");
	// Different content, same stem: never guess, review both.
	assert.equal(byName["Downloads/HW3.pdf"].op, "review");
	assert.equal(byName["Downloads/HW3-final.pdf"].op, "review");
	assert.deepEqual(rest.map((f) => f.name).sort(), ["report.pdf", "site"]);
});

test("decideFile thresholds", async () => {
	const [f] = scan([join(home, "Downloads")]).filter((x) => x.name === "report.pdf");
	const hi = { choice: "career_resume", confidence: 0.91 };
	const lo = { noul: 0.1, confidence: 0.9 };
	const move = decideFile(f, { category: hi, project: { choice: "none", confidence: 0.9 }, disposable: lo });
	assert.equal(move.op, "move");
	assert.equal(move.to, join(home, "Documents/Career/Resumes/report.pdf"));

	assert.equal(decideFile(f, { category: { choice: "career_resume", confidence: 0.6 }, project: lo, disposable: lo }).op, "review");

	const junk = decideFile(f, { category: { choice: "junk", confidence: 0.95 }, project: lo, disposable: { noul: 0.95, confidence: 0.95 } });
	assert.equal(junk.op, "hold");
	assert.equal(junk.to, join(home, "Tidy/Trash/Junk/report.pdf"));

	assert.equal(decideFile(f, { category: { choice: "junk", confidence: 0.95 }, project: lo, disposable: { noul: 0.85, confidence: 0.95 } }).op, "review");

	const asset = decideFile(f, { category: { choice: "project_asset", confidence: 0.9 }, project: { choice: "myapp", confidence: 0.9 }, disposable: lo });
	assert.equal(asset.to, join(home, "Documents/Reference/myapp/report.pdf"));

	assert.equal(decideFile(f, { category: { choice: "unknown", confidence: 0.95 }, project: lo, disposable: lo }).op, "review");
});

test("apply then undo is a no-op", async () => {
	const facts = scan([join(home, "Downloads"), join(home, "Desktop")]);
	const { actions } = await applyRules(facts);
	// name collision: a second, different file headed for the same holding name
	file("Downloads/x/report (1).pdf", "dddd");
	actions.push({ op: "hold", from: join(home, "Downloads/x/report (1).pdf"), to: join(home, "Tidy/Duplicates/Downloads/report (1).pdf"), confidence: 1, reason: "test", source: "rule", size: 4 });
	const { done } = act(actions);
	assert.equal(done, 9);
	assert.notEqual(snapshot(), before);
	assert.equal(undo({}), 9);
	assert.equal(snapshot().split("\n").filter((l) => !l.includes("/Downloads/x")).join("\n"), before);
	assert.equal(undo({}), 0);
});

test("names", () => {
	assert.equal(stripDupeMarker("logo (1).png"), "logo.png");
	assert.equal(stripDupeMarker("Screenshot copy 2.png"), "Screenshot.png");
	assert.equal(kebab("class projects "), "class-projects");
	assert.equal(kebab("FramedAI"), "framedai");
	assert.equal(kebab("kalshi_bot"), "kalshi-bot");
});
