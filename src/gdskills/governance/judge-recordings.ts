// Flow 316, T6 — recorded live-judge verdicts for `antiGamingAnswers`
// (core zone: `fs`/`path` only, no provider imports — same rule `judge.ts`
// documents for itself). `keryx skills judge-check <id> --judge ... --record`
// (a later dispatch, `src/commands/skills-governance.ts`) is the only writer;
// `recordedJudge` turns a recording file back into a `Judge` value so the
// integrity guard's anti-gaming checks (`src/gdskills/stack-pack-eval-integrity.test.ts`,
// another task's file) can replay a live judge's verdicts offline, keyed by
// `judgeRequestDigest` so a stale recording (an edited rubric, a bumped
// `JUDGE_PROMPT_VERSION`) is detectably wrong rather than silently reused.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { judgeRequestDigest, type AntiGamingKind, type Judge, type JudgeRequest, type JudgeVerdict } from "./judge";

/**
 * `<this dir>/judge-recordings` — resolved from `import.meta.dir`, the same
 * pattern `bundled-eval.ts`'s `defaultBundledRoot` uses, so this module never
 * depends on `process.cwd()` (a recording is read/written relative to where
 * this file lives on disk, not wherever the CLI happens to be invoked from).
 * The real, committed recordings directory — always this value in production.
 */
export const JUDGE_RECORDINGS_DIR = path.join(import.meta.dir, "judge-recordings");

/**
 * The directory every path/read/write function below resolves against,
 * unless a caller passes its own `recordingsDir` explicitly: `KERYX_JUDGE_RECORDINGS_DIR`
 * when set (tests point this at a throwaway temp directory so `--record`
 * never touches the real committed recordings), otherwise `JUDGE_RECORDINGS_DIR`.
 */
function defaultRecordingsDir(): string {
  const override = process.env.KERYX_JUDGE_RECORDINGS_DIR;
  return override !== undefined && override.length > 0 ? override : JUDGE_RECORDINGS_DIR;
}

/**
 * One live-judge call's recorded verdict, taken as one of several samples of
 * the SAME canned answer against the SAME scenario (fix 1 / R1-4: the live
 * judge is non-deterministic on identical input, so a single recorded sample
 * cannot characterize it — `judge-check --samples <n>` records `n` of these
 * per canned answer, and the AG test requires every one of them to give the
 * expected result).
 */
export interface JudgeRecordingSample {
  readonly verdict: "pass" | "fail";
  readonly reason: string;
  /** Set when this sample's verdict was manufactured after a parse failure (mirrors `JudgeVerdict.error`) rather than genuinely reasoned by the judge — an error-carrying sample is itself a mismatch in `judge-check` (R1-8) and is persisted here rather than dropped. */
  readonly error?: string;
}

/** One canned anti-gaming answer's recorded live-judge verdicts — `samples.length` independent judge calls against the identical request. */
export interface JudgeRecordingEntry {
  readonly scenarioId: string;
  readonly kind: AntiGamingKind;
  /** `judgeRequestDigest(request)` for the exact request every sample below answered — `recordedJudge` refuses a replay whose freshly-built digest disagrees (a stale rubric/prompt-version edit is detectable, never silently reused). Absent for an entry recorded WITHOUT a live judge call (see `writeJudgeRecording`'s "empty answer" note) — such an entry can never be looked up by digest, only by a caller that already knows it never reaches the judge. */
  readonly requestDigest: string;
  /** One or more independent judge calls against this exact request, in call order. Never empty. */
  readonly samples: readonly JudgeRecordingSample[];
}

/** One skill's full recording file — `<pack>__<skill>.json` under `JUDGE_RECORDINGS_DIR`. */
export interface JudgeRecordingFile {
  readonly judgePromptVersion: string;
  readonly judge: string;
  readonly judgeModel: string;
  readonly recordedAt: string;
  readonly entries: readonly JudgeRecordingEntry[];
}

/** Thrown by `readJudgeRecording` when the file on disk does not have the expected shape — a hand-edited or half-written recording must be named as broken, never silently coerced. */
export class JudgeRecordingFormatError extends Error {}

const SKILL_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/**
 * `"<pack>/<skill>"` -> `<JUDGE_RECORDINGS_DIR>/<pack>__<skill>.json`. Refuses
 * any id that does not match `^[a-z0-9-]+/[a-z0-9-]+$` — the only shape this
 * repo's skill ids take (see `catalog-index.ts`'s own id construction) — so a
 * malformed id can never be turned into a path that escapes the recordings
 * directory (no `..`, no extra separators, nothing but lowercase/digit/hyphen
 * segments either side of the one `/`).
 */
export function judgeRecordingPath(skillId: string, recordingsDir: string = defaultRecordingsDir()): string {
  if (!SKILL_ID_PATTERN.test(skillId)) {
    throw new Error(`judgeRecordingPath: skill id ${JSON.stringify(skillId)} must match "<pack>/<skill>" (lowercase letters, digits, hyphens)`);
  }
  const [pack, skill] = skillId.split("/");
  return path.join(recordingsDir, `${pack}__${skill}.json`);
}

function isJudgeVerdictString(value: unknown): value is "pass" | "fail" {
  return value === "pass" || value === "fail";
}

function validateRecordingFile(value: unknown, filePath: string): asserts value is JudgeRecordingFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JudgeRecordingFormatError(`${filePath}: recording must be a JSON object`);
  }
  const file = value as Record<string, unknown>;
  for (const field of ["judgePromptVersion", "judge", "judgeModel", "recordedAt"] as const) {
    if (typeof file[field] !== "string" || (file[field] as string).length === 0) {
      throw new JudgeRecordingFormatError(`${filePath}: "${field}" must be a non-empty string`);
    }
  }
  if (!Array.isArray(file.entries)) {
    throw new JudgeRecordingFormatError(`${filePath}: "entries" must be an array`);
  }
  file.entries.forEach((entryValue, index) => {
    if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) {
      throw new JudgeRecordingFormatError(`${filePath}: entries[${index}] must be an object`);
    }
    const entry = entryValue as Record<string, unknown>;
    if (typeof entry.scenarioId !== "string" || entry.scenarioId.length === 0) {
      throw new JudgeRecordingFormatError(`${filePath}: entries[${index}].scenarioId must be a non-empty string`);
    }
    if (typeof entry.kind !== "string" || entry.kind.length === 0) {
      throw new JudgeRecordingFormatError(`${filePath}: entries[${index}].kind must be a non-empty string`);
    }
    if (typeof entry.requestDigest !== "string") {
      throw new JudgeRecordingFormatError(`${filePath}: entries[${index}].requestDigest must be a string`);
    }
    if (!Array.isArray(entry.samples) || entry.samples.length === 0) {
      throw new JudgeRecordingFormatError(`${filePath}: entries[${index}].samples must be a non-empty array`);
    }
    entry.samples.forEach((sampleValue, sampleIndex) => {
      if (typeof sampleValue !== "object" || sampleValue === null || Array.isArray(sampleValue)) {
        throw new JudgeRecordingFormatError(`${filePath}: entries[${index}].samples[${sampleIndex}] must be an object`);
      }
      const sample = sampleValue as Record<string, unknown>;
      if (!isJudgeVerdictString(sample.verdict)) {
        throw new JudgeRecordingFormatError(`${filePath}: entries[${index}].samples[${sampleIndex}].verdict must be "pass" or "fail"`);
      }
      if (typeof sample.reason !== "string") {
        throw new JudgeRecordingFormatError(`${filePath}: entries[${index}].samples[${sampleIndex}].reason must be a string`);
      }
      if (sample.error !== undefined && typeof sample.error !== "string") {
        throw new JudgeRecordingFormatError(`${filePath}: entries[${index}].samples[${sampleIndex}].error must be a string when present`);
      }
    });
  });
}

/**
 * Reads `<pack>__<skill>.json` back into a `JudgeRecordingFile`, or
 * `undefined` when no recording exists yet for `skillId`. Throws
 * `JudgeRecordingFormatError` (naming the file) for a malformed one — never
 * silently returns a partial/best-effort shape.
 */
export function readJudgeRecording(skillId: string, recordingsDir: string = defaultRecordingsDir()): JudgeRecordingFile | undefined {
  const filePath = judgeRecordingPath(skillId, recordingsDir);
  if (!existsSync(filePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new JudgeRecordingFormatError(`${filePath}: could not parse recording (${error instanceof Error ? error.message : String(error)})`);
  }
  validateRecordingFile(parsed, filePath);
  return parsed;
}

/**
 * Writes `file` to `<pack>__<skill>.json`, stable key order (matching
 * `JudgeRecordingFile`'s own field order) and 2-space indentation, with a
 * trailing newline — a diff-friendly, deterministic byte-for-byte output for
 * a value built from the same input, and the same shape a hand read of the
 * committed file expects.
 */
export function writeJudgeRecording(skillId: string, file: JudgeRecordingFile, recordingsDir: string = defaultRecordingsDir()): void {
  const filePath = judgeRecordingPath(skillId, recordingsDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const stable: JudgeRecordingFile = {
    judgePromptVersion: file.judgePromptVersion,
    judge: file.judge,
    judgeModel: file.judgeModel,
    recordedAt: file.recordedAt,
    entries: file.entries.map((entry) => ({
      scenarioId: entry.scenarioId,
      kind: entry.kind,
      requestDigest: entry.requestDigest,
      samples: entry.samples.map((sample) => ({
        verdict: sample.verdict,
        reason: sample.reason,
        ...(sample.error !== undefined ? { error: sample.error } : {}),
      })),
    })),
  };
  writeFileSync(filePath, `${JSON.stringify(stable, null, 2)}\n`, "utf8");
}

/**
 * Turns a recording file back into a `Judge` value — `judgeRequestDigest`
 * over the incoming `request` is looked up against `file.entries`; a match
 * replays sample `sampleIndex` (default 0) of that entry's `samples`,
 * offline, with no network call. There is no entry for a digest that does
 * not appear in the recording (a stale rubric edit, a scenario added since
 * the recording was taken, or a request this recording never covered) —
 * `recordedJudge` throws rather than fabricating a verdict, naming the
 * scenario and digest and the exact command to re-record. It also throws
 * when `sampleIndex` is out of range for the matched entry's `samples`,
 * rather than silently wrapping around or falling back to sample 0 — a
 * caller (the AG test) iterating every recorded sample must know when it has
 * run past the last one.
 */
export function recordedJudge(file: JudgeRecordingFile, sampleIndex = 0): Judge {
  const byDigest = new Map(file.entries.map((entry) => [entry.requestDigest, entry] as const));
  return async (request: JudgeRequest): Promise<JudgeVerdict> => {
    const digest = judgeRequestDigest(request);
    const entry = byDigest.get(digest);
    if (entry === undefined) {
      throw new Error(
        `no recorded judge verdict for ${request.scenarioId} (digest ${digest}); re-record with keryx skills judge-check <id> --judge ... --record`,
      );
    }
    const sample = entry.samples[sampleIndex];
    if (sample === undefined) {
      throw new Error(
        `no recorded sample ${sampleIndex} for ${request.scenarioId} (digest ${digest}); entry has ${entry.samples.length} sample(s); re-record with keryx skills judge-check <id> --judge ... --record --samples ${sampleIndex + 1}`,
      );
    }
    // An error-carrying sample is a manufactured verdict (a parse failure),
    // never a genuinely reasoned one — it can never replay as "pass", the
    // same rule `regradeRecordedReport` and `judge-check` enforce on this
    // exact combination. A hand-edited or otherwise malformed recording that
    // pairs `error` with `verdict: "pass"` is corrected on replay rather than
    // trusted.
    if (sample.error !== undefined) {
      return { verdict: "fail", reason: sample.reason.length > 0 ? sample.reason : "recorded sample carries an error", error: sample.error };
    }
    return { verdict: sample.verdict, reason: sample.reason };
  };
}
