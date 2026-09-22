import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "../act.ts";
import { agentStatus } from "../agent.ts";
import { type Registry, addCourse, canonicalCode, loadClasses, saveClasses } from "../classes.ts";
import { applyReclaim, scanReclaim } from "../clean.ts";
import { CONFIG_FILE, type Config, DEFAULT_CONFIG, destinationPaths, loadConfig, saveConfig, stateDir } from "../config.ts";
import { type Learned, learn, loadLearned, saveLearned } from "../learned.ts";
import { buildPlan } from "../plan.ts";
import { holdingSummary, writeReview } from "../report.ts";
import { type RepoMove, moveRepo, planRepos } from "../repos.ts";
import type { Action } from "../rules.ts";
import { scanRoot } from "../scan.ts";
import { COURSEWORK_TYPES } from "../school.ts";
import { liveRows, undo } from "../undo.ts";
import { HOME, expand, rel } from "../util.ts";

const HTML = join(dirname(fileURLToPath(import.meta.url)), "index.html");

function projectNames() {
	const names = new Set<string>();
	const code = expand(loadConfig().destinations.code);
	if (existsSync(code)) {
		for (const bucket of readdirSync(code)) {
			try {
				for (const sub of readdirSync(join(code, bucket))) if (existsSync(join(code, bucket, sub, ".git"))) names.add(sub);
			} catch {}
		}
	}
	return [...names].sort();
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (e) {
				reject(e);
			}
		});
	});
}

function diskFree() {
	try {
		const [, size, used, avail, pct] = execFileSync("/bin/df", ["-h", "/"], { encoding: "utf8" }).split("\n")[1].split(/\s+/);
		return { size, used, avail, pct };
	} catch {
		return undefined;
	}
}

/** Two-level tree of every destination folder with item counts, so the layout is visible. */
function structure() {
	const c = loadConfig();
	const out: { key: string; path: string; exists: boolean; items: number; children: { name: string; items: number; isDir: boolean }[] }[] = [];
	for (const [key, p] of Object.entries(c.destinations)) {
		const path = expand(p);
		const row = { key, path, exists: existsSync(path), items: 0, children: [] as { name: string; items: number; isDir: boolean }[] };
		if (row.exists) {
			try {
				const entries = readdirSync(path).filter((e) => !e.startsWith("."));
				row.items = entries.length;
				for (const e of entries.slice(0, 40)) {
					const q = join(path, e);
					let isDir = false;
					let items = 0;
					try {
						isDir = statSync(q).isDirectory();
						if (isDir) items = readdirSync(q).filter((x) => !x.startsWith(".")).length;
					} catch {}
					row.children.push({ name: e, items, isDir });
				}
			} catch {}
		}
		out.push(row);
	}
	return out;
}

function rootsOverview() {
	const c = loadConfig();
	return [...c.roots, ...(c.homeLooseFiles ? ["~"] : [])].map((r) => {
		const p = expand(r);
		const facts = existsSync(p) ? scanRoot(p) : [];
		return { root: r, path: p, files: facts.filter((f) => !f.isDir).length, folders: facts.filter((f) => f.isDir).length, repos: facts.filter((f) => f.hasGit).length };
	});
}

type Handler = (req: IncomingMessage, url: URL) => Promise<unknown> | unknown;

const routes: Record<string, Handler> = {
	"GET /api/state": () => ({
		home: HOME,
		configFile: rel(CONFIG_FILE),
		config: loadConfig(),
		defaults: DEFAULT_CONFIG,
		classes: loadClasses(),
		learned: loadLearned(),
		holding: holdingSummary(),
		disk: diskFree(),
		roots: rootsOverview(),
		courseworkTypes: COURSEWORK_TYPES,
		destinations: [...destinationPaths()].map(rel),
		stateDir: rel(stateDir()),
	}),
	"GET /api/plan": async (_req, url) => {
		const c = loadConfig();
		const roots = url.searchParams.getAll("root").map(expand);
		const defaults = [...c.roots.map(expand), ...(c.homeLooseFiles ? [HOME] : [])];
		const { actions } = await buildPlan(roots.length ? roots : defaults, projectNames());
		writeReview(actions);
		return { actions };
	},
	"POST /api/apply": async (req) => {
		const { actions } = (await body(req)) as { actions: Action[] };
		return act(actions);
	},
	"GET /api/journal": () => {
		const rows = liveRows();
		const batches = new Map<string, typeof rows>();
		for (const r of rows) batches.set(r.batch, [...(batches.get(r.batch) ?? []), r]);
		return { batches: [...batches].map(([batch, rows]) => ({ batch, rows })) };
	},
	"POST /api/undo": async (req) => {
		const b = (await body(req)) as { ids?: string[]; batch?: string; all?: boolean };
		return { restored: undo(b) };
	},
	"POST /api/config": async (req) => {
		const { config } = (await body(req)) as { config: Config };
		saveConfig(config);
		return { ok: true };
	},
	"POST /api/classes": async (req) => {
		const { classes } = (await body(req)) as { classes: Registry };
		const r: Registry = {};
		for (const [code, c] of Object.entries(classes)) addCourse(r, code, { ...c, source: c.source ?? "user" });
		saveClasses(r);
		return { classes: r };
	},
	"POST /api/learned": async (req) => {
		const { learned } = (await body(req)) as { learned: Learned };
		saveLearned(learned);
		return { ok: true };
	},
	"POST /api/resolve": async (req) => {
		const b = (await body(req)) as { path: string; course?: string; type?: string; assignment?: string; category?: string; project?: string; destination?: string; learnPrefix?: boolean; learnFolder?: boolean; dryRun?: boolean };
		const path = expand(b.path);
		if (!existsSync(path)) throw new Error(`not found: ${rel(path)}`);
		const course = b.course ? canonicalCode(b.course) : undefined;
		if (course) {
			const r = loadClasses();
			if (!r[course]) {
				addCourse(r, course, { source: "learned" });
				saveClasses(r);
			}
		}
		learn(path, { course, type: b.type, assignment: b.assignment, category: b.category ?? (course ? "school" : undefined), project: b.project, destination: b.destination ? expand(b.destination) : undefined }, { prefix: !!b.learnPrefix, folder: !!b.learnFolder });
		const { actions } = await buildPlan([dirname(path)], projectNames(), 8, [path]);
		const mine = actions.filter((a) => a.from === path);
		if (!b.dryRun) act(mine);
		return { actions: mine };
	},
	"GET /api/repos": async () => ({ moves: await planRepos() }),
	"POST /api/repos/apply": async (req) => {
		const { moves, allowDirty } = (await body(req)) as { moves: RepoMove[]; allowDirty?: boolean };
		let n = 0;
		const log: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => log.push(a.join(" "));
		try {
			for (const m of moves) if (moveRepo(m, { allowDirty })) n++;
		} finally {
			console.log = orig;
		}
		return { moved: n, log };
	},
	"GET /api/clean": () => ({ items: scanReclaim() }),
	"POST /api/clean/apply": async (req) => {
		const { paths } = (await body(req)) as { paths: string[] };
		const items = scanReclaim().filter((i) => paths.includes(i.path));
		return { parked: applyReclaim(items) };
	},
	"GET /api/structure": () => ({ tree: structure() }),
	"GET /api/agent": () => {
		const log: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => log.push(a.join(" "));
		try {
			agentStatus();
		} finally {
			console.log = orig;
		}
		return { lines: log };
	},
	"POST /api/open": async (req) => {
		const { path } = (await body(req)) as { path: string };
		const p = expand(path);
		if (!existsSync(p)) throw new Error("not found");
		execFileSync("/usr/bin/open", ["-R", p]);
		return { ok: true };
	},
};

export function startUi(port: number, open: boolean) {
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		const key = `${req.method} ${url.pathname}`;
		try {
			if (url.pathname === "/" || url.pathname === "/index.html") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(readFileSync(HTML));
				return;
			}
			const h = routes[key];
			if (!h) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: `no route ${key}` }));
				return;
			}
			const out = await h(req, url);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(out));
		} catch (err) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: (err as Error).message }));
		}
	});
	server.listen(port, "127.0.0.1", () => {
		const addr = `http://127.0.0.1:${port}`;
		console.log(`tidy ui at ${addr} (local only). Ctrl-C to stop.`);
		if (open) {
			try {
				execFileSync("/usr/bin/open", [addr]);
			} catch {}
		}
	});
	return server;
}

