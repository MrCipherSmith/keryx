// Declarations of conditional references, read from
// `.metaproject/rules/project/references.json` (schema 1):
//
//   { "schema": 1, "references": [
//     { "path": "STYLING.md",
//       "when": { "globs": ["src/**/*.css"], "keywords": ["className"] },
//       "anchor": "Class conventions",
//       "description": "What the document governs and when to read it." } ] }
//
// The resolver promotes a declared document to `must_read` when its condition
// matches the task; the validator checks the proof of reading against it. The
// committed JSON schema is docs/requirements/keryx-conditional-reads/schemas/
// references.schema.json and REFERENCES_SCHEMA mirrors it (a test keeps them
// equal). A missing file is "no declarations", not an error. Loading never
// throws: problems come back as messages that name the file and the entry.

import { readFile } from "node:fs/promises";
import path from "node:path";

export const REFERENCES_PATH = ".metaproject/rules/project/references.json";
export const REFERENCES_SCHEMA_VERSION = 1;

/** Where a declared document applies. At least one of the two lists is non-empty. */
export type ReferenceCondition = {
  /** Globs matched against the task's files. */
  globs: string[];
  /** Words matched against the task text. */
  keywords: string[];
};

export type ReferenceDeclaration = {
  /** Project-relative posix path, normalised, never absolute and never escaping the root. */
  path: string;
  when: ReferenceCondition;
  /** Heading text or slug of the section that matters; absent means the whole file. */
  anchor?: string;
  description: string;
};

export type ParseReferencesResult = { ok: true; references: ReferenceDeclaration[] } | { ok: false; errors: string[] };

export type LoadReferencesResult =
  | { ok: true; /** False when the file does not exist. */ present: boolean; references: ReferenceDeclaration[] }
  | { ok: false; errors: string[] };

export const REFERENCES_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://keryx.dev/schemas/references.schema.json",
  title: "Keryx conditional reference declarations",
  description:
    ".metaproject/rules/project/references.json. See README.md section 5.1. Each entry declares a document that project rules cite, where it applies (file globs and task keywords), the section that matters (anchor) and what it governs. A path must be relative and stay inside the project root; JSON Schema cannot express that normalisation, so the loader (src/gdskills/references-config.ts) also rejects a path that escapes the root.",
  type: "object",
  additionalProperties: false,
  required: ["schema", "references"],
  properties: {
    schema: { const: 1 },
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "when", "description"],
        properties: {
          path: {
            type: "string",
            minLength: 1,
            pattern: "^(?![/\\\\])(?![A-Za-z]:).+$",
            description: "Project-relative path of the document; absolute paths and paths escaping the root are rejected.",
          },
          when: {
            type: "object",
            additionalProperties: false,
            anyOf: [{ required: ["globs"] }, { required: ["keywords"] }],
            properties: {
              globs: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1, pattern: "\\S" },
                description: "Globs matched against the task's files; a match promotes the reference.",
              },
              keywords: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1, pattern: "\\S" },
                description: "Words matched case-insensitively, on a word boundary, against the task text.",
              },
            },
          },
          anchor: {
            type: "string",
            minLength: 1,
            pattern: "\\S",
            description: "Heading text or slug of the section that matters; without it the whole file is the obligation.",
          },
          description: {
            type: "string",
            minLength: 1,
            pattern: "\\S",
            description: "What the document governs and when to read it.",
          },
        },
      },
    },
  },
} as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(index: number, raw: Json): string {
  return typeof raw["path"] === "string" ? `references[${index}] ("${raw["path"]}")` : `references[${index}]`;
}

/** A project-relative posix path, or the reason it is not one. */
function normaliseRelativePath(raw: string): { path: string } | { problem: string } {
  const posix = raw.trim().replace(/\\/g, "/");
  if (posix === "") return { problem: "path is empty" };
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return { problem: "path is absolute; use a path relative to the project root" };
  const normal = path.posix.normalize(posix);
  if (normal === ".." || normal.startsWith("../")) return { problem: "path escapes the project root" };
  if (normal === ".") return { problem: "path names the project root, not a document" };
  return { path: normal };
}

function stringList(value: unknown, field: string, who: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${who}: when.${field} must be an array of non-empty strings`);
    return undefined;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${who}: when.${field} must hold only non-empty strings`);
      return undefined;
    }
    items.push(item.trim());
  }
  return items;
}

function parseWhen(value: unknown, who: string, errors: string[]): ReferenceCondition | undefined {
  if (!isObject(value)) {
    errors.push(`${who}: when must be an object with globs and/or keywords; a declaration with neither can never match`);
    return undefined;
  }
  const before = errors.length;
  for (const key of Object.keys(value)) {
    if (key !== "globs" && key !== "keywords") errors.push(`${who}: when has an unknown property "${key}"`);
  }
  const globs = stringList(value["globs"], "globs", who, errors);
  const keywords = stringList(value["keywords"], "keywords", who, errors);
  if (errors.length > before) return undefined;
  if ((globs ?? []).length === 0 && (keywords ?? []).length === 0) {
    errors.push(`${who}: when needs at least one of globs or keywords; a declaration with neither can never match`);
    return undefined;
  }
  for (const [field, list] of [["globs", globs], ["keywords", keywords]] as const) {
    if (list?.length === 0) errors.push(`${who}: when.${field} must not be empty; omit it instead`);
  }
  return errors.length > before ? undefined : { globs: globs ?? [], keywords: keywords ?? [] };
}

const ENTRY_KEYS = new Set(["path", "when", "anchor", "description"]);

function parseEntry(raw: unknown, index: number, errors: string[]): ReferenceDeclaration | undefined {
  if (!isObject(raw)) {
    errors.push(`references[${index}]: must be an object`);
    return undefined;
  }
  const who = label(index, raw);
  const before = errors.length;
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) errors.push(`${who}: unknown property "${key}"`);
  }

  let normalised: string | undefined;
  if (typeof raw["path"] !== "string") {
    errors.push(`${who}: path must be a string`);
  } else {
    const result = normaliseRelativePath(raw["path"]);
    if ("problem" in result) errors.push(`${who}: ${result.problem}`);
    else normalised = result.path;
  }

  const when = parseWhen(raw["when"], who, errors);

  let anchor: string | undefined;
  if (raw["anchor"] !== undefined) {
    if (typeof raw["anchor"] !== "string" || raw["anchor"].trim() === "") errors.push(`${who}: anchor must be a non-empty string when present`);
    else anchor = raw["anchor"].trim();
  }

  let description = "";
  if (typeof raw["description"] !== "string" || raw["description"].trim() === "") {
    errors.push(`${who}: description must be a non-empty string saying what the document governs`);
  } else {
    description = raw["description"].trim();
  }

  if (errors.length > before || normalised === undefined || when === undefined) return undefined;
  return { path: normalised, when, ...(anchor !== undefined ? { anchor } : {}), description };
}

/** Validate an already-parsed `references.json`. Every bad entry is reported, not only the first. */
export function parseReferences(input: unknown): ParseReferencesResult {
  if (!isObject(input)) return { ok: false, errors: ["references file must be a JSON object"] };
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (key !== "schema" && key !== "references") errors.push(`unknown property "${key}"`);
  }
  if (input["schema"] !== REFERENCES_SCHEMA_VERSION) {
    errors.push(`schema must be ${REFERENCES_SCHEMA_VERSION}; got ${JSON.stringify(input["schema"])}`);
  }
  const entries = input["references"];
  if (!Array.isArray(entries)) {
    errors.push("references must be an array");
    return { ok: false, errors };
  }
  const references: ReferenceDeclaration[] = [];
  entries.forEach((raw: unknown, index) => {
    const entry = parseEntry(raw, index, errors);
    if (entry !== undefined) references.push(entry);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, references };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Read and validate the project's declarations. A missing file is an empty list;
 * unreadable or invalid content is `ok: false` with messages that name the file
 * (and the entry, for a schema violation).
 */
export async function loadReferences(projectRoot: string): Promise<LoadReferencesResult> {
  let text: string;
  try {
    text = await readFile(path.join(projectRoot, REFERENCES_PATH), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { ok: true, present: false, references: [] };
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`${REFERENCES_PATH}: cannot be read (${reason})`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`${REFERENCES_PATH}: is not valid JSON (${reason})`] };
  }
  const result = parseReferences(parsed);
  if (!result.ok) return { ok: false, errors: result.errors.map((message) => `${REFERENCES_PATH}: ${message}`) };
  return { ok: true, present: true, references: result.references };
}
