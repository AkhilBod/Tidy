/**
 * Minimal client for TypeSafe AI's Jev decision model (POST /v1/systemone).
 * Jev returns typed decisions with calibrated confidence, never text.
 *
 * Key: TYPESAFE_API_KEY in ~/.config/tidy/env (chmod 600), or in the file
 * named by TIDY_ENV_FILE.
 */
import { existsSync, readFileSync } from "node:fs";
import { ENV_FILE } from "./config.ts";

// The only host this tool may talk to. Lookalike reseller domains exist.
const API_BASE = "https://api.typesafe.ai";

export function loadEnv() {
	const files = [ENV_FILE, process.env.TIDY_ENV_FILE].filter((f): f is string => !!f && existsSync(f));
	for (const file of files) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq === -1) continue;
			const key = t.slice(0, eq).trim();
			if (key !== "TYPESAFE_API_KEY") continue;
			let val = t.slice(eq + 1).trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			if (!process.env[key]) process.env[key] = val;
		}
	}
}

// Pinned: thresholds are tuned per version, and jev-latest can shift answers.
export const JEV_MODEL = "jev-1.13.0";

export type JevQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "noul"; instructions: string };

export type JevAnswer = {
	choice?: string;
	score?: number;
	noul?: number;
	confidence?: number;
	probabilities?: Record<string, number> | number[];
};

export const choice = (
	instructions: string,
	criteria: Record<string, string>,
): JevQuestion => ({ type: "choice", instructions, criteria });

export const noul = (instructions: string): JevQuestion => ({
	type: "noul",
	instructions,
});

export const score = (instructions: string, criteria: string[]): JevQuestion => ({
	type: "score",
	instructions,
	criteria,
});

export async function decide<Q extends Record<string, JevQuestion>>(
	state: unknown,
	questions: Q,
): Promise<Record<keyof Q, JevAnswer>> {
	const key = process.env.TYPESAFE_API_KEY;
	if (!key) {
		throw new Error(`Missing TYPESAFE_API_KEY (put TYPESAFE_API_KEY=... in ${ENV_FILE})`);
	}

	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${API_BASE}/v1/systemone`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: JEV_MODEL, state, questions }),
		});
		if (res.ok) {
			const json = (await res.json()) as {
				answers: Record<keyof Q, JevAnswer>;
			};
			return json.answers;
		}
		const retryable = res.status === 429 || res.status >= 500;
		if (!retryable || attempt >= 5) {
			throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
		}
		await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
	}
}

export async function mapPool<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}
