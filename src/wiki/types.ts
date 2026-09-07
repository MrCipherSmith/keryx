// AFC-06 (flow 234) T22: `LifecycleState` is the shared vocabulary a
// non-current wiki page or memory entry is labelled with in `wikiAsk`'s
// historical mode (see `WikiAskInput.asOf`/`WikiAskCitation.historical`
// below) -- carried verbatim from `computeLifecycle` (`../memory/lifecycle.ts`),
// never a second wiki-local set of state names.
import type { LifecycleState } from "../memory/lifecycle";

export type WikiPageType =
  | "architecture"
  | "domain-model"
  | "business-rule"
  | "user-scenario"
  | "component"
  | "service"
  | "integration"
  | "decision";

export type WikiPageTypeConfig = {
  type: WikiPageType;
  folder: string;
  purpose: string;
};

export const WIKI_PAGE_TYPES: WikiPageTypeConfig[] = [
  {
    type: "architecture",
    folder: "architecture",
    purpose: "system or module architecture",
  },
  {
    type: "domain-model",
    folder: "domain-models",
    purpose: "entities, invariants, relationships",
  },
  {
    type: "business-rule",
    folder: "business-rules",
    purpose: "business constraints and decisions",
  },
  {
    type: "user-scenario",
    folder: "user-scenarios",
    purpose: "user workflows and expected outcomes",
  },
  {
    type: "component",
    folder: "components",
    purpose: "UI/component behavior and ownership",
  },
  {
    type: "service",
    folder: "services",
    purpose: "backend/service responsibility and APIs",
  },
  {
    type: "integration",
    folder: "integrations",
    purpose: "external systems and contracts",
  },
  {
    type: "decision",
    folder: "decisions",
    purpose: "known decisions and ADR-like records",
  },
];

export const WIKI_PAGE_TYPE_VALUES: WikiPageType[] = WIKI_PAGE_TYPES.map(
  (entry) => entry.type,
);

export type WikiPage = {
  absolutePath: string;
  // Path relative to the wiki root, e.g. `business-rules/invoice-payment.md`.
  relativePath: string;
  pageType: WikiPageType;
  title: string;
  version: string | null;
  type: string | null;
  status: string | null;
  summary: string;
  // LWG-4 provenance (flow 223). Both live in the page's own frontmatter so
  // versioning never depends on whether the project versions `.metaproject/`
  // — or has git at all. Null means "never verified", which is NOT "fresh".
  verifiedAt?: string | null;
  verifiedScope?: string | null;
  /** Raw `Describes:` patterns as written; resolution lives in `describes.ts`. */
  describes?: string[];
  // AFC-06 (flow 234): the same event-time/supersession fields `MemoryEntry`
  // carries (`src/memory/types.ts`), mirrored here for lifecycle parity.
  // Populated by `collect.ts` (unhyphenated `ValidFrom`/`ValidTo`/
  // `SupersededBy` frontmatter) and classified through the shared
  // `computeLifecycle` (`../memory/lifecycle.ts`) so a page and a memory
  // entry admit/reject the same six input classes identically.
  validFrom?: string | null;
  validTo?: string | null;
  supersededBy?: string | null;
};

export type WikiStatusInput = { cwd: string };
export type WikiPageTypeCount = { type: WikiPageType; count: number };
export type WikiLinkCheckState = {
  generatedAt: string;
  broken: number;
  checkedPages: number;
  checkedLinks: number;
};
export type WikiStatusResult = {
  enabled: boolean;
  wikiRoot: string;
  totalPages: number;
  countsByType: WikiPageTypeCount[];
  lastIndexGeneratedAt: string | null;
  lastLinkCheck: WikiLinkCheckState | null;
};

export type WikiCreatePageInput = {
  cwd: string;
  type: string;
  slug: string;
  title?: string | undefined;
  force?: boolean | undefined;
};
export type WikiCreatePageResult = {
  path: string;
  type: WikiPageType;
  created: boolean;
};

export type WikiIndexInput = { cwd: string };
export type WikiIndexResult = {
  path: string;
  pageCount: number;
  generatedAt: string;
};

export type WikiCheckLinksInput = { cwd: string };
export type WikiBrokenLink = {
  page: string;
  target: string;
  reason: string;
};
export type WikiCheckLinksResult = {
  reportPath: string;
  checkedPages: number;
  checkedLinks: number;
  skippedExternal: number;
  broken: WikiBrokenLink[];
};

export type WikiValidateInput = { cwd: string };
export type WikiValidateIssue = {
  page: string;
  // `managed-block`, `describes` and `changelog` added by LWG-14 (flow 227):
  // structural rules the managed block makes checkable at all.
  kind: "metadata" | "version" | "link" | "index" | "managed-block" | "describes" | "changelog";
  message: string;
};
export type WikiValidateResult = {
  ok: boolean;
  issues: WikiValidateIssue[];
};

export type WikiCollectInput = {
  cwd: string;
  force?: boolean | undefined;
  limit?: number | undefined;
  changed?: boolean | undefined;
  since?: string | undefined;
};

export type WikiCollectedPage = {
  path: string;
  type: WikiPageType;
  source: "gdgraph" | "health" | "testing";
  action: "created" | "updated" | "skipped";
  // Set when the security gate (enforced/ci) suppressed this page's write.
  securityReason?: string;
};

export type WikiCollectResult = {
  generatedAt: string;
  created: number;
  updated: number;
  skipped: number;
  pages: WikiCollectedPage[];
  index: WikiIndexResult;
};

export type WikiAskInput = {
  cwd: string;
  question: string;
  k?: number | undefined;
  // Opt into a C1 embedding rerank of the deterministic citation set (when the
  // memory.embedding capability resolves). Default false ⇒ pure lexical.
  rerank?: boolean | undefined;
  // AFC-06 (flow 234) T22: wiki's explicit historical mode, spelled and
  // validated exactly like memory's `--as-of` (`SearchFilters.asOf`,
  // `../memory/types.ts`; `validateAsOf`, `../memory/temporal.ts`) rather than
  // a second idiom. Absent ⇒ default retrieval, byte-for-byte unchanged: only
  // current wiki pages/memory entries are admitted, exactly as before this
  // field existed. Present ⇒ policy's "История ... доступна только по явному
  // режиму" — both candidate sources also admit non-current items, classified
  // against this date instead of "today", and every non-current citation
  // carries its `historical`/`lifecycleState`/`lifecycleReasons` (see
  // `WikiAskCitation` below) so a reader can never mistake it for current
  // guidance.
  asOf?: string | undefined;
};
/**
 * AFC-07 / AFC-M03 (flow 235) T5. A retrieval outcome is a CODE, not a shape
 * the caller has to infer from an empty array. Before this, a zero-information
 * query, an unbuilt index and a genuine no-match all produced the same result
 * — and a stop-word-only query produced ranked citations and confident prose,
 * which is the same defect in its worse direction.
 */
export type WikiAskStatus = "ok" | "no-match" | "insufficient-evidence";

export type WikiAskCitation = {
  /** The owner page, wiki- or memory-relative. Unchanged by section indexing. */
  path: string;
  /** `Page › Section` for a wiki section — what distinguishes two identically titled sections. */
  title: string;
  excerpt: string;
  score: number;
  source: "wiki" | "memory";
  /** Which query terms hit. The reason, kept rather than computed and dropped. */
  matched?: string[];
  // AFC-W01 (flow 235) T5: present for a wiki citation, absent for a memory
  // one. `sectionRef` is the address `resolveSectionIdentity`
  // (`./section-tombstone.ts`) resolves — and refuses to substitute for.
  // `sectionStability` says how far it can be trusted: `stable` survives a
  // heading rename and a page-file rename; `version-bound` is the provisional
  // `pageVersion + heading occurrence + range` locator the spec allows for a
  // page that has not been migrated, and is explicitly not promised across an
  // edit.
  sectionId?: string;
  sectionRef?: string;
  sectionTitle?: string;
  sectionStability?: "stable" | "version-bound";
  contentClass?: "substantive" | "scaffold" | "reference";
  /** The wiki page type that owns the section — the domain filter's key. */
  domain?: string;
  startLine?: number;
  endLine?: number;
  // AFC-06 (flow 234) T22: set only when `WikiAskInput.asOf` was supplied AND
  // this citation is not current (`LifecycleResult.historical`,
  // `../memory/lifecycle.ts`). `lifecycleState`/`lifecycleReasons` are that
  // same call's `state`/`reasons`, carried verbatim -- the policy's "с полным
  // status" requirement -- never re-derived or re-worded here.
  historical?: boolean;
  lifecycleState?: LifecycleState;
  lifecycleReasons?: string[];
};
export type WikiAskResult = {
  question: string;
  /**
   * `ok` only when the citations below are evidence for the question asked.
   *
   * OPTIONAL only because this type is also the injection point for
   * `MetaprojectPort`'s wiki dependency (`WikiAskFacadeResult`,
   * `../harness/tool/metaproject-adapter.ts:46`), and a required field would
   * break hand-written stubs in a file another lane owns during this phase.
   * `wikiAsk` itself ALWAYS sets it; `undefined` means "a stub, not a real
   * retrieval". The guarantee does not depend on this field: a non-`ok`
   * outcome is rendered as a visible refusal carrying its code inside
   * `answerMarkdown`, which every surface — CLI, MCP and the agent op, whose
   * adapter narrows citations to five fields — passes through verbatim.
   * See the residual note in this task's report: making it required is a
   * one-line change once that stub gains `status: "ok"`.
   */
  status?: WikiAskStatus;
  /** Why, when `status` is not `ok`. Bounded and specific — never a full layer tour. */
  reason?: string;
  citations: WikiAskCitation[];
  // Assembled deterministically from the citations (C-6, C-8). When `status` is
  // not `ok` this is a visible refusal carrying the code, not ordinary prose.
  answerMarkdown: string;
};

export interface GdWikiService {
  status(input: WikiStatusInput): Promise<WikiStatusResult>;
  createPage(input: WikiCreatePageInput): Promise<WikiCreatePageResult>;
  generateIndex(input: WikiIndexInput): Promise<WikiIndexResult>;
  checkLinks(input: WikiCheckLinksInput): Promise<WikiCheckLinksResult>;
  validate(input: WikiValidateInput): Promise<WikiValidateResult>;
  collect(input: WikiCollectInput): Promise<WikiCollectResult>;
  ask(input: WikiAskInput): Promise<WikiAskResult>;
}
