// Authoring help for conditional references (flow 462): what `keryx skills
// references check|suggest` and the `skills import --rules` hint report.
//
// The analysis reads files and decides nothing about them: it compares the
// documents project rules cite (a backticked `X.md`) with the declarations in
// `.metaproject/rules/project/references.json`, and looks at each declared
// document. Expected failures come back as values (a finding, `ok: false`);
// nothing here throws for a missing or unreadable file.
//
// Citation scan. The resolver (context-resolver.ts) has its own scan for the
// contracts a *selected* rule cites; it is private to that module and another
// worker is editing it, so this one is a small independent copy of the same
// idea with two deliberate differences: it reads every rule under
// `.metaproject/rules/project/` (authoring is about the whole project, not one
// task), and it takes `.md` documents only, because a cited `.mdc` is another
// rule, not a document someone must be told to read. A linked rule (registered
// in place, not copied) is not scanned.

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../lib/fs";
import { CONTRACT_MAX_BYTES, listRuleRefs } from "./context-resolver";
import { PROJECT_RULES_DIR } from "./project-rules";
import { loadReferences, REFERENCES_PATH, type ReferenceDeclaration } from "./references-config";
import { extractSection, markdownHeadings } from "./references-section";

export const MIN_DESCRIPTION_CHARACTERS = 20;
export const MIN_KEYWORD_CHARACTERS = 4;
export const REFERENCES_SUGGEST_COMMAND = "keryx skills references suggest";

export type ReferencesFindingCode =
  | "invalid-file"
  | "document-missing"
  | "document-outside-root"
  | "document-not-file"
  | "document-too-large"
  | "document-unreadable"
  | "anchor-not-found"
  | "description-short"
  | "keyword-short"
  | "unused-declaration"
  | "undeclared-citation"
  | "rule-unreadable";

export type ReferencesFinding = {
  severity: "error" | "warning";
  code: ReferencesFindingCode;
  /** The declaration's path, the cited document's path, or the references file for `invalid-file`. */
  path: string;
  message: string;
};

export type ReferencesCheckReport = {
  schema: 1;
  /** True when there is no error; warnings never fail a run. */
  ok: boolean;
  /** False when `references.json` does not exist. */
  present: boolean;
  declared: number;
  errors: number;
  warnings: number;
  findings: ReferencesFinding[];
};

/** One undeclared citation, shaped like a `references.json` entry plus the facts that help fill it in. */
export type ReferenceSkeleton = {
  path: string;
  bytes: number;
  /** Heading texts of the document: candidates for `anchor`. Delete this field before pasting. */
  anchorCandidates: string[];
  description: "";
  when: { globs: string[]; keywords: string[] };
};

export type ReferencesSuggestion = { schema: 1; references: ReferenceSkeleton[] };

export type SuggestResult = { ok: true; suggestion: ReferencesSuggestion } | { ok: false; errors: string[] };

type Inspection =
  | { status: "ok"; bytes: number; text: string }
  | { status: "missing" | "outside-root" | "not-file" | "too-large" | "unreadable"; detail?: string };

const DOCUMENT_CITATION = /`([^`\s]+\.md)`/g;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const lengthOf = (text: string): number => [...text.trim()].length;
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A cited path as the project spells it: posix, normalised, never absolute and never climbing out of the root. */
function projectRelative(cited: string): string | undefined {
  const posix = cited.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return undefined;
  const normal = path.posix.normalize(posix);
  return normal === ".." || normal.startsWith("../") ? undefined : normal;
}

type CitationScan = {
  /** Every project-relative `.md` path a rule cites, with the rules that cite it. */
  cited: Map<string, string[]>;
  unreadableRules: string[];
};

async function scanCitations(projectRoot: string): Promise<CitationScan> {
  const cited = new Map<string, string[]>();
  const unreadableRules: string[] = [];
  for (const ref of (await listRuleRefs(projectRoot)).sort(compare)) {
    const rulePath = `${PROJECT_RULES_DIR}/${ref}`;
    let text: string;
    try {
      text = await readFile(path.join(projectRoot, rulePath), "utf8");
    } catch {
      unreadableRules.push(rulePath);
      continue;
    }
    for (const match of text.matchAll(DOCUMENT_CITATION)) {
      const relative = projectRelative(match[1] ?? "");
      if (relative === undefined) continue;
      const by = cited.get(relative) ?? [];
      if (!by.includes(rulePath)) by.push(rulePath);
      cited.set(relative, by);
    }
  }
  return { cited, unreadableRules };
}

async function inspectDocument(projectRoot: string, rootReal: string, relative: string): Promise<Inspection> {
  const absolute = path.join(projectRoot, relative);
  try {
    await lstat(absolute);
  } catch {
    return { status: "missing" };
  }
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return { status: "missing", detail: "a link that points nowhere" };
  }
  if (!isPathInside(rootReal, real)) return { status: "outside-root" };
  try {
    const info = await stat(real);
    if (!info.isFile()) return { status: "not-file" };
    if (info.size > CONTRACT_MAX_BYTES) return { status: "too-large", detail: `${info.size} bytes` };
    return { status: "ok", bytes: info.size, text: await readFile(real, "utf8") };
  } catch (error) {
    return { status: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
}

type Undeclared = { path: string; bytes: number; text: string };

/** Cited documents that exist inside the project, are not rules, and have no declaration. Sorted by path. */
async function undeclaredCitations(projectRoot: string, rootReal: string, cited: ReadonlyMap<string, string[]>, declared: ReadonlySet<string>): Promise<Undeclared[]> {
  const found: Undeclared[] = [];
  for (const relative of [...cited.keys()].sort(compare)) {
    // A `.md` file under the rules folder is a rule, not a document someone must be told to read.
    if (declared.has(relative) || relative.startsWith(".metaproject/rules/")) continue;
    const inspection = await inspectDocument(projectRoot, rootReal, relative);
    if (inspection.status === "ok") found.push({ path: relative, bytes: inspection.bytes, text: inspection.text });
  }
  return found;
}

const rootRealPath = async (projectRoot: string): Promise<string> => realpath(projectRoot).catch(() => projectRoot);

function documentProblem(declaration: ReferenceDeclaration, inspection: Exclude<Inspection, { status: "ok" }>): ReferencesFinding {
  const where = declaration.path;
  switch (inspection.status) {
    case "missing":
      return { severity: "error", code: "document-missing", path: where, message: `the declared document does not exist${inspection.detail ? ` (${inspection.detail})` : ""}; fix the path or remove the declaration` };
    case "outside-root":
      return { severity: "error", code: "document-outside-root", path: where, message: "the declared document resolves outside the project root; a link out of the project is not followed" };
    case "not-file":
      return { severity: "error", code: "document-not-file", path: where, message: "the declared path is not a regular file" };
    case "too-large":
      return { severity: "error", code: "document-too-large", path: where, message: `the declared document is larger than ${CONTRACT_MAX_BYTES} bytes (${inspection.detail ?? "too large"}); split it or declare a smaller one` };
    case "unreadable":
      return { severity: "error", code: "document-unreadable", path: where, message: `the declared document cannot be read (${inspection.detail ?? "unknown reason"})` };
  }
}

function declarationFindings(declaration: ReferenceDeclaration, inspection: Inspection, cited: ReadonlyMap<string, string[]>): ReferencesFinding[] {
  const findings: ReferencesFinding[] = [];
  const where = declaration.path;
  if (inspection.status !== "ok") findings.push(documentProblem(declaration, inspection));
  else if (declaration.anchor !== undefined) {
    const section = extractSection(inspection.text, declaration.anchor);
    if (!section.found) {
      const headings = markdownHeadings(inspection.text).map((heading) => heading.text);
      const shown = headings.slice(0, 12).join(", ");
      findings.push({
        severity: "error",
        code: "anchor-not-found",
        path: where,
        message: `anchor "${declaration.anchor}" matches no heading${headings.length > 0 ? `; the document has: ${shown}${headings.length > 12 ? ", ..." : ""}` : "; the document has no headings"}`,
      });
    }
  }
  if (lengthOf(declaration.description) < MIN_DESCRIPTION_CHARACTERS) {
    findings.push({ severity: "warning", code: "description-short", path: where, message: `description is under ${MIN_DESCRIPTION_CHARACTERS} characters; say what the document governs and when to read it` });
  }
  for (const keyword of declaration.when.keywords) {
    if (lengthOf(keyword) < MIN_KEYWORD_CHARACTERS) {
      findings.push({ severity: "warning", code: "keyword-short", path: where, message: `keyword "${keyword}" is under ${MIN_KEYWORD_CHARACTERS} characters and would match unrelated tasks` });
    }
  }
  if (!cited.has(where)) {
    findings.push({ severity: "warning", code: "unused-declaration", path: where, message: "no project rule cites this document; the declaration works, but nothing points a reader at it" });
  }
  return findings;
}

function report(present: boolean, declared: number, findings: ReferencesFinding[]): ReferencesCheckReport {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  return { schema: 1, ok: errors === 0, present, declared, errors, warnings: findings.length - errors, findings };
}

/** Check the declarations against the files on disk and the citations in the project rules. */
export async function checkReferences(projectRoot: string): Promise<ReferencesCheckReport> {
  const loaded = await loadReferences(projectRoot);
  if (!loaded.ok) {
    return report(true, 0, loaded.errors.map((message): ReferencesFinding => ({ severity: "error", code: "invalid-file", path: REFERENCES_PATH, message })));
  }
  const rootReal = await rootRealPath(projectRoot);
  const { cited, unreadableRules } = await scanCitations(projectRoot);
  const findings: ReferencesFinding[] = [];
  for (const declaration of loaded.references) {
    findings.push(...declarationFindings(declaration, await inspectDocument(projectRoot, rootReal, declaration.path), cited));
  }
  const declared = new Set(loaded.references.map((declaration) => declaration.path));
  for (const missing of await undeclaredCitations(projectRoot, rootReal, cited, declared)) {
    findings.push({
      severity: "warning",
      code: "undeclared-citation",
      path: missing.path,
      message: `cited by ${(cited.get(missing.path) ?? []).join(", ")} but not declared in ${REFERENCES_PATH}; run \`${REFERENCES_SUGGEST_COMMAND}\``,
    });
  }
  for (const rule of unreadableRules) {
    findings.push({ severity: "warning", code: "rule-unreadable", path: rule, message: "the rule cannot be read, so the documents it cites were not checked" });
  }
  return report(loaded.present, loaded.references.length, findings);
}

/** A skeleton `references.json` entry for every undeclared citation. Reads files, writes none. */
export async function suggestReferences(projectRoot: string): Promise<SuggestResult> {
  const loaded = await loadReferences(projectRoot);
  if (!loaded.ok) return { ok: false, errors: loaded.errors };
  const { cited } = await scanCitations(projectRoot);
  const declared = new Set(loaded.references.map((declaration) => declaration.path));
  const missing = await undeclaredCitations(projectRoot, await rootRealPath(projectRoot), cited, declared);
  return {
    ok: true,
    suggestion: {
      schema: 1,
      references: missing.map((entry) => ({
        path: entry.path,
        bytes: entry.bytes,
        anchorCandidates: markdownHeadings(entry.text).map((heading) => heading.text),
        description: "" as const,
        when: { globs: [], keywords: [] },
      })),
    },
  };
}

/**
 * The lines `skills import --rules` ends with when documents are cited but not
 * declared; empty when there are none, or when `references.json` is invalid
 * (`check` reports that, and a count taken without knowing what is declared
 * would be a guess).
 */
export async function undeclaredCitationHint(projectRoot: string): Promise<string[]> {
  const result = await suggestReferences(projectRoot);
  if (!result.ok || result.suggestion.references.length === 0) return [];
  const count = result.suggestion.references.length;
  return [`${plural(count, "cited document")} ${count === 1 ? "has" : "have"} no declaration in ${REFERENCES_PATH}.`, `Run: ${REFERENCES_SUGGEST_COMMAND}`];
}
