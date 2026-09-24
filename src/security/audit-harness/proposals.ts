// Flow 308 (W8 Design part A, Lane A) — proposals.ts: `apply --proposal <id>`,
// the ONLY writing path for the audit-harness surface besides `baseline add`
// (`baseline.ts#addBaselineEntry`). Reuses the propose/store/apply/changelog
// discipline already shipped for learned patterns (`src/gdskills/learn.ts`,
// W3): re-run the audit, locate the proposal, refuse a manual-only or unknown
// proposal, apply under a file lock with an atomic write, refuse a second
// apply, and append a changelog line.

import path from "node:path";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { isPathInside, pathExists, withFileLock, writeFileAtomic } from "../../lib/fs";
import { readJsonObjectFile } from "../../lib/json";
import { computeAuditInternal } from "./index";
import type { ProposalEdit } from "./types";

/**
 * F3: proposal ids assigned in `index.ts` (`p-<16 hex>`) never carry
 * attacker-controlled content, but this is checked again here, at the one
 * place a proposal id becomes a filesystem path segment — refusing anything
 * that does not match BEFORE it is used to build `appliedMarkerPath`, rather
 * than trusting the caller (CLI, a future caller) to only ever pass one this
 * module minted itself.
 */
const PROPOSAL_ID_RE = /^p-[0-9a-f]{16}$/;

/**
 * F3: assert that `absolute` — after resolving symlinks, so a symlink
 * planted inside root pointing outside it does not slip through a
 * string-prefix check — stays inside `root`. Every path this module writes
 * to (the target file a proposal edits, the applied-marker, the changelog)
 * goes through this before the write. A path that does not exist yet (the
 * marker, on first apply) is checked against its resolved PARENT directory
 * instead, since `realpath` has nothing to resolve for it.
 */
async function assertContained(rootReal: string, absolute: string, label: string): Promise<void> {
  if (!isPathInside(rootReal, absolute)) {
    throw new Error(`Refusing to write ${label}: path escapes project root ${rootReal}.`);
  }
  const real = await realpath(absolute).catch(() => undefined);
  if (real !== undefined) {
    if (!isPathInside(rootReal, real)) {
      throw new Error(`Refusing to write ${label}: resolves outside project root ${rootReal} (symlink).`);
    }
    return;
  }
  // Does not exist yet (expected for a marker on first apply): the nearest
  // existing ancestor must still be real-contained.
  let dir = path.dirname(absolute);
  for (;;) {
    const dirReal = await realpath(dir).catch(() => undefined);
    if (dirReal !== undefined) {
      if (!isPathInside(rootReal, dirReal)) {
        throw new Error(`Refusing to write ${label}: parent directory resolves outside project root ${rootReal} (symlink).`);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return; // reached filesystem root without finding an existing ancestor; the string-prefix check above already covers this case
    dir = parent;
  }
}

export type ApplyProposalResult = {
  proposalId: string;
  findingId: string;
  check: string;
  path: string;
  rationale: string;
  appliedAt: string;
};

function dataRoot(root: string): string {
  return path.join(root, ".metaproject", "data", "security", "audit-harness");
}

function lockPath(root: string): string {
  return path.join(dataRoot(root), "apply.lock");
}

function changelogPath(root: string): string {
  return path.join(dataRoot(root), "changelog.jsonl");
}

function appliedMarkerPath(root: string, proposalId: string): string {
  return path.join(dataRoot(root), `${proposalId}.applied.json`);
}

function setPointer(target: unknown, pointer: string, mutate: (parent: Record<string, unknown> | unknown[], key: string) => void): unknown {
  const segments = pointer.split("/").filter((s) => s.length > 0).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length === 0) {
    throw new Error("Cannot apply an edit at the document root.");
  }
  let cursor: unknown = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (cursor === null || typeof cursor !== "object") {
      throw new Error(`Cannot follow JSON pointer segment "${segments[i]}": not an object/array.`);
    }
    const key = segments[i]!;
    cursor = Array.isArray(cursor) ? cursor[Number(key)] : (cursor as Record<string, unknown>)[key];
  }
  if (cursor === null || typeof cursor !== "object") {
    throw new Error("Cannot apply edit: parent is not an object/array.");
  }
  mutate(cursor as Record<string, unknown> | unknown[], segments[segments.length - 1]!);
  return target;
}

/**
 * F2: applying a structured (JSON pointer) edit is preferred over a text
 * splice for a JSON file — see `applyTextEdit` below for the text-splice
 * safety rules a `text-replace` edit against a JSON file must ALSO follow.
 * Re-parses the serialized result before writing (belt-and-suspenders: a
 * mutation built from this same parsed object graph cannot itself produce
 * invalid JSON, but nothing here should rely on that staying true) and
 * refuses a no-op edit (F20) rather than writing an unchanged file and
 * marking the proposal applied anyway.
 */
async function applyJsonEdit(
  rootReal: string,
  edit: Extract<ProposalEdit, { kind: "json-remove" | "json-set" }>,
): Promise<void> {
  const absolute = path.resolve(rootReal, edit.path);
  await assertContained(rootReal, absolute, `target file "${edit.path}"`);
  const read = await readJsonObjectFile(absolute);
  if (read.state !== "object") {
    throw new Error(`Cannot apply proposal: ${edit.path} is not a readable JSON object.`);
  }
  const document: Record<string, unknown> = read.value;
  const before = JSON.stringify(document);
  setPointer(document, edit.pointer, (parent, key) => {
    if (edit.kind === "json-remove") {
      if (Array.isArray(parent)) {
        parent.splice(Number(key), 1);
      } else {
        delete parent[key];
      }
    } else {
      if (Array.isArray(parent)) {
        parent[Number(key)] = edit.value;
      } else {
        parent[key] = edit.value;
      }
    }
  });
  if (JSON.stringify(document) === before) {
    // F20: e.g. a `json-remove` at a pointer that no longer exists (the
    // finding it targeted was already fixed another way) — nothing changed,
    // so nothing is written and the proposal is NOT marked applied.
    throw new Error(`Cannot apply proposal: edit would not change ${edit.path}; refusing to mark as applied.`);
  }
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  try {
    JSON.parse(serialized);
  } catch {
    throw new Error(`Cannot apply proposal: result is not valid JSON for ${edit.path}; refusing to write.`);
  }
  await writeFileAtomic(absolute, serialized);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * F2: this used to be `content.replace(edit.from, edit.to)` — a two-string
 * call to `String#replace` still treats `$&`/`$$`/`$1`-shaped substrings in
 * the REPLACEMENT as special patterns (that interpretation is not limited to
 * a regex search), so an `edit.to` that happened to contain one (a hook
 * command patch is free-form shell text) corrupted the write. It also only
 * ever touched the FIRST occurrence silently, which is unsound when
 * `edit.from` is not unique in the file — a proposal built against a stale
 * read of the tree could then edit the wrong occurrence. Both are fixed
 * together: occurrences are counted first and exactly one is required
 * (refuse, write nothing, otherwise), and the substitution itself uses
 * split/join, which performs a literal replacement with no `$`-pattern
 * interpretation.
 */
async function applyTextEdit(
  rootReal: string,
  edit: Extract<ProposalEdit, { kind: "text-replace" }>,
): Promise<void> {
  const absolute = path.resolve(rootReal, edit.path);
  await assertContained(rootReal, absolute, `target file "${edit.path}"`);
  const content = await readFile(absolute, "utf8");
  const occurrences = countOccurrences(content, edit.from);
  if (occurrences === 0) {
    throw new Error(`Cannot apply proposal: expected text not found in ${edit.path}.`);
  }
  if (occurrences > 1) {
    throw new Error(
      `Cannot apply proposal: expected text appears ${occurrences} times in ${edit.path}; refusing an ambiguous text-replace.`,
    );
  }
  if (edit.from === edit.to) {
    // F20: the proposed replacement is a no-op (e.g. a suppression-removal
    // patch whose regexes did not actually match this exact hook command
    // shape) — refuse rather than write an unchanged file and mark it applied.
    throw new Error(`Cannot apply proposal: edit would not change ${edit.path}; refusing to mark as applied.`);
  }
  const next = content.split(edit.from).join(edit.to);
  if (edit.path.toLowerCase().endsWith(".json")) {
    // F2: a text-replace edit landing on a JSON file must not corrupt it
    // either — re-parse before writing, refuse otherwise.
    try {
      JSON.parse(next);
    } catch {
      throw new Error(`Cannot apply proposal: result is not valid JSON for ${edit.path}; refusing to write.`);
    }
  }
  await writeFileAtomic(absolute, next);
}

/**
 * Apply the fix proposal named `proposalId`. Re-runs the audit (with
 * `fixProposals: true`) to locate the proposal by id in the CURRENT state of
 * the tree, refuses a `manual`-kind edit or an id that no longer exists, and
 * refuses a second apply of the same proposal. Every write happens under a
 * single file lock and via `writeFileAtomic`.
 */
export async function applyAuditProposal(
  root: string,
  proposalId: string,
  options: { now?: () => Date } = {},
): Promise<ApplyProposalResult> {
  // F3: validated BEFORE the id is used to build any path — every proposal
  // id `index.ts` mints matches this already, so this only ever rejects a
  // caller (CLI arg, or any future caller) passing something else in.
  if (!PROPOSAL_ID_RE.test(proposalId)) {
    throw new Error(`Invalid proposal id: ${proposalId}`);
  }
  // Resolved ONCE and used for every path this function builds from here on
  // — `root` itself (e.g. a macOS `/tmp` path) can sit behind a symlink, and
  // building some paths from the raw `root` and comparing them against a
  // REALPATH'd root (as `assertContained` does) would flag every ordinary,
  // perfectly-contained write as "escaping" purely from the string mismatch.
  // Using `rootReal` everywhere sidesteps that: absolute paths built from it
  // and the root `assertContained` checks against are the same string space.
  const rootReal = (await realpath(root).catch(() => undefined)) ?? path.resolve(root);
  return withFileLock(lockPath(rootReal), async () => {
    const marker = appliedMarkerPath(rootReal, proposalId);
    // F3: defense in depth — `marker`/`changelog` are built from `rootReal`
    // plus fixed segments plus a proposal id already regex-validated to
    // contain no path separators, so they cannot actually escape root;
    // asserted anyway, at the point of use, rather than trusted by
    // construction.
    await assertContained(rootReal, marker, "applied-marker file");
    if (await pathExists(marker)) {
      throw new Error(`Proposal already applied: ${proposalId}`);
    }

    const { report, proposalsById } = await computeAuditInternal(rootReal, {
      fixProposals: true,
      ...(options.now ? { now: options.now } : {}),
    });
    const finding = report.findings.find((f) => f.fixProposal?.id === proposalId);
    const internal: ProposalEdit | undefined = proposalsById.get(proposalId)?.edit;
    if (!finding || !finding.fixProposal || !internal) {
      throw new Error(`No such fix proposal: ${proposalId}`);
    }
    if (internal.kind === "manual") {
      throw new Error(`Fix proposal ${proposalId} has no automatic remediation; apply it by hand.`);
    }

    if (internal.kind === "json-remove" || internal.kind === "json-set") {
      await applyJsonEdit(rootReal, internal);
    } else if (internal.kind === "text-replace") {
      await applyTextEdit(rootReal, internal);
    }

    const now = options.now ? options.now() : new Date();
    const result: ApplyProposalResult = {
      proposalId,
      findingId: finding.id,
      check: finding.check,
      path: finding.path ?? "",
      rationale: finding.fixProposal.rationale,
      appliedAt: now.toISOString(),
    };

    const changelog = changelogPath(rootReal);
    await assertContained(rootReal, changelog, "changelog file");
    await mkdir(dataRoot(rootReal), { recursive: true });
    await appendFile(changelog, `${JSON.stringify(result)}\n`, "utf8");
    await writeFileAtomic(marker, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  });
}
