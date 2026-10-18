// Turns the project's declared conditional references into resolver entries.
//
// A declared document is listed whether or not a rule cites it. It is promoted to
// `must_read` when a glob of its condition matches a task file or a keyword of its
// condition occurs in the task text; otherwise it stays `on_demand` with its
// description, anchor and condition so the worker can see why it was not required.
// With an anchor the obligation is the anchored section; a dead anchor falls back
// to the whole file with a warning, never silently.

import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../lib/fs";
import { matchesAnyGlobWithBraces } from "../lib/glob";
import type { ContextEntry } from "./context-resolver";
import { sha256Hex } from "./project-rules";
import { REFERENCES_PATH, type ReferenceDeclaration } from "./references-config";
import { extractSection } from "./references-section";

export type ResolveReferencesInput = {
  projectRoot: string;
  declarations: readonly ReferenceDeclaration[];
  /** Normalised project-relative task files. */
  files: readonly string[];
  /** The task text, already truncated; matched against keywords. */
  taskText: string;
  /** Paths already listed as rules, skills or bundled rules; a declaration naming one is skipped with a warning. */
  taken: ReadonlySet<string>;
  /** A declared file bigger than this is not listed. */
  maxFileBytes: number;
};

export type ResolvedReferences = {
  entries: ContextEntry[];
  /** Bytes the promoted entries oblige the worker to read (section bytes with an anchor, file bytes without). */
  promotedBytes: number;
  warnings: string[];
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const WORD_CHAR = /^[\p{L}\p{N}_]$/u;

/**
 * Case-insensitive, whole-word match; "word" characters are letters, digits and underscore of any script.
 * A boundary is demanded only on a side where the keyword itself starts or ends with a word character,
 * so `.css`, `@apply` and `c++` match where they stand while `css` does not match inside `css3`.
 */
export function keywordOccurs(text: string, keyword: string): boolean {
  if (keyword === "") return false;
  const chars = Array.from(keyword);
  const before = WORD_CHAR.test(chars[0] ?? "") ? "(?<![\\p{L}\\p{N}_])" : "";
  const after = WORD_CHAR.test(chars[chars.length - 1] ?? "") ? "(?![\\p{L}\\p{N}_])" : "";
  return new RegExp(`${before}${escapeRegExp(keyword)}${after}`, "iu").test(text);
}

/** The reason a declaration is promoted, or undefined when its condition does not match. Globs are tried before keywords. */
export function promotionReason(declaration: ReferenceDeclaration, files: readonly string[], taskText: string): string | undefined {
  const glob = declaration.when.globs.find((candidate) => files.some((file) => matchesAnyGlobWithBraces(file, [candidate])));
  if (glob !== undefined) return `condition:glob:${glob}`;
  const keyword = declaration.when.keywords.find((candidate) => keywordOccurs(taskText, candidate));
  return keyword !== undefined ? `condition:keyword:${keyword}` : undefined;
}

type ReadOutcome = { ok: true; text: string } | { ok: false; why: string };

async function readDeclaredFile(projectRoot: string, rootReal: string, rel: string, maxFileBytes: number): Promise<ReadOutcome> {
  const absolute = path.join(projectRoot, rel);
  let real: string;
  try {
    await lstat(absolute);
    real = await realpath(absolute);
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return { ok: false, why: "does not exist" };
    return { ok: false, why: `cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isPathInside(rootReal, real)) return { ok: false, why: "resolves outside the project root" };
  try {
    const info = await lstat(real);
    if (!info.isFile()) return { ok: false, why: "is not a regular file" };
    if (info.size > maxFileBytes) return { ok: false, why: `is larger than ${maxFileBytes} bytes` };
    return { ok: true, text: await readFile(real, "utf8") };
  } catch (error) {
    return { ok: false, why: `cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

export async function resolveReferences(input: ResolveReferencesInput): Promise<ResolvedReferences> {
  const warnings: string[] = [];
  const entries: ContextEntry[] = [];
  let promotedBytes = 0;
  const rootReal = await realpath(input.projectRoot).catch(() => input.projectRoot);

  for (const declaration of input.declarations) {
    const reject = (why: string): void => void warnings.push(`${declaration.path}: declared in ${REFERENCES_PATH} but ${why}; not listed.`);
    if (input.taken.has(declaration.path)) {
      reject("is already listed as a project rule or skill");
      continue;
    }
    const read = await readDeclaredFile(input.projectRoot, rootReal, declaration.path, input.maxFileBytes);
    if (!read.ok) {
      reject(read.why);
      continue;
    }
    const bytes = Buffer.byteLength(read.text);
    let sectionBytes: number | undefined;
    if (declaration.anchor !== undefined) {
      const section = extractSection(read.text, declaration.anchor);
      if (section.found) sectionBytes = section.bytes;
      else {
        sectionBytes = bytes;
        const headings = section.available.length > 0 ? ` Headings in the file: ${section.available.join("; ")}.` : "";
        warnings.push(
          `${declaration.path}: anchor "${declaration.anchor}" not found (${section.reason}); the whole file (${bytes} bytes) is the obligation.${headings} Fix the anchor in ${REFERENCES_PATH}.`,
        );
      }
    }
    const reason = promotionReason(declaration, input.files, input.taskText);
    if (reason !== undefined) promotedBytes += sectionBytes ?? bytes;
    entries.push({
      kind: "contract",
      source: "project",
      path: declaration.path,
      sha256: sha256Hex(read.text),
      bytes,
      reason: reason ?? "declared",
      tier: reason !== undefined ? "must_read" : "on_demand",
      description: declaration.description,
      ...(declaration.anchor !== undefined ? { anchor: declaration.anchor } : {}),
      ...(sectionBytes !== undefined ? { section_bytes: sectionBytes } : {}),
      condition: { globs: declaration.when.globs, keywords: declaration.when.keywords },
    });
  }
  return { entries, promotedBytes, warnings };
}
