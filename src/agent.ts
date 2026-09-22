import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, stateDir } from "./config.ts";
import { HOME, expand, rel } from "./util.ts";

export const LABEL = "com.tidy.agent";
const PLIST = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function plist() {
	const c = loadConfig();
	const bin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "tidy");
	const watch = [...new Set([...c.inbox.roots, ...c.roots])].map(expand).filter(existsSync);
	const logs = join(stateDir(), "logs");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(bin)}</string><string>watch-tick</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>TIDY_NODE</key><string>${esc(process.execPath)}</string></dict>
  <key>WatchPaths</key>
  <array>${watch.map((w) => `<string>${esc(w)}</string>`).join("")}</array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>ThrottleInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${esc(join(logs, "tidy.out.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logs, "tidy.err.log"))}</string>
</dict>
</plist>
`;
}

const uid = () => execFileSync("/usr/bin/id", ["-u"], { encoding: "utf8" }).trim();

export function installAgent() {
	mkdirSync(join(stateDir(), "logs"), { recursive: true });
	mkdirSync(dirname(PLIST), { recursive: true });
	writeFileSync(PLIST, plist());
	try {
		execFileSync("/bin/launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { stdio: "ignore" });
	} catch {}
	execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid()}`, PLIST], { stdio: "inherit" });
	console.log(`installed ${rel(PLIST)}; runs on changes to watched folders and daily at 03:00.`);
	console.log(`If it logs EPERM, grant ${process.execPath} Full Disk Access in System Settings > Privacy & Security.`);
}

export function uninstallAgent() {
	try {
		execFileSync("/bin/launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { stdio: "ignore" });
	} catch {}
	if (existsSync(PLIST)) unlinkSync(PLIST);
	console.log("agent removed");
}

export function agentStatus() {
	try {
		const out = execFileSync("/bin/launchctl", ["list"], { encoding: "utf8" }).split("\n").find((l) => l.endsWith(LABEL));
		console.log(out ? `loaded: pid/status/label = ${out}` : "not loaded");
	} catch {
		console.log("launchctl unavailable");
	}
	console.log(`plist: ${existsSync(PLIST) ? rel(PLIST) : "not installed"}`);
	console.log(`logs:  ${rel(join(stateDir(), "logs"))}`);
}
