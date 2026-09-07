import { readFile } from "node:fs/promises";

export async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line preserve-caught-error -- Preserve the sanitized public diagnostic without exposing the raw caught value or stack.
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

export async function readJsonFileOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return await readJsonFile<T>(filePath);
  } catch {
    return fallback;
  }
}

/**
 * What `readJsonObjectFile` found on disk. Three states, because a caller that
 * asked for an object has three genuinely different situations to handle.
 *
 * - `object`   — the file was read, parsed, and the payload IS a plain object.
 * - `non-object` — it parsed, to `null` / an array / a number / a string / a
 *   boolean. The payload rides along on `value` for a caller that wants it.
 * - `unreadable` — it could not be read, or did not parse. An ABSENT file lands
 *   here too: a reader that does not stat cannot honestly tell "absent" from
 *   "unreadable", so callers that must distinguish the two ask `pathExists`
 *   first — which every caller of this function does, because "never
 *   configured" and "configured but destroyed" are not the same posture.
 */
export type JsonObjectRead =
  | { state: "object"; value: Record<string, unknown> }
  | { state: "non-object"; value: unknown }
  | { state: "unreadable" };

/**
 * Read a JSON file that MUST be an object, and say which of the three things
 * happened rather than collapsing two of them into a fallback value.
 *
 * This is the shape-aware sibling of `readJsonFileOr`, added by T43 under the
 * ruling in `T39-review.md` ("Judgement calls" #4). `readJsonFileOr` falls back
 * only when the payload does not PARSE, so a file whose whole content is
 * `null`, `[]`, `42` or `"advisory"` reaches a caller that asked for an object
 * — under a signature that promised the fallback's type and returned whatever
 * parsed. Four bytes on disk have, in one phase, made a security gate vanish
 * from a completion record, downgraded enforcement to advisory, and returned a
 * clean exit code for a check that never ran.
 *
 * Two things this deliberately is NOT.
 *
 * It is not a change to `readJsonFileOr`. That function has 30 call sites
 * across 23 files, some of which read non-object payloads legitimately, and a
 * reader that started returning the fallback for arrays would break them
 * quietly — trading a known class of bug for an unknown one. A new function is
 * opt-in; a changed contract is not.
 *
 * It is not generic. `readJsonFileOr<HealthReport>(…)` type-checks and then
 * hands back a string, and `readJsonObjectFile<HealthReport>` would do exactly
 * the same one shape further in. What comes back is `Record<string, unknown>`
 * — precisely the fact that was verified — and the caller narrows from there
 * with its own predicate.
 *
 * It also replaces the two module-local `Symbol` sentinels this API's missing
 * distinction forced into existence (`CONFIG_UNREADABLE` in
 * `src/security/config.ts`, `MANIFEST_UNREADABLE` in `src/security/guard.ts`).
 * One workaround is a workaround; a second caller needing the same one means
 * the return type was wrong.
 */
export async function readJsonObjectFile(filePath: string): Promise<JsonObjectRead> {
  let parsed: unknown;
  try {
    parsed = await readJsonFile<unknown>(filePath);
  } catch {
    return { state: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "non-object", value: parsed };
  }
  return { state: "object", value: parsed as Record<string, unknown> };
}
