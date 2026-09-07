// AFC-W04 (flow 235, phase 3, T12) — the wiki evidence envelope.
//
// `docs/requirements/keryx-agent-first-core/schemas/wiki-evidence.schema.json`
// has been complete and agreed for a while, and until this module it had zero
// producers: `src/contracts/agent-first-core.fixtures.test.ts` validates its
// worked example, and nothing in `src/` ever built one. That is this
// programme's recurring defect — a capability no live path calls — sitting on
// the very contract this criterion is about. So this module implements the
// agreed shape rather than proposing another one: every field name, enum value
// and required/optional split below is read off that schema, and the tests
// validate what this module emits against that same file through the same
// validator the contract harness uses.
//
// The four clauses of AC9, and where each one lives:
//
//   "a mandatory exclusion is not lost"
//       `caveats` is part of the ITEM, not a neighbouring item a ranker may
//       drop: `buildEvidenceItem` resolves every declared caveat before it
//       will emit anything, and refuses the item outright when one cannot be
//       resolved. The fragment, its live caveat and its exception are one
//       indivisible unit (wiki-specification.md §6), so there is no code path
//       that returns "the update is agreed" without "implementation deferred".
//
//   "conflicting sources are explicitly paired"
//       Two disagreeing sections come back as two ITEMS, each carrying a
//       `conflictRefs` entry naming the other with its own source version.
//       Pairing is symmetric even when only one side declared it, and a
//       conflict partner is pulled in as REQUIRED — so a reader can never see
//       one side of a disagreement rendered as an uncontested fact. Nothing
//       here picks a winner; a resolved conflict would be indistinguishable
//       from an absent one.
//
//   "stale and draft content is not marked verified"
//       `freshness.state` is `fresh` only for a section that is accepted AND
//       current AND substantive AND was handed a verified snapshot by the
//       caller. Everything else is `unknown`/`stale` WITH a reason. This
//       module verifies nothing itself and therefore never claims a
//       verification: `confirmedBy` and `acceptanceBasisRef` stay null unless
//       the page declares them, and a declared authority is qualified
//       `unknown`, not `confirmed`.
//
//   "a mandatory overflow returns an error rather than a shortened rule"
//       Reused, not reinvented: `assembleContext`/`ContextOverflow` from
//       `../ctx/assembly.ts` — the required-vs-optional split with an explicit
//       overflow marker naming the required item that did not fit. The
//       repository-map lane (`../gdgraph/repomap.ts`) reused the same
//       primitive for AFC-12 rather than inventing a second vocabulary; a
//       third spelling of the same idea would be its own defect. An excerpt is
//       NEVER shortened to make an item fit: an item is emitted whole or the
//       package fails with `budget-exceeded`.
//
// Pure over its inputs: no I/O, no writes. `../wiki/service.ts` reads the
// pages and the section registry and hands them in. That is deliberate —
// AC4's "чистое чтение не пишет" applies to this path too, and the tests
// assert the working tree is byte-identical after an evidence call.

import { assembleContext, type ContextOverflow } from "../ctx/assembly";
import type { RetrievalCode } from "../lib/retrieval-codes";
import type { SectionIndex, WikiSectionRecord } from "./section-index";
import {
  resolveSectionIdentity,
  type SectionRegistry,
} from "./section-tombstone";

/** The `const` the schema pins. Bumping it is a contract change, not a tweak. */
export const WIKI_EVIDENCE_CONTRACT_VERSION = "1.0.0";

/**
 * The same documented `chars-div-4` estimator `../gdgraph/repomap.ts` uses for
 * the same budget contract. Defined locally rather than imported so this
 * module does not depend on a file another lane is editing in this phase; the
 * number it produces is identical.
 */
export function estimateEvidenceTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- the envelope, exactly as `wiki-evidence.schema.json` defines it ---------

export type EvidenceScope = {
  projectId: string;
  checkoutId: string;
  workspaceId?: string;
  taskId?: string;
};

export type EvidenceSource = { ref: string; version: string; fragment: string };

export type EvidenceConstraint = {
  text: string;
  source: EvidenceSource | null;
  sourceStatus: "known" | "unknown";
  unknownReason?: string;
};

export type EvidenceLifecycle = {
  status: "accepted" | "draft" | "conflict" | "deprecated" | "superseded" | "archived" | "unknown";
  current: boolean;
  validFrom: string | null;
  validTo: string | null;
  supersededBy: string | null;
};

export type EvidenceFreshness = {
  state: "fresh" | "stale" | "unknown";
  reason?: string;
  snapshotVersion: string | null;
};

export type EvidenceProvenance = {
  claimType: "observation" | "hypothesis" | "decision" | "instruction";
  sourceStatus: "known" | "unknown";
  source: EvidenceSource | null;
  authorRef: string | null;
  confirmedBy: string | null;
  acceptanceBasisRef: string | null;
  constraints: EvidenceConstraint[];
  unknownReason?: string;
};

export type EvidenceBinding = {
  relation: "describes" | "based-on" | "verified-by" | "supersedes";
  targetRef: string;
  targetVersion: string;
  qualification: "confirmed" | "proposed" | "broken" | "unknown";
};

export type EvidenceItem = {
  contractVersion: typeof WIKI_EVIDENCE_CONTRACT_VERSION;
  scope: EvidenceScope;
  pageRef: string;
  pageVersion: string;
  sectionId: string;
  sectionVersion: string;
  title: string;
  contentClass: "substantive" | "scaffold" | "reference";
  excerpt: { text: string; startLine: number; endLine: number };
  lifecycle: EvidenceLifecycle;
  freshness: EvidenceFreshness;
  provenance: EvidenceProvenance;
  caveats: EvidenceConstraint[];
  bindings: EvidenceBinding[];
  conflictRefs: EvidenceSource[];
};

/**
 * A section that matched but was NOT turned into evidence, and why.
 *
 * A refusal is visible output, never a silent drop: "the caveat source is
 * missing" and "there was nothing to say" must not look alike.
 */
export type EvidenceRefusal = {
  sectionRef: string;
  code: Extract<RetrievalCode, "insufficient-evidence">;
  reason: string;
};

// The outcome codes are taken from the shared closed vocabulary
// (`../lib/retrieval-codes.ts`, AFC-M03), not re-spelled here: that module
// exists precisely because every retrieval surface used to invent its own
// spelling. `Extract` keeps each variant's literal — so a caller still narrows
// on `status` — while binding the spelling to the one list, so a code renamed
// there fails to compile here instead of quietly forking.
export type EvidencePackage =
  | {
      status: Extract<RetrievalCode, "ok">;
      reason: string;
      items: EvidenceItem[];
      refused: EvidenceRefusal[];
      /** The loss manifest: optional items dropped for budget, named not counted. */
      omittedOptional: string[];
      partial: boolean;
      overflow: null;
      suggestion: string;
    }
  | {
      status: Extract<RetrievalCode, "budget-exceeded">;
      reason: string;
      items: [];
      refused: EvidenceRefusal[];
      omittedOptional: string[];
      partial: boolean;
      /** `../ctx/assembly.ts`'s marker, verbatim — the same one repomap reuses. */
      overflow: ContextOverflow;
      requiredRef: string;
      suggestion: string;
    }
  | {
      status: Extract<RetrievalCode, "no-match" | "insufficient-evidence">;
      reason: string;
      items: [];
      refused: EvidenceRefusal[];
      omittedOptional: string[];
      partial: boolean;
      overflow: null;
      suggestion: string;
    };

// --- authored declarations ----------------------------------------------------
//
// A caveat is a LINK between sections (wiki-specification.md §6's own example:
// the text says the update is agreed, a linked caveat says implementation is
// deferred). The link has to be authored somewhere, and the idiom this
// repository already uses for exactly this — a machine-read field line inside a
// page — is `Describes:` (`./describes.ts`). These follow it.
//
//   Caveat: implementation-deferred                     (same page)
//   Caveat: keryx:page/other#deferred                   (another page)
//   Conflicts-With: keryx:page/retry-history#retry-limit-old
//   Claim-Type: decision | instruction | observation | hypothesis
//   Authority: decision:dep-2026-01[@v1]
//   Based-On: <ref>[@<version>]
//
// Field lines stay part of the section body and therefore part of the excerpt:
// they are authored bytes of the section, and an excerpt that quietly differed
// from the range it claims would be its own small version of the defect this
// criterion is about.

const FIELD_RE = /^(Caveat|Caveats|Conflicts-With|Claim-Type|Authority|Based-On)\s*:\s*(.+)$/i;

export type EvidenceDeclarations = {
  caveatRefs: string[];
  conflictRefs: string[];
  claimType: EvidenceProvenance["claimType"] | null;
  authority: string | null;
  basedOn: string[];
};

const CLAIM_TYPES = new Set(["observation", "hypothesis", "decision", "instruction"]);

/** Parse the evidence declarations authored into one section's body. */
export function parseEvidenceDeclarations(body: string): EvidenceDeclarations {
  const declarations: EvidenceDeclarations = {
    caveatRefs: [],
    conflictRefs: [],
    claimType: null,
    authority: null,
    basedOn: [],
  };
  for (const line of body.split("\n")) {
    const match = line.trim().match(FIELD_RE);
    if (!match) {
      continue;
    }
    const field = (match[1] ?? "").toLowerCase();
    const values = (match[2] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (field === "caveat" || field === "caveats") {
      declarations.caveatRefs.push(...values);
    } else if (field === "conflicts-with") {
      declarations.conflictRefs.push(...values);
    } else if (field === "claim-type") {
      const claim = (values[0] ?? "").toLowerCase();
      declarations.claimType = CLAIM_TYPES.has(claim)
        ? (claim as EvidenceProvenance["claimType"])
        : null;
    } else if (field === "authority") {
      declarations.authority = values[0] ?? null;
    } else {
      declarations.basedOn.push(...values);
    }
  }
  return declarations;
}

/**
 * Expand a declared reference to a full `sectionRef`.
 *
 * A bare id means "a section of THIS page" — the owner namespace section
 * identity already uses (`./section-index.ts`). Nothing here searches by
 * title: `resolveSectionIdentity` refuses to substitute a same-named section
 * and this must not smuggle that behaviour back in.
 */
export function normalizeSectionRef(raw: string, ownerPageId: string): string {
  const value = raw.trim();
  if (value.includes("#")) {
    return value;
  }
  return `${ownerPageId}#${value.replace(/^#/, "")}`;
}

// --- mapping a section record onto the envelope --------------------------------

function pageVersionOf(record: WikiSectionRecord): string {
  // A page with no `Version:` field still needs an identifier the reader can
  // compare across two reads; the section digest is one, and calling it
  // `digest:` keeps it from being mistaken for an authored version number.
  return record.pageVersion ?? `digest:${record.digest.slice(0, 16)}`;
}

function sectionVersionOf(record: WikiSectionRecord): string {
  return `sha256:${record.digest.slice(0, 16)}`;
}

function fragmentOf(record: WikiSectionRecord): string {
  return `section:${record.sectionId}#lines=${record.bodyRange.startLine}-${record.bodyRange.endLine}`;
}

export function sourceOf(record: WikiSectionRecord): EvidenceSource {
  return { ref: record.pageId, version: pageVersionOf(record), fragment: fragmentOf(record) };
}

export function titleOf(record: WikiSectionRecord): string {
  return record.headingPath.length > 0
    ? `${record.pageTitle} › ${record.headingPath.join(" › ")}`
    : record.pageTitle;
}

/**
 * The page's own `Status:` field, mapped onto the contract's lifecycle.
 *
 * `current: true` is the strong claim (the schema itself only allows it
 * alongside `accepted`), so anything this function cannot read as accepted is
 * NOT current. An unreadable status is `unknown`, never optimistically
 * accepted — "could not be confirmed rendered as confirmed" is the failure
 * this criterion exists to stop.
 */
export function lifecycleFor(
  pageStatus: string | null,
  historical: boolean,
): EvidenceLifecycle {
  const status = (pageStatus ?? "").trim().toLowerCase();
  const base: EvidenceLifecycle = {
    status: "unknown",
    current: false,
    validFrom: null,
    validTo: null,
    supersededBy: null,
  };
  if (historical) {
    // Historical mode already classified this as not current; saying
    // `accepted`+`current` here would contradict the surface that admitted it.
    return { ...base, status: "superseded" };
  }
  if (status === "accepted" || status === "current" || status === "active") {
    return { ...base, status: "accepted", current: true };
  }
  if (status === "draft") {
    return { ...base, status: "draft" };
  }
  if (status === "deprecated" || status === "superseded" || status === "archived") {
    return { ...base, status: status as EvidenceLifecycle["status"] };
  }
  return base;
}

/**
 * Freshness, and the one narrow case in which `fresh` is honest.
 *
 * `verifiedSnapshot` is a snapshot version a caller obtained from an actual
 * freshness run. Even then it is only carried when the section is accepted,
 * current and substantive: a draft handed a verified snapshot stays not-fresh,
 * with the reason saying so. Absent a run, the state is `unknown` — "not
 * verified" — never `fresh` by default.
 */
export function freshnessFor(
  record: WikiSectionRecord,
  lifecycle: EvidenceLifecycle,
  verifiedSnapshot: string | undefined,
): EvidenceFreshness {
  if (lifecycle.status === "draft") {
    return {
      state: "unknown",
      reason:
        "the owner page is a draft: its bases have not been accepted, so nothing here is verified content.",
      snapshotVersion: null,
    };
  }
  if (lifecycle.status === "superseded" || lifecycle.status === "deprecated" || lifecycle.status === "archived") {
    return {
      state: "stale",
      reason: `the owner page is ${lifecycle.status}; this is shown for reference and is not a current constraint.`,
      snapshotVersion: null,
    };
  }
  if (record.contentClass === "reference") {
    return {
      state: "unknown",
      reason:
        "generated Reference content: its producer source was not re-verified for this evidence package.",
      snapshotVersion: null,
    };
  }
  if (record.contentClass === "scaffold") {
    return {
      state: "unknown",
      reason: "placeholder scaffolding: there is no content here whose freshness could be verified.",
      snapshotVersion: null,
    };
  }
  if (lifecycle.current && verifiedSnapshot) {
    return { state: "fresh", snapshotVersion: verifiedSnapshot };
  }
  if (verifiedSnapshot) {
    return {
      state: "unknown",
      reason:
        `a freshness snapshot was supplied, but the owner page is ${lifecycle.status} rather than accepted and current, ` +
        "so the section is not reported as verified.",
      snapshotVersion: null,
    };
  }
  return {
    state: "unknown",
    reason:
      "no freshness run backs this package: the section's bases are not verified in this checkout.",
    snapshotVersion: null,
  };
}

function bindingsFor(declarations: EvidenceDeclarations): EvidenceBinding[] {
  const bindings: EvidenceBinding[] = [];
  const push = (relation: EvidenceBinding["relation"], raw: string): void => {
    const at = raw.lastIndexOf("@");
    const targetRef = at > 0 ? raw.slice(0, at) : raw;
    const targetVersion = at > 0 ? raw.slice(at + 1) : "unknown";
    bindings.push({
      relation,
      targetRef,
      targetVersion: targetVersion.length > 0 ? targetVersion : "unknown",
      // Nothing in this module checks that the target exists or says what the
      // page claims it says, so the binding is `unknown` — not `confirmed`.
      // A qualification is a verification claim and this path performs none.
      qualification: "unknown",
    });
  };
  if (declarations.authority) {
    push("based-on", declarations.authority);
  }
  for (const raw of declarations.basedOn) {
    push("based-on", raw);
  }
  return bindings;
}

// --- building one item ---------------------------------------------------------

export type EvidenceBuildInput = {
  index: SectionIndex;
  registry: SectionRegistry;
  scope: EvidenceScope;
  record: WikiSectionRecord;
  /** `Status:` of the owner page. */
  pageStatus: string | null;
  historical?: boolean;
  /** sectionRef → snapshot version, from a real freshness run. */
  verified?: Readonly<Record<string, string>>;
  /** Extra conflict partners discovered from the other side of the pairing. */
  extraConflictRefs?: readonly string[];
};

export type EvidenceBuild =
  | { ok: true; item: EvidenceItem; conflictPartners: string[] }
  | { ok: false; refusal: EvidenceRefusal };

/**
 * Build one evidence item, or refuse it.
 *
 * The refusal branch is the load-bearing half. A declared caveat that cannot
 * be resolved — the section was deleted (tombstone), never existed, or is
 * addressed by a provisional locator taken against an older body — means the
 * mandatory half of an indivisible unit is unavailable, and
 * wiki-specification.md §6 is explicit: that is `insufficient-evidence`, not
 * the first half returned on its own.
 */
export function buildEvidenceItem(input: EvidenceBuildInput): EvidenceBuild {
  const { record, index, registry } = input;
  const declarations = parseEvidenceDeclarations(record.body);
  const refuse = (reason: string): EvidenceBuild => ({
    ok: false,
    refusal: { sectionRef: record.sectionRef, code: "insufficient-evidence", reason },
  });

  if (record.bodyRange.endLine < record.bodyRange.startLine || record.body.trim().length === 0) {
    return refuse(
      `section "${record.sectionRef}" has no body, so there is no fragment to cite.`,
    );
  }

  const caveats: EvidenceConstraint[] = [];
  for (const raw of declarations.caveatRefs) {
    const ref = normalizeSectionRef(raw, record.pageId);
    const resolution = resolveSectionIdentity(index, registry, ref);
    if (resolution.kind === "found") {
      caveats.push({
        text: resolution.section.body.trim(),
        source: sourceOf(resolution.section),
        sourceStatus: "known",
      });
      continue;
    }
    if (resolution.kind === "tombstoned") {
      return refuse(
        `the mandatory caveat source "${ref}" was removed (${resolution.tombstone.reason}; recorded ` +
          `${resolution.tombstone.removedAt}). It is not resolved to a similarly titled section, and the ` +
          "fragment it qualifies is not returned without it.",
      );
    }
    if (resolution.kind === "stale-locator") {
      return refuse(
        `the mandatory caveat source "${ref}" is a version-bound locator whose page body has changed ` +
          `(recorded ${resolution.recordedPageVersion ?? "unknown"}, current ` +
          `${resolution.currentPageVersion ?? "unknown"}); it is not read at the old offsets.`,
      );
    }
    return refuse(
      `the mandatory caveat source "${ref}" cannot be resolved, so the fragment it qualifies is ` +
        "withheld rather than returned as an unqualified statement.",
    );
  }

  const lifecycle = lifecycleFor(input.pageStatus, input.historical === true);
  const freshness = freshnessFor(record, lifecycle, input.verified?.[record.sectionRef]);

  const conflictPartners = [
    ...new Set([
      ...declarations.conflictRefs.map((raw) => normalizeSectionRef(raw, record.pageId)),
      ...(input.extraConflictRefs ?? []),
    ]),
  ].filter((ref) => ref !== record.sectionRef);

  const conflictSources: EvidenceSource[] = [];
  for (const ref of conflictPartners) {
    const resolution = resolveSectionIdentity(index, registry, ref);
    if (resolution.kind === "found") {
      conflictSources.push(sourceOf(resolution.section));
      continue;
    }
    if (resolution.kind === "tombstoned") {
      // The disagreement is still recorded: a conflict that quietly vanished
      // because the other side was deleted would read as consensus.
      conflictSources.push({
        ref: resolution.tombstone.ref.split("#")[0] ?? resolution.tombstone.ref,
        version: "removed",
        fragment: `section:${ref.split("#")[1] ?? ref}#removed=${resolution.tombstone.removedAt}`,
      });
      continue;
    }
    conflictSources.push({
      ref: ref.split("#")[0] ?? ref,
      version: "unknown",
      fragment: `section:${ref.split("#")[1] ?? ref}#unresolved`,
    });
  }

  const source = sourceOf(record);
  const item: EvidenceItem = {
    contractVersion: WIKI_EVIDENCE_CONTRACT_VERSION,
    scope: input.scope,
    pageRef: record.pageId,
    pageVersion: pageVersionOf(record),
    sectionId: record.sectionId,
    sectionVersion: sectionVersionOf(record),
    title: titleOf(record),
    contentClass: record.contentClass,
    excerpt: {
      // Whole, or not at all. The 240-character cut `wikiAsk` applies to its
      // display excerpt is exactly the "shortened rule" this criterion
      // forbids, so an item that does not fit is refused by the budget below
      // instead of being trimmed here.
      text: record.body,
      startLine: record.bodyRange.startLine,
      endLine: record.bodyRange.endLine,
    },
    lifecycle,
    freshness,
    provenance: {
      claimType: declarations.claimType ?? claimTypeForDomain(record.domain),
      sourceStatus: "known",
      source,
      // Authorship and confirmation are claims about people. Nothing here can
      // observe either, so both stay null unless a page declares an
      // acceptance basis — and even then the basis is unverified.
      authorRef: null,
      confirmedBy: null,
      acceptanceBasisRef: declarations.authority ?? null,
      constraints: caveats,
    },
    caveats,
    bindings: bindingsFor(declarations),
    conflictRefs: conflictSources,
  };

  return { ok: true, item, conflictPartners };
}

function claimTypeForDomain(domain: string): EvidenceProvenance["claimType"] {
  if (domain === "decision") {
    return "decision";
  }
  if (domain === "business-rule") {
    return "instruction";
  }
  return "observation";
}

// --- assembling the package ----------------------------------------------------

export type EvidenceSeed = {
  sectionRef: string;
  /** Rank order from the retrieval surface; 0 is the best match. */
  rank: number;
};

export type EvidenceAssembleInput = {
  index: SectionIndex;
  registry: SectionRegistry;
  scope: EvidenceScope;
  seeds: readonly EvidenceSeed[];
  /** wiki-relative page path → the page's `Status:` field. */
  pageStatus: Readonly<Record<string, string | null>>;
  historicalRefs?: readonly string[];
  verified?: Readonly<Record<string, string>>;
  maxItems: number;
  maxTokens: number;
  /** Ids dropped before assembly (e.g. memory citations, which carry no section). */
  preOmitted?: readonly string[];
};

/**
 * Turn ranked sections into a bounded, honest evidence package.
 *
 * Required set: the best-ranked item, plus every conflict partner of a
 * required item. Pulling the partner in is what makes "explicitly paired"
 * true at delivery and not only in the data model — an item whose
 * `conflictRefs` point at something the caller never received would let a
 * disagreement read as a single confident claim.
 */
export function assembleEvidencePackage(input: EvidenceAssembleInput): EvidencePackage {
  const byRef = new Map(input.index.sections.map((section) => [section.sectionRef, section]));
  const historical = new Set(input.historicalRefs ?? []);
  const refused: EvidenceRefusal[] = [];

  const build = (ref: string, extraConflictRefs: readonly string[]): EvidenceBuild | null => {
    const record = byRef.get(ref);
    if (!record) {
      return null;
    }
    return buildEvidenceItem({
      index: input.index,
      registry: input.registry,
      scope: input.scope,
      record,
      pageStatus: input.pageStatus[record.pageRelativePath] ?? null,
      historical: historical.has(ref),
      ...(input.verified ? { verified: input.verified } : {}),
      extraConflictRefs,
    });
  };

  // Reverse pairing: a section that declares a conflict AGAINST one of our
  // seeds makes that seed contested too, even though the seed itself says
  // nothing. Symmetry is the point — whichever side a reader reaches first
  // must show the disagreement.
  const reverse = new Map<string, string[]>();
  for (const section of input.index.sections) {
    for (const raw of parseEvidenceDeclarations(section.body).conflictRefs) {
      const target = normalizeSectionRef(raw, section.pageId);
      reverse.set(target, [...(reverse.get(target) ?? []), section.sectionRef]);
    }
  }

  const built = new Map<string, EvidenceItem>();
  const required = new Set<string>();
  const order: string[] = [];

  const consider = (ref: string, isRequired: boolean): void => {
    if (built.has(ref)) {
      if (isRequired) {
        required.add(ref);
      }
      return;
    }
    if (refused.some((entry) => entry.sectionRef === ref)) {
      return;
    }
    const result = build(ref, reverse.get(ref) ?? []);
    if (result === null) {
      return;
    }
    if (!result.ok) {
      refused.push(result.refusal);
      return;
    }
    built.set(ref, result.item);
    order.push(ref);
    if (isRequired) {
      required.add(ref);
    }
    for (const partner of result.conflictPartners) {
      // A conflict partner inherits the requiredness of the item it contests:
      // required, so the pair is delivered whole or the package overflows.
      consider(partner, isRequired);
    }
  };

  for (const seed of [...input.seeds].sort((a, b) => a.rank - b.rank)) {
    consider(seed.sectionRef, seed.rank === 0);
  }

  if (built.size === 0) {
    return {
      status: refused.length > 0 ? "insufficient-evidence" : "no-match",
      reason:
        refused.length > 0
          ? `every matching section was withheld: ${refused.map((entry) => entry.reason).join(" ")}`
          : "no wiki section matched with an addressable identity.",
      items: [],
      refused,
      omittedOptional: [...(input.preOmitted ?? [])],
      partial: (input.preOmitted?.length ?? 0) > 0,
      overflow: null,
      suggestion: "",
    };
  }

  // Required first, in rank order, then optional — the same ordering
  // `../gdgraph/repomap.ts` renders its required set in, and the ordering
  // `assembleContext` needs to report the FIRST required item that does not
  // fit rather than an arbitrary one.
  const candidateRefs = [
    ...order.filter((ref) => required.has(ref)),
    ...order.filter((ref) => !required.has(ref)),
  ];
  const candidates = candidateRefs.map((ref) => ({
    id: ref,
    required: required.has(ref),
    tokens: estimateEvidenceTokens(JSON.stringify(built.get(ref))),
  }));

  const assembly = assembleContext({
    candidates,
    maxItems: input.maxItems,
    maxTokens: input.maxTokens,
    traceRef: "",
    configurationRevision: "",
    policyRef: "",
    policyRevision: "",
    ...(input.preOmitted ? { omittedOptional: [...input.preOmitted] } : {}),
  });

  if ("code" in assembly) {
    const record = byRef.get(assembly.requiredId);
    return {
      status: "budget-exceeded",
      // Deliberately carries the ADDRESS and the title, never a slice of the
      // fragment: a "helpful" preview here would be the shortened rule the
      // criterion forbids, wearing an error's clothes.
      reason:
        `context_overflow: required evidence item "${assembly.requiredId}"` +
        (record ? ` (${titleOf(record)})` : "") +
        ` does not fit within the ${input.maxTokens}-token budget. It is not shortened to fit: a rule ` +
        "returned without its caveat, or cut mid-sentence, is worse than no answer.",
      items: [],
      refused,
      omittedOptional: [],
      partial: false,
      overflow: assembly,
      requiredRef: assembly.requiredId,
      suggestion:
        "Raise the budget, or narrow the question to one page or section, then retry. " +
        "The required set is delivered whole or not at all.",
    };
  }

  const items = assembly.selected
    .map((ref) => built.get(ref))
    .filter((item): item is EvidenceItem => item !== undefined);

  return {
    status: "ok",
    reason: "",
    items,
    refused,
    omittedOptional: assembly.omittedOptional,
    partial: assembly.partial,
    overflow: null,
    suggestion: "",
  };
}
