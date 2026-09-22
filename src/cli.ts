import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { act } from "./act.ts";
import { agentStatus, installAgent, uninstallAgent } from "./agent.ts";
import { addCourse, canonicalCode, loadClasses, saveClasses } from "./classes.ts";
import { applyReclaim, printReclaim, scanReclaim } from "./clean.ts";
import { CLASSES_FILE, CONFIG_FILE, LEARNED_FILE, configExists, dest, loadConfig } from "./config.ts";
import { runInit } from "./init.ts";
import { loadEnv } from "./jev.ts";
import { learn } from "./learned.ts";
import { removeLinks, tidyLinks } from "./links.ts";
import { buildPlan } from "./plan.ts";
import { printHolding, printPlan, weeklyReport, writeReview } from "./report.ts";
import { moveRepo, planRepos } from "./repos.ts";
import { scanRoot } from "./scan.ts";
import { undo } from "./undo.ts";
import { HOME, expand, flag, opt, opts, positional, rel } from "./util.ts";

const USAGE = `tidy <command> [options]

  init [--dry-run] [--force]    inspect this Mac and write ~/.config/tidy/config.json + classes.json (moves nothing)
  plan [--root <dir>]...        show what would happen (never moves anything); --all shows skips too
  apply [--root <dir>]...       plan, then move files at or above the threshold; journal everything
  watch-tick                    apply on the configured roots; Sundays also write the weekly report
  repos [--apply]               list project folders and where they would go
        --only <path> --bucket <name> --allow-dirty --no-symlink
  clean [--apply]               list reclaimable storage; --apply parks the safe tier in Tidy/Trash/Reclaim
  holding [--open]              sizes of Tidy/Trash, Tidy/Duplicates, Tidy/Unsure; --open shows them in Finder
  links [--remove]              symlinks tidy left at old repo paths (they look like folders in Finder)
  resolve <path> [--course CODE] [--type T] [--assignment HW3] [--category C] [--project P] [--dest DIR]
                                move one reviewed item and learn the rule (--learn-prefix, --learn-folder)
  class list | add | edit | remove | alias
        add  --code CS1555 --name "Database Management" --institution "University of X" [--alias ...]
  undo [--last N | --since ISO | --all]
  report                        write ~/Tidy/reports/<week>.md
  ui [--port 4848] [--no-open] local web app: plan + apply, activity + undo, rules, classes, structure, clean
  agent install | uninstall | status
  config                        print the config path and effective config
`;

const abs = (p: string) => resolve(expand(p));

function projectNames() {
	const names = new Set<string>();
	const code = dest("code");
	if (!existsSync(code)) return [];
	for (const bucket of readdirSync(code)) {
		const p = join(code, bucket);
		try {
			for (const sub of readdirSync(p)) if (existsSync(join(p, sub, ".git"))) names.add(sub);
		} catch {}
	}
	for (const r of loadConfig().roots.map(expand)) for (const f of scanRoot(r)) if (f.isDir && f.hasGit) names.add(f.name);
	return [...names].sort();
}

function requireConfig() {
	if (!configExists()) {
		console.log(`No config at ${rel(CONFIG_FILE)}. Run \`tidy init\` first (it moves nothing).`);
		process.exit(1);
	}
}

async function main() {
	loadEnv();
	const cmd = process.argv[2];
	const roots = opts("root").map(abs);
	const concurrency = Number(opt("concurrency") ?? 8);
	const c = loadConfig();

	switch (cmd) {
		case "init":
			runInit({ write: !flag("dry-run"), force: flag("force") });
			break;

		case "plan":
		case "apply":
		case "watch-tick": {
			requireConfig();
			const dry = cmd === "plan" || flag("dry-run");
			const defaults = [...c.roots.map(expand), ...(c.homeLooseFiles ? [HOME] : [])];
			const { actions } = await buildPlan(roots.length ? roots : defaults, projectNames(), concurrency);
			if (cmd !== "watch-tick") printPlan(actions, flag("all"));
			const queued = writeReview(actions);
			if (!dry) {
				const { done } = act(actions);
				console.log(`${new Date().toISOString()} applied ${done}, ${queued} in review`);
			}
			if (cmd === "watch-tick" && new Date().getDay() === 0) console.log(`report: ${rel(weeklyReport(actions))}`);
			break;
		}

		case "repos": {
			requireConfig();
			const only = opts("only").map(abs);
			const moves = await planRepos(only, opt("bucket"));
			for (const m of moves) {
				console.log(`${m.op.padEnd(6)} ${m.confidence.toFixed(2)} ${rel(m.from)}${m.to ? ` -> ${rel(m.to)}` : ""}  [${m.reason}]`);
			}
			if (flag("apply")) {
				let n = 0;
				for (const m of moves) if (moveRepo(m, { allowDirty: flag("allow-dirty"), symlink: flag("no-symlink") ? false : undefined })) n++;
				console.log(`moved ${n} project folders`);
			}
			break;
		}

		case "clean": {
			requireConfig();
			const items = scanReclaim();
			printReclaim(items);
			if (flag("apply")) console.log(`parked ${applyReclaim(items)} folders in ${rel(join(dest("trash"), "Reclaim"))}`);
			break;
		}

		case "links": {
			const links = tidyLinks();
			for (const l of links) console.log(`${rel(l.from)} -> ${rel(l.to)}`);
			if (!links.length) console.log("no compatibility symlinks left by tidy");
			if (flag("remove")) console.log(`removed ${removeLinks()}`);
			break;
		}

		case "holding":
			printHolding();
			if (flag("open")) for (const k of ["trash", "duplicates", "unsure"]) if (existsSync(dest(k))) execFileSync("/usr/bin/open", [dest(k)]);
			break;

		case "resolve": {
			requireConfig();
			const target = positional(1);
			if (!target) throw new Error("resolve needs a path");
			const path = abs(target);
			if (!existsSync(path)) throw new Error(`not found: ${path}`);
			const course = opt("course") ? canonicalCode(opt("course") as string) : undefined;
			const correction = {
				course,
				type: opt("type"),
				assignment: opt("assignment"),
				category: opt("category") ?? (course ? "school" : undefined),
				project: opt("project"),
				destination: opt("dest") ? abs(opt("dest") as string) : undefined,
			};
			if (course) {
				const r = loadClasses();
				if (!r[course]) {
					addCourse(r, course, { source: "learned" });
					saveClasses(r);
					console.log(`registered course ${course} (add a name with \`tidy class edit ${course} --name ...\`)`);
				}
			}
			learn(path, correction, { prefix: flag("learn-prefix"), folder: flag("learn-folder") });
			const { actions } = await buildPlan([resolve(path, "..")], projectNames(), concurrency, [path]);
			const mine = actions.filter((a) => a.from === path);
			printPlan(mine, true);
			if (!flag("dry-run")) act(mine);
			console.log(`learned rule saved to ${rel(LEARNED_FILE)}`);
			break;
		}

		case "class": {
			const sub = positional(1);
			const r = loadClasses();
			if (sub === "list" || !sub) {
				for (const [code, x] of Object.entries(r)) {
					console.log(`${code.padEnd(10)} ${(x.name ?? "").padEnd(36)} ${x.institution ?? ""}  aliases: ${x.aliases.join(", ")}`);
				}
				if (!Object.keys(r).length) console.log(`no courses yet (${rel(CLASSES_FILE)})`);
			} else if (sub === "add" || sub === "edit") {
				const code = opt("code") ?? positional(2);
				if (!code) throw new Error("--code required");
				const key = addCourse(r, code, { name: opt("name"), institution: opt("institution"), aliases: opts("alias"), source: "user" });
				saveClasses(r);
				console.log(`${sub === "add" ? "added" : "updated"} ${key}: ${JSON.stringify(r[key])}`);
			} else if (sub === "alias") {
				const key = canonicalCode(positional(2) ?? "");
				if (!r[key]) throw new Error(`unknown course ${key}`);
				r[key].aliases = [...new Set([...r[key].aliases, ...opts("alias"), ...process.argv.slice(5).filter((a) => !a.startsWith("--"))])];
				saveClasses(r);
				console.log(`${key} aliases: ${r[key].aliases.join(", ")}`);
			} else if (sub === "remove") {
				const key = canonicalCode(positional(2) ?? "");
				delete r[key];
				saveClasses(r);
				console.log(`removed ${key}`);
			} else {
				console.log(USAGE);
			}
			break;
		}

		case "undo":
			console.log(`restored ${undo({ last: opt("last") ? Number(opt("last")) : undefined, since: opt("since"), all: flag("all") })}`);
			break;

		case "report": {
			requireConfig();
			const { actions } = await buildPlan(roots.length ? roots : c.roots.map(expand), projectNames(), concurrency);
			console.log(rel(weeklyReport(actions)));
			break;
		}

		case "agent": {
			const sub = positional(1);
			if (sub === "install") installAgent();
			else if (sub === "uninstall") uninstallAgent();
			else agentStatus();
			break;
		}

		case "ui": {
			requireConfig();
			const { startUi } = await import("./ui/server.ts");
			startUi(Number(opt("port") ?? 4848), !flag("no-open"));
			return;
		}

		case "config":
			console.log(rel(CONFIG_FILE));
			console.log(JSON.stringify(c, null, 2));
			break;

		default:
			console.log(USAGE);
			process.exit(cmd ? 1 : 0);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
