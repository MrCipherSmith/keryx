// `keryx review jev-profile` — flow 344's recommended-profile helper.
// ADAPTER only: `src/review/jev-profile.ts` is the pure merge/render logic;
// this file is where it meets `.metaproject/tasks.config.json` on disk.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { optionValue } from "../lib/args";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";
import { currentJevProfile, mergeRecommendedJevProfile, renderJevProfileMarkdown, toggleJevProfileKey } from "../review/jev-profile";

export const JEV_PROFILE_FLAGS = ["--apply", "--json"];

function rejectUnknownJevProfileFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_PROFILE_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-profile\`: ${[...new Set(unknown)].join(", ")}. ` +
        `Accepted: ${JEV_PROFILE_FLAGS.join(", ")}.`,
    );
  }
}

/** `.metaproject/tasks.config.json`'s current parsed content, or `undefined` (absent, unreadable, or unparsable — never thrown). */
async function readRawConfig(cwd: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * `keryx review jev-profile [show] [--apply recommended|show] [--json]`.
 *
 * `show` (bare positional, or `--apply show`) never writes — it only prints
 * the current `review.jev.*` state next to the measured verdict for each
 * key. `--apply recommended` merge-writes the recommended profile into
 * `.metaproject/tasks.config.json`, touching only the `review.jev.*` keys
 * this profile names and preserving everything else in the file untouched.
 */
export async function runJevProfile(args: string[]): Promise<void> {
  rejectUnknownJevProfileFlags(args);
  const cwd = process.cwd();
  const applyArg = optionValue(args, "--apply");
  const showRequested = args[0] === "show" || applyArg === "show";

  if (applyArg !== undefined && applyArg !== "recommended" && applyArg !== "show") {
    throw new Error(`Usage: keryx review jev-profile [show] [--apply recommended|show] [--json]. Got --apply "${applyArg}".`);
  }

  const raw = await readRawConfig(cwd);

  if (showRequested || applyArg === undefined) {
    const current = currentJevProfile(raw);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ current, applied: false }, null, 2));
      return;
    }
    console.log(renderJevProfileMarkdown(current, false));
    return;
  }

  const merged = mergeRecommendedJevProfile(raw);
  await writeFileAtomic(path.join(cwd, REVIEW_GATE_CONFIG_PATH), `${JSON.stringify(merged, null, 2)}\n`);
  const current = currentJevProfile(merged);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ current, applied: true, path: REVIEW_GATE_CONFIG_PATH }, null, 2));
    return;
  }
  console.log(renderJevProfileMarkdown(current, true));
}

// ---------------------------------------------------------------------------
// TUI shell helpers — `src/tui/jev-profile-inspector.ts`'s `/jevprofile`
// modal injects these as closures rather than touching disk itself, the same
// split every other `*-inspector.ts` in that directory holds.
// ---------------------------------------------------------------------------

/** The `review.jev.*` block as it currently reads on disk, for the modal's `current` accessor. */
export async function readJevProfileForShell(cwd: string): Promise<Record<string, unknown>> {
  return currentJevProfile(await readRawConfig(cwd));
}

/** Flip one `review.jev.<key>` boolean and persist it — the modal's per-row toggle. */
export async function toggleJevProfileKeyForShell(cwd: string, key: string): Promise<void> {
  const raw = await readRawConfig(cwd);
  const merged = toggleJevProfileKey(raw, key);
  await writeFileAtomic(path.join(cwd, REVIEW_GATE_CONFIG_PATH), `${JSON.stringify(merged, null, 2)}\n`);
}

/** Merge-write the full recommended profile and persist it — the modal's `a` key. */
export async function applyRecommendedJevProfileForShell(cwd: string): Promise<void> {
  const raw = await readRawConfig(cwd);
  const merged = mergeRecommendedJevProfile(raw);
  await writeFileAtomic(path.join(cwd, REVIEW_GATE_CONFIG_PATH), `${JSON.stringify(merged, null, 2)}\n`);
}
