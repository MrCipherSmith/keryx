// Flow 308 (W8 Design part A, Lane A) — proposals.ts: `apply --proposal <id>`,
// the ONLY writing path for the audit-harness surface besides `baseline add`
// (`baseline.ts#addBaselineEntry`). Reuses the propose/store/apply/changelog
// discipline already shipped for learned patterns (`src/gdskills/learn.ts`,
// W3): re-run the audit, locate the proposal, refuse a manual-only or unknown
// proposal, apply under a file lock with an atomic write, refuse a second
// apply, and append a changelog line.

import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { pathExists, withFileLock, writeFileAtomic } from "../../lib/fs";
import { readJsonObjectFile } from "../../lib/json";
import { computeAuditInternal } from "./index";
import type { ProposalEdit } from "./types";

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

async function applyJsonEdit(root: string, edit: Extract<ProposalEdit, { kind: "json-remove" | "json-set" }>): Promise<void> {
  const absolute = path.resolve(root, edit.path);
  const read = await readJsonObjectFile(absolute);
  if (read.state !== "object") {
    throw new Error(`Cannot apply proposal: ${edit.path} is not a readable JSON object.`);
  }
  const document: Record<string, unknown> = read.value;
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
  await writeFileAtomic(absolute, `${JSON.stringify(document, null, 2)}\n`);
}

async function applyTextEdit(root: string, edit: Extract<ProposalEdit, { kind: "text-replace" }>): Promise<void> {
  const absolute = path.resolve(root, edit.path);
  const content = await readFile(absolute, "utf8");
  if (!content.includes(edit.from)) {
    throw new Error(`Cannot apply proposal: expected text not found in ${edit.path}.`);
  }
  await writeFileAtomic(absolute, content.replace(edit.from, edit.to));
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
  return withFileLock(lockPath(root), async () => {
    const marker = appliedMarkerPath(root, proposalId);
    if (await pathExists(marker)) {
      throw new Error(`Proposal already applied: ${proposalId}`);
    }

    const { report, proposalsById } = await computeAuditInternal(root, {
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
      await applyJsonEdit(root, internal);
    } else if (internal.kind === "text-replace") {
      await applyTextEdit(root, internal);
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

    await mkdir(dataRoot(root), { recursive: true });
    await appendFile(changelogPath(root), `${JSON.stringify(result)}\n`, "utf8");
    await writeFileAtomic(marker, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  });
}
