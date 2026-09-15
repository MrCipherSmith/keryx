/**
 * Keep review records true to the flow they belong to when `flow renumber`
 * moves it.
 *
 * # One source of truth: where the package lives
 *
 * A package attached to a flow lives at `.metaproject/flows/<dir>/reviews/<id>/`,
 * and every reader that decides anything already goes by that location: the
 * review gate and `keryx review loop` list `<dir>/reviews/`, and `keryx review
 * status <id>` finds a package by searching the flow directories. What the
 * package ALSO writes down — `manifest.flow.{id,path}`, the six
 * `manifest.artifacts` paths, the `flow:` line of `scope.md`, finding paths into
 * the flow's own files, and the `Link:`/`Location:` of a review note — are copies
 * of that location taken at ingest time.
 *
 * So a move rewrites the copies, and readers are NOT taught to translate old ids
 * through `id-map.json`. That alternative leaves the files on disk permanently
 * asserting the old number, and makes every reader responsible for the
 * indirection — including the ones that are not code: `git grep`, a person
 * opening `manifest.json`, the next round's `prior_findings`. A reader that
 * forgets gets the old id with no error, which is the defect this repairs (flow
 * 256, R4-001: a 252 -> 256 renumber left three rounds saying `flow: 252` and
 * pointing at a directory that no longer existed). `id-map.json` stays what it
 * is: the history of the move, for references that live OUTSIDE the records
 * (merged PR titles, commit messages).
 *
 * # What is not rewritten
 *
 * `report.md` is the reviewer's text verbatim, and prose in `findings.json`
 * (`evidence`, `problem`) quotes what the reviewer saw; neither is a record of
 * where the flow lives. Only a string value that IS a path into the moved
 * directory is rewritten — a path mentioned mid-sentence is a quote.
 */

import { readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { flowsRoot } from "../flow/store";
import type { FlowRenumberReviewRecords } from "../flow/types";
import { reviewNotesDir } from "./review-notes";

export type FlowMove = {
  cwd: string;
  from: string;
  to: string;
  fromDir: string;
  toDir: string;
};

type PlannedRewrite = {
  /** Where the file is NOW, before the move — where it is written, and restored. */
  current: string;
  /** Where it will be once the move is done, relative to `cwd`. */
  final: string;
  before: string;
  after: string;
};

type Plan = { rewrites: PlannedRewrite[]; unreadable: string[] };

/** The prefix `buildManifest` records, independent of the platform separator. */
const RECORDED_FLOWS_ROOT = ".metaproject/flows";

/** The header line `renderScope` writes: `flow: <id> (<reason>)`. First match only. */
const SCOPE_FLOW_LINE = /^flow: (\d{3})\b/m;

/** `- Link: <package>` and ``- Location: `<file>`:<line>`` in a review note. */
const NOTE_PATH_LINE = /^(- (?:Link|Location): `?)([^`\s]+)/gm;

/**
 * Rename the flow directory, with every review record re-pointed at the new id.
 *
 * The records are rewritten BEFORE the rename, so the rename is the one commit
 * point. Until it happens, any failure restores every file already written and
 * the flow is exactly as it was; once it happens, the packages already agree
 * with their new location. Rewriting after the rename would leave a window —
 * and, on a failure, a resting state — where the flow sits at the new number
 * while its packages name the old one, which is the state this exists to
 * remove.
 *
 * The caller holds the flow lock, so no ingest writes into the package between
 * the plan and the rename.
 */
export async function moveFlowDirWithReviewRecords(move: FlowMove): Promise<FlowRenumberReviewRecords> {
  const plan = await planReviewRecordRewrites(move);
  const written: PlannedRewrite[] = [];
  try {
    for (const rewrite of plan.rewrites) {
      await writeFileAtomic(rewrite.current, rewrite.after);
      written.push(rewrite);
    }
    await rename(path.join(flowsRoot(move.cwd), move.fromDir), path.join(flowsRoot(move.cwd), move.toDir));
  } catch (error) {
    const unrestored = await restore(written);
    if (unrestored.length > 0) {
      throw new Error(
        `flow renumber failed, and ${unrestored.length} review record(s) could not be restored and now name ` +
          `flow ${move.to} while the flow is still ${move.from}: ${unrestored.join(", ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { rewritten: plan.rewrites.map((rewrite) => rewrite.final), unreadable: plan.unreadable };
}

async function restore(written: readonly PlannedRewrite[]): Promise<string[]> {
  const failed: string[] = [];
  for (const rewrite of [...written].reverse()) {
    try {
      await writeFileAtomic(rewrite.current, rewrite.before);
    } catch {
      failed.push(rewrite.final);
    }
  }
  return failed;
}

async function planReviewRecordRewrites(move: FlowMove): Promise<Plan> {
  const oldPrefix = `${RECORDED_FLOWS_ROOT}/${move.fromDir}`;
  const newPrefix = `${RECORDED_FLOWS_ROOT}/${move.toDir}`;
  const movePath = (value: string): string =>
    value === oldPrefix || value.startsWith(`${oldPrefix}/`) ? `${newPrefix}${value.slice(oldPrefix.length)}` : value;

  const fromRoot = path.join(flowsRoot(move.cwd), move.fromDir);
  const toRoot = path.join(flowsRoot(move.cwd), move.toDir);
  const finalOf = (file: string): string =>
    path.relative(
      move.cwd,
      file.startsWith(`${fromRoot}${path.sep}`) ? path.join(toRoot, path.relative(fromRoot, file)) : file,
    );
  const plan: Plan = { rewrites: [], unreadable: [] };

  const reviewsDir = path.join(fromRoot, "reviews");
  if (await pathExists(reviewsDir)) {
    for (const entry of await readdir(reviewsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDir = path.join(reviewsDir, entry.name);
      await planJson(plan, path.join(packageDir, "manifest.json"), finalOf, (value) => {
        const moved = mapStrings(value, movePath);
        const flow = asRecord(asRecord(moved)?.["flow"]);
        if (flow !== null && flow["id"] === move.from) {
          flow["id"] = move.to;
        }
        return moved;
      });
      await planJson(plan, path.join(packageDir, "findings.json"), finalOf, (value) => mapStrings(value, movePath));
      await planText(plan, path.join(packageDir, "scope.md"), finalOf, (text) =>
        text.replace(SCOPE_FLOW_LINE, (line, id: string) => (id === move.from ? `flow: ${move.to}` : line)),
      );
    }
  }

  // Outside the moved directory, and named by round rather than by flow, so
  // only the path inside the note goes stale — never the note's own name.
  const notesDir = reviewNotesDir(move.cwd);
  if (await pathExists(notesDir)) {
    for (const entry of await readdir(notesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      await planText(plan, path.join(notesDir, entry.name), finalOf, (text) =>
        text.replace(NOTE_PATH_LINE, (_line, lead: string, value: string) => `${lead}${movePath(value)}`),
      );
    }
  }
  return plan;
}

/**
 * A JSON record, rewritten if its DATA changes.
 *
 * Compared as data rather than as text so a file formatted by hand is not
 * rewritten just because this writer would have indented it differently. An
 * unparseable file is left untouched and reported: the review gate already
 * refuses a round it cannot read, and a renumber is not the place to repair one.
 */
async function planJson(
  plan: Plan,
  file: string,
  finalOf: (file: string) => string,
  rewrite: (value: unknown) => unknown,
): Promise<void> {
  if (!(await pathExists(file))) {
    return;
  }
  const before = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    plan.unreadable.push(finalOf(file));
    return;
  }
  const moved = rewrite(parsed);
  if (JSON.stringify(moved) === JSON.stringify(parsed)) {
    return;
  }
  plan.rewrites.push({ current: file, final: finalOf(file), before, after: `${JSON.stringify(moved, null, 2)}\n` });
}

async function planText(
  plan: Plan,
  file: string,
  finalOf: (file: string) => string,
  rewrite: (text: string) => string,
): Promise<void> {
  if (!(await pathExists(file))) {
    return;
  }
  const before = await readFile(file, "utf8");
  const after = rewrite(before);
  if (after !== before) {
    plan.rewrites.push({ current: file, final: finalOf(file), before, after });
  }
}

/** A deep copy with every string passed through `map`. Keys keep their order. */
function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") {
    return map(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, map));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]));
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
