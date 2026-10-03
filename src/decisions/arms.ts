// Flow 400: the four arms of the recommendation journal.
//
// Three factors decide how a question with a recommendation is put to the human:
//   order      agent (as the agent listed the options) | shuffled
//   mark       shown | hidden   (the "(Recommended)" mark and its textual forms)
//   preselect  on | off         (whether the recommended option starts highlighted)
//
//   A  agent    shown   on      the ordinary question (what `ordinary` meant before)
//   B  agent    shown   off     the mark, but no preselection
//   C  shuffled shown   off     the mark, in a random order
//   D  shuffled hidden  off     the blind question (what `blind` meant before)
//
// The arm is a pure function of (repoSalt, seq): the same repository and the same
// position in the journal give the same arm on a repeated run, so an assignment can
// be replayed and audited. The salt lives outside the repository, in
// `<XDG_CONFIG_HOME or ~/.config>/keryx/decisions/<repo hash>.seed` (mode 0600), and is
// created once; the record keeps only `seed`, a 32-bit number derived from the salt,
// never the salt itself.

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { configFile, decisionsDir, journalRoot } from "./store";
import type { DecisionMode } from "./types";

export type Arm = "A" | "B" | "C" | "D";

export const ARMS: readonly Arm[] = ["A", "B", "C", "D"];

export interface ArmFactors {
  order: "agent" | "shuffled";
  mark: "shown" | "hidden";
  preselect: boolean;
}

export const ARM_FACTORS: Readonly<Record<Arm, ArmFactors>> = {
  A: { order: "agent", mark: "shown", preselect: true },
  B: { order: "agent", mark: "shown", preselect: false },
  C: { order: "shuffled", mark: "shown", preselect: false },
  D: { order: "shuffled", mark: "hidden", preselect: false },
};

export type ArmWeights = Record<Arm, number>;

export const DEFAULT_ARM_WEIGHTS: Readonly<ArmWeights> = { A: 0.4, B: 0.2, C: 0.2, D: 0.2 };

/** The `mode` an old reader still understands: A is ordinary, D is blind, B and C are in between. */
export function modeOfArm(arm: Arm): DecisionMode {
  if (arm === "A") return "ordinary";
  if (arm === "D") return "blind";
  return "partial";
}

/** The arm a pre-v2 record belongs to: the ordinary mode was A, the blind mode was D. */
export function armOfMode(mode: DecisionMode): Arm {
  if (mode === "blind") return "D";
  return "A";
}

export function isArm(value: unknown): value is Arm {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

/** The 32-bit seed of one decision: a hash of the salt and the position in the journal. */
export function armSeed(salt: string, seq: number): number {
  const digest = createHash("sha256").update(`${salt}:${seq}`).digest();
  return digest.readUInt32BE(0);
}

/** mulberry32: a small seeded PRNG in [0, 1), deterministic across runs and platforms. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick the arm a draw `u` in [0, 1) falls on, walking A, B, C, D in order over the weights. */
export function pickArm(u: number, weights: ArmWeights = DEFAULT_ARM_WEIGHTS): Arm {
  const total = ARMS.reduce((sum, arm) => sum + weights[arm], 0);
  if (!(total > 0)) return "A";
  let edge = 0;
  for (const arm of ARMS) {
    edge += weights[arm];
    if (u * total < edge) return arm;
  }
  // only reachable through rounding at the very top of the range: the last arm with any weight
  return [...ARMS].reverse().find((arm) => weights[arm] > 0) ?? "A";
}

export interface ArmAssignment {
  arm: Arm;
  seed: number;
}

/** The assignment for (salt, seq). Pure: the same inputs give the same arm. */
export function assignArm(salt: string, seq: number, weights: ArmWeights = DEFAULT_ARM_WEIGHTS): ArmAssignment {
  const seed = armSeed(salt, seq);
  return { arm: pickArm(seededRandom(seed)(), weights), seed };
}

export interface ArmChoiceInput {
  salt: string;
  seq: number;
  weights?: ArmWeights;
  /** The question decides an irreversible action, or the blind.ts list matched it. */
  irreversible: boolean;
  /** The question carries a recommendation. Without one there is nothing to hide, order or preselect. */
  hasRecommendation: boolean;
  /** Test seam: take this arm as the draw instead of the seeded one. Irreversible questions are still forced to A. */
  force?: Arm | undefined;
}

export interface ArmChoice {
  arm: Arm;
  seed: number;
  /** True when the arm is A only because the question is irreversible (the draw was something else, or would have been). */
  forced: boolean;
  /** The arm the draw gave, before an irreversible question was moved to A. */
  drawn: Arm;
}

/**
 * Irreversible questions (an `irreversible` flag, an `action` tag, or a blind.ts
 * match) are always arm A with `forced: true`. Every other A carries `forced: false`.
 * A question with no recommendation is arm A too (nothing to vary), never forced.
 */
export function chooseArm(input: ArmChoiceInput): ArmChoice {
  const weights = input.weights ?? DEFAULT_ARM_WEIGHTS;
  const assigned = assignArm(input.salt, input.seq, weights);
  const drawn = input.force ?? assigned.arm;
  if (input.irreversible) return { arm: "A", seed: assigned.seed, forced: true, drawn };
  if (!input.hasRecommendation) return { arm: "A", seed: assigned.seed, forced: false, drawn: "A" };
  return { arm: drawn, seed: assigned.seed, forced: false, drawn };
}

/**
 * Weights from the `arms` key of decisions.config.json: any non-negative finite
 * number per arm, normalised on use. A missing key keeps its default; an
 * unusable block (negative, non-numeric, all zero) falls back to the defaults whole.
 */
export function parseArmWeights(raw: unknown): ArmWeights {
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_ARM_WEIGHTS };
  const given = raw as Record<string, unknown>;
  const weights: ArmWeights = { ...DEFAULT_ARM_WEIGHTS };
  for (const arm of ARMS) {
    const value = given[arm];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { ...DEFAULT_ARM_WEIGHTS };
    weights[arm] = value;
  }
  return ARMS.reduce((sum, arm) => sum + weights[arm], 0) > 0 ? weights : { ...DEFAULT_ARM_WEIGHTS };
}

export async function loadArmWeights(cwd: string): Promise<ArmWeights> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile(cwd), "utf8"));
    const arms = parsed !== null && typeof parsed === "object" ? (parsed as { arms?: unknown }).arms : undefined;
    return parseArmWeights(arms);
  } catch {
    return { ...DEFAULT_ARM_WEIGHTS };
  }
}

/** The pre-0.3.72 salt file inside the repository: read only to migrate it, never written. */
export function seedFile(root: string): string {
  return path.join(decisionsDir(root), "seed");
}

export interface SaltOptions {
  /** Test seam: the keryx config directory to keep the salt under (else KERYX_CONFIG_DIR, else `<XDG_CONFIG_HOME or ~/.config>/keryx`). */
  configDir?: string | undefined;
}

function keryxSaltDir(options: SaltOptions): string {
  const given = options.configDir ?? process.env["KERYX_CONFIG_DIR"];
  if (given !== undefined && given.length > 0) return path.join(given, "decisions");
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".config");
  return path.join(base, "keryx", "decisions");
}

const identityCache = new Map<string, string>();

/** What one repository is called outside it: the real path of git's common dir (shared by every worktree), else of the project root. */
async function repoIdentity(cwd: string): Promise<string> {
  const cached = identityCache.get(cwd);
  if (cached !== undefined) return cached;
  const target = (await resolveGitCommonDir(cwd)) ?? cwd;
  const identity = await realpath(target).catch(() => path.resolve(target));
  identityCache.set(cwd, identity);
  return identity;
}

/**
 * Where the salt of the repository `cwd` belongs to lives: outside the repository, in the user's
 * config directory, so the agent being measured cannot read it from the tree it works in.
 */
export async function saltFile(cwd: string, options: SaltOptions = {}): Promise<string> {
  const key = createHash("sha256").update(await repoIdentity(cwd)).digest("hex").slice(0, 16);
  return path.join(keryxSaltDir(options), `${key}.seed`);
}

/** A salt shorter than this is treated as absent: the generated one is 64 hex characters. */
const MIN_SALT_LENGTH = 16;

/**
 * The repository's salt, created once (mode 0600, directory 0700) outside the repository and read
 * back afterwards. Two processes racing to create it agree: the loser of the exclusive create reads
 * the winner's. An empty, blank or too-short salt file is as good as none: it is replaced
 * (atomically, through a temp file and a rename) rather than failing every question after it. A salt
 * file readable by others is tightened to 0600. A salt still in the old in-repo place
 * (`.metaproject/data/decisions/seed`) is moved to the new one when none exists yet, so earlier
 * assignments stay reproducible, and the in-repo copy is then deleted.
 */
export async function loadRepoSalt(cwd: string, options: SaltOptions = {}): Promise<string> {
  const file = await saltFile(cwd, options);
  const existing = await readSalt(file);
  if (existing.salt !== undefined) {
    await tightenMode(file);
    await dropLegacySeed(cwd);
    return existing.salt;
  }
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const legacy = await readSalt(seedFile(await journalRoot(cwd)));
  const fresh = legacy.salt ?? randomBytes(32).toString("hex");
  if (!existing.present) {
    try {
      await writeFile(file, `${fresh}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await dropLegacySeed(cwd);
      return fresh;
    } catch {
      const winner = await readSalt(file);
      if (winner.salt !== undefined) {
        await dropLegacySeed(cwd);
        return winner.salt;
      }
      // the winner's file is unusable too (empty): fall through and replace it
    }
  }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${fresh}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new Error(`could not create the decisions salt file ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  // another process may have replaced it in the same instant: whatever is on disk now is the salt
  const settled = (await readSalt(file)).salt ?? fresh;
  await dropLegacySeed(cwd);
  return settled;
}

/** Delete the in-repo salt once the new one is in place (the agent can read the tree, so a copy there defeats the move). */
async function dropLegacySeed(cwd: string): Promise<void> {
  try {
    await rm(seedFile(await journalRoot(cwd)), { force: true });
  } catch {
    // best effort: a read-only tree must not stop a question
  }
}

async function readSalt(file: string): Promise<{ present: boolean; salt: string | undefined }> {
  try {
    const salt = (await readFile(file, "utf8")).trim();
    return { present: true, salt: salt.length >= MIN_SALT_LENGTH ? salt : undefined };
  } catch {
    return { present: false, salt: undefined };
  }
}

async function tightenMode(file: string): Promise<void> {
  try {
    if (((await stat(file)).mode & 0o077) !== 0) await chmod(file, 0o600);
  } catch {
    // best effort: a read-only file system must not stop a question
  }
}
