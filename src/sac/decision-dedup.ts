// RP-13 FR1+FR2: dedup/conflict hint (+ optional judge annotation) at review
// time (flow 168, Phase 1).
//
// A read-side enrichment attached to `ProposalLifecycleService.review()`'s
// RETURN VALUE only — never a new field on the schema-validated, immutable
// `Transition` ledger record itself (that record's schema is
// `additionalProperties: false`; adding a field there would break
// validation and, worse, would make an informational hint look like part of
// the durable audit trail). `src/memory/dedup.ts`'s `findDuplicates`/
// `findConflicts` are called UNMODIFIED — this module's only job is
// building a `Candidate` that matches what is ABOUT to be written, and (for
// wiki-update) a thin field-mapping adapter that reshapes existing wiki
// decision pages into the same comparable shape `MemoryEntry`-based scoring
// already reads. No new similarity/embedding infrastructure.
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { findConflicts, findDuplicates, type Candidate } from "../memory/dedup";
import { collectEntries } from "../memory/store";
import { loadMemoryConfig } from "../memory/config";
import type { ConflictHint, DuplicateHint, MemoryEntry, MemoryStatus } from "../memory/types";
import { readVerifiedProposalEvidence } from "./proposal-evidence";
import { localWorkspaceAuthorizationServer, WorkspaceService } from "./workspace-service";
import { runModelTurn, type ModelTurnResult, type ProviderFactory } from "../harness/provider/single-turn";

export type DedupHint = {
  duplicates: DuplicateHint[];
  conflicts: ConflictHint[];
};

export type DecisionAnnotation = {
  verdict: "new" | "duplicate-of" | "conflicts-with" | "supersedes";
  ref?: string;
  confidence?: "low" | "medium" | "high";
};

/** Shorter than SLATE-16's 15s: this runs after accept has already
 * committed — a slow judgment must give up quickly, it is not blocking a
 * decision the way SLATE-16's resolve-or-create is. */
const DEFAULT_ANNOTATION_TIMEOUT_MS = 8_000;

const MEMORY_STATUSES: readonly MemoryStatus[] = ["draft", "accepted", "conflict", "deprecated", "superseded"];
function asMemoryStatus(value: string | undefined): MemoryStatus {
  return MEMORY_STATUSES.includes(value as MemoryStatus) ? (value as MemoryStatus) : "draft";
}

function extractTitle(content: string): string {
  const line = content.split("\n").find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : "Untitled";
}

function extractSection(content: string, heading: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim().startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

function extractHeaderField(content: string, field: string): string | undefined {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

/**
 * The workspace's own bound `component` resource, when it has one — the
 * ONE real, already-recorded scope signal available at accept time (no new
 * similarity engine). Without this, `findConflicts`'s `sharedScopeOrTags`
 * check has nothing to match on for a SAC-created candidate (module/entity/
 * files are otherwise always empty, tags are a fixed, uninformative
 * constant) and can never fire, no matter what the existing corpus
 * contains. A read failure degrades to `null` — never blocks the hint.
 */
async function resolveWorkspaceModule(cwd: string, workspaceId: string): Promise<string | null> {
  try {
    const service = new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } });
    const manifest = await service.show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId });
    return manifest.resources.find((r) => r.kind === "component")?.uri ?? null;
  } catch {
    return null;
  }
}

/**
 * Wiki decision pages (`.metaproject/wiki/decisions/*.md`) reshaped into the
 * SAME comparable shape `findDuplicates`/`findConflicts` already score
 * `MemoryEntry`s with. Every SAC-created decision page
 * (`wiki-owner-writer.ts`'s `renderWrapUpDecisionPage`) follows this exact
 * `#`/`Version:`/`Type:`/`Status:`/`## Summary` shape — the same established
 * header/section convention memory entries use — so a hand-authored or
 * otherwise-generated decision page that follows it parses the same way.
 * Never throws: an unreadable directory returns `[]`, a malformed
 * individual page is skipped, never failing the whole scan.
 */
async function collectWikiDecisionEntries(cwd: string): Promise<MemoryEntry[]> {
  const dir = path.join(cwd, ".metaproject", "wiki", "decisions");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const file of files) {
    const absolutePath = path.join(dir, file);
    try {
      const content = await readFile(absolutePath, "utf8");
      entries.push({
        absolutePath,
        relativePath: path.posix.join("decisions", file),
        type: extractHeaderField(content, "Type") ?? "decision",
        title: extractTitle(content),
        version: extractHeaderField(content, "Version") ?? null,
        status: asMemoryStatus(extractHeaderField(content, "Status")),
        confidence: "medium",
        summary: extractSection(content, "Summary"),
        details: extractSection(content, "Details"),
        tags: [],
        // Most wiki decision pages carry no `Module:` header at all (the
        // SAC-written template doesn't emit one) — an optional, best-effort
        // signal for pages that DO record one, never required.
        scopes: { module: extractHeaderField(content, "Module") ?? null, entity: null, files: [], skills: [] },
        created: null,
        updated: null,
        provenance: { source: null, link: null },
      });
    } catch {
      // Unreadable/malformed page — skip this one, keep scanning the rest.
    }
  }
  return entries;
}

export type ComputeDedupHintInput = {
  cwd: string;
  workspaceId: string;
  proposalId: string;
  kind: "wiki-update" | "memory-entry";
  /** FR2: attempt a bounded judge annotation when the hint is non-empty.
   * Default true — every real call site leaves this unset. */
  annotate?: boolean;
  provider?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  providerFactory?: ProviderFactory;
  annotationTimeoutMs?: number;
};

export type ComputeDedupHintResult = {
  hint: DedupHint;
  annotation?: DecisionAnnotation;
};

/**
 * FR1 (+FR2 folded in): computes a `DedupHint` for an ACCEPTED wiki-update
 * or memory-entry proposal, comparing a `Candidate` built from the same
 * hash-verified evidence the owner-writer just wrote against the existing
 * corpus, using `findDuplicates`/`findConflicts` unmodified. Never throws —
 * any failure (evidence unreadable, corpus scan error) degrades to
 * `undefined`, the caller's own "no hint shown" case. AC2's own contract:
 * this must never be able to block or fail the review it is attached to.
 */
export async function computeDedupHint(input: ComputeDedupHintInput): Promise<ComputeDedupHintResult | undefined> {
  try {
    const verified = await readVerifiedProposalEvidence(input.cwd, input.workspaceId, input.proposalId);
    if (!("proposal" in verified)) return undefined;
    const { content } = verified;
    const rawTitle = extractTitle(content);
    const summary = extractSection(content, "Summary") || content.slice(0, 500);
    const module = await resolveWorkspaceModule(input.cwd, input.workspaceId);

    let candidate: Candidate;
    let existing: MemoryEntry[];
    if (input.kind === "memory-entry") {
      // Matches memory-owner-writer.ts's renderWrapUpMemoryEntry exactly —
      // the candidate reflects what is ABOUT to be written, same as every
      // other SAC-created entry (Type: task-note, Tags: sac-wrap-up).
      candidate = { title: rawTitle, summary, type: "task-note", tags: ["sac-wrap-up"], scopes: { module, entity: null, files: [] } };
      existing = await collectEntries(input.cwd);
    } else {
      // Matches wiki-owner-writer.ts's renderWrapUpDecisionPage exactly
      // (title prefix, Type: decision).
      candidate = { title: `SAC: ${rawTitle}`, summary, type: "decision", tags: [], scopes: { module, entity: null, files: [] } };
      existing = await collectWikiDecisionEntries(input.cwd);
    }

    const config = await loadMemoryConfig(input.cwd);
    const hint: DedupHint = {
      duplicates: findDuplicates(candidate, existing, config),
      conflicts: findConflicts(candidate, existing),
    };

    if (input.annotate === false || (hint.duplicates.length === 0 && hint.conflicts.length === 0)) {
      return { hint };
    }
    const annotation = await computeAnnotation(input, hint, rawTitle, summary);
    return annotation ? { hint, annotation } : { hint };
  } catch {
    return undefined;
  }
}

/**
 * FR2: a bounded, single-shot model judgment over ONLY the dedup hint
 * already computed — same tool-calling judgment pattern already approved
 * for `ask_user`/`spawn_subagent`/SLATE-16's `resolveOrCreateWorkspace`
 * (mirrors its `runModelTurn` + timeout-race shape exactly). Purely
 * informational: the return value is never consulted by any accept/reject/
 * merge code path (AC3) — this function's caller only ever attaches it to
 * `review()`'s return payload for display. Fails closed (no credential,
 * timeout, unparseable response) to `undefined` — never blocks, never
 * throws.
 */
async function computeAnnotation(
  input: ComputeDedupHintInput,
  hint: DedupHint,
  title: string,
  summary: string,
): Promise<DecisionAnnotation | undefined> {
  const candidates = [
    ...hint.duplicates.map((d) => `duplicate-candidate ${d.path}: ${d.title}`),
    ...hint.conflicts.map((c) => `conflict-candidate ${c.path}: ${c.title} (${c.reason})`),
  ].join("\n");
  const system =
    "You are annotating whether a new decision/knowledge entry is genuinely NEW, a DUPLICATE of an existing one, " +
    "CONFLICTS with one, or SUPERSEDES one. Respond with EXACTLY one line: `new`, or `duplicate-of <path>`, " +
    "or `conflicts-with <path>`, or `supersedes <path>` — the path copied EXACTLY from the candidates below. " +
    "This is informational only and will never itself accept, reject, or merge anything.";
  const user = `--- new entry ---\ntitle: ${title}\nsummary: ${summary}\n\n--- candidates ---\n${candidates}`;

  let modelResult: ModelTurnResult | undefined;
  const timeoutMs = input.annotationTimeoutMs ?? DEFAULT_ANNOTATION_TIMEOUT_MS;
  const turn = runModelTurn({
    system,
    user,
    requestId: "decision-dedup-annotation",
    maxOutputTokens: 48,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.providerFactory !== undefined ? { providerFactory: input.providerFactory } : {}),
  }).then((result) => {
    modelResult = result;
    return "done" as const;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  let raceOutcome: "done" | "timeout";
  try {
    raceOutcome = await Promise.race([turn, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (raceOutcome === "timeout") {
    void turn.catch(() => {});
    return undefined;
  }

  const result = modelResult!;
  if (!result.credentialAvailable && result.text.trim().length === 0) return undefined;

  const knownRefs = new Set([...hint.duplicates.map((d) => d.path), ...hint.conflicts.map((c) => c.path)]);
  const line = result.text.trim().split("\n")[0]?.trim() ?? "";
  if (/^new$/i.test(line)) return { verdict: "new" };
  const match = line.match(/^(duplicate-of|conflicts-with|supersedes)\s+(\S+)$/i);
  if (match?.[1] !== undefined && match[2] !== undefined && knownRefs.has(match[2])) {
    return { verdict: match[1].toLowerCase() as DecisionAnnotation["verdict"], ref: match[2] };
  }
  return undefined;
}
