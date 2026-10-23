// A review wave is one pass of a review package: a chunk of its recorded plan, or the round itself. The dispatcher
// names it on `spawn_subagent` so the child is counted against that wave and not against the turn. The name is taken
// only if it points at something the package records, so a model cannot lift the cap by inventing wave names.

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readChunkPlan, readChunkState } from "./chunks";
import { packWaves, waveBytesOf } from "./slice";

/** The wave of a package's own round, before or beside any chunk pass. */
export const REVIEW_WAVE_ROUND = "round";

export type ReviewWaveResolution =
	| { ok: true; key: string }
	| { ok: false; reason: string };

const refuse = (reason: string): ReviewWaveResolution => ({
	ok: false,
	reason,
});

async function isFile(file: string): Promise<boolean> {
	return (await stat(file).catch(() => undefined))?.isFile() === true;
}

/** Original slice packing grants pools; retry cuts never grant additional pools. */
async function sliceWaveCount(dir: string): Promise<number> {
	const file = await realpath(path.join(dir, "slices", "manifest.json"));
	const relative = path.relative(dir, file);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return 0;
	const manifest: unknown = JSON.parse(await readFile(file, "utf8"));
	if (typeof manifest !== "object" || manifest === null) return 0;
	const maxBytes = Reflect.get(manifest, "maxBytes");
	const configuredWaveBytes = Reflect.get(manifest, "waveBytes");
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return 0;
	if (
		configuredWaveBytes !== undefined &&
		(!Number.isSafeInteger(configuredWaveBytes) ||
			configuredWaveBytes < maxBytes)
	)
		return 0;
	const waveBytes = waveBytesOf({
		maxBytes,
		...(configuredWaveBytes === undefined
			? {}
			: { waveBytes: configuredWaveBytes }),
	});
	const slices: unknown = Reflect.get(manifest, "slices");
	if (
		Reflect.get(manifest, "schemaVersion") !== 1 ||
		!Array.isArray(slices) ||
		slices.length === 0
	)
		return 0;
	const ids = new Set<string>();
	const originals: { bytes: number }[] = [];
	for (const slice of slices) {
		if (typeof slice !== "object" || slice === null) return 0;
		const id = Reflect.get(slice, "id");
		const bytes = Reflect.get(slice, "bytes");
		if (
			typeof id !== "string" ||
			id.length === 0 ||
			ids.has(id) ||
			!Number.isSafeInteger(bytes) ||
			bytes < 0
		)
			return 0;
		ids.add(id);
		if (Reflect.get(slice, "retryOf") === undefined) originals.push({ bytes });
	}
	return packWaves(originals, waveBytes).length;
}

/**
 * Resolves `{ package, pass }` to a wave key, or says why it cannot. `package` is a review package directory inside
 * `projectRoot`; `pass` is `round`, an original `slices-NNN` byte group, or the id of a chunk in the package's `chunks.json` or in the retry chunks of its
 * `chunk-state.json`. Never throws: any failure to read the package is a refusal.
 */
export async function resolveReviewWave(
	projectRoot: string,
	wave: unknown,
): Promise<ReviewWaveResolution> {
	if (typeof wave !== "object" || wave === null)
		return refuse("review_wave must be an object { package, pass }");
	const pkg = Reflect.get(wave, "package");
	const pass = Reflect.get(wave, "pass");
	if (
		typeof pkg !== "string" ||
		pkg.trim().length === 0 ||
		typeof pass !== "string" ||
		pass.trim().length === 0
	) {
		return refuse("review_wave needs a non-empty package and pass");
	}
	try {
		const root = await realpath(projectRoot);
		const dir = await realpath(path.resolve(projectRoot, pkg));
		const rel = path.relative(root, dir);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
			return refuse("review_wave package is outside the project");
		if (!(await isFile(path.join(dir, "manifest.json"))))
			return refuse("review_wave package has no manifest.json");
		const id = pass.trim();
		if (/^slices-\d{3}$/.test(id)) {
			const index = Number(id.slice("slices-".length));
			if (index < 1 || index > (await sliceWaveCount(dir)))
				return refuse("review_wave pass is not an original slice wave");
		} else if (id !== REVIEW_WAVE_ROUND) {
			const plan = await readChunkPlan(dir);
			if (plan === undefined)
				return refuse("review_wave package records no chunk plan");
			const known = new Set(
				[...plan.chunks, ...(await readChunkState(dir)).derived].map(
					(chunk) => chunk.id,
				),
			);
			if (!known.has(id))
				return refuse(
					`review_wave pass ${id} is not a chunk of the package's plan`,
				);
		}
		return { ok: true, key: `${dir}\u0000${id}` };
	} catch (err) {
		return refuse(
			`review_wave could not be checked: ${(err as Error).message}`,
		);
	}
}

/** The key as a person reads it: package directory name and pass. */
export function describeReviewWave(key: string): string {
	const [dir = "", id = ""] = key.split("\u0000");
	return `${path.basename(dir)}/${id}`;
}
