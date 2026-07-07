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
  kind: "metadata" | "version" | "link" | "index";
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
};

export type WikiCollectResult = {
  generatedAt: string;
  created: number;
  updated: number;
  skipped: number;
  pages: WikiCollectedPage[];
  index: WikiIndexResult;
};

export interface GdWikiService {
  status(input: WikiStatusInput): Promise<WikiStatusResult>;
  createPage(input: WikiCreatePageInput): Promise<WikiCreatePageResult>;
  generateIndex(input: WikiIndexInput): Promise<WikiIndexResult>;
  checkLinks(input: WikiCheckLinksInput): Promise<WikiCheckLinksResult>;
  validate(input: WikiValidateInput): Promise<WikiValidateResult>;
  collect(input: WikiCollectInput): Promise<WikiCollectResult>;
}
