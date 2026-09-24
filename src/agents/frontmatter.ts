// Frontmatter + body split for an agent-definition `.md` file, in the same
// spirit as `src/gdskills/skill-frontmatter.ts` (hand-rolled, forgiving,
// never throws) — but generalized to the agent-definition field shapes
// `SkillFrontmatter` never needed: string arrays (`tools`/`skills`/`stacks`,
// either a flow list `[a, b]` or a block list `- a\n  - b`), an integer
// (`schema_version`), and one nested mapping (`origin: { kind, sourceRef,
// generatedAt }`). `skill-frontmatter.ts` is not imported directly — its
// field set (`description`/`triggers`/`metadata`) is a different, narrower
// shape than this module needs — but the delimiter/quote-stripping approach
// below is the same one, deliberately.
//
// This is NOT a general YAML parser. It targets exactly the shapes
// `agent-definition.schema.json` declares. A line this module cannot make
// sense of is skipped rather than thrown on — the caller's schema validator
// (`schema.ts`) is what turns "field absent" into a named error; this module
// only turns text into data.

export interface ParsedAgentFrontmatter {
  /** Raw parsed frontmatter mapping, before schema validation. */
  readonly data: Record<string, unknown>;
  /** Markdown body after the closing `---` delimiter. */
  readonly body: string;
}

export type AgentFrontmatterParseErrorReason = "missing-delimiter" | "unterminated-block";

export interface AgentFrontmatterParseError {
  readonly reason: AgentFrontmatterParseErrorReason;
  readonly message: string;
}

export type AgentFrontmatterParseResult =
  | { readonly ok: true; readonly result: ParsedAgentFrontmatter }
  | { readonly ok: false; readonly error: AgentFrontmatterParseError };

/** Strip one layer of matching `"`/`'` quotes, if present. Mirrors `skill-frontmatter.ts`'s helper. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** `[a, "b", c]` → `["a", "b", "c"]`. Empty brackets yield `[]`. */
function parseFlowArray(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }
  return inner
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter((item) => item.length > 0);
}

const INDENTED_LINE = /^[ \t]+\S/;
const BLOCK_ITEM = /^[ \t]*-\s*(.*)$/;
const NESTED_KEY = /^[ \t]+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;

/**
 * Consume the indented block that follows an empty `key:` line (`startIndex`
 * is the first line after it): either a block list (`  - item`) or a
 * one-level nested mapping (`  subkey: value`, used only for `origin`).
 * Returns how many lines were consumed so the caller can advance past them.
 */
function parseIndentedBlock(
  lines: readonly string[],
  startIndex: number,
): { readonly value: string[] | Record<string, string> | undefined; readonly consumed: number } {
  const first = lines[startIndex];
  if (first === undefined || !INDENTED_LINE.test(first)) {
    return { value: undefined, consumed: 0 };
  }
  const isArray = BLOCK_ITEM.test(first) && !NESTED_KEY.test(first);
  let index = startIndex;
  if (isArray) {
    const items: string[] = [];
    while (index < lines.length) {
      const line = lines[index] ?? "";
      const match = BLOCK_ITEM.exec(line);
      if (match === null) break;
      items.push(stripQuotes((match[1] ?? "").trim()));
      index += 1;
    }
    return { value: items, consumed: index - startIndex };
  }
  const mapping: Record<string, string> = {};
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!INDENTED_LINE.test(line)) break;
    const match = NESTED_KEY.exec(line);
    if (match === null) break;
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (value.length > 0) {
      mapping[key] = stripQuotes(value);
    }
    index += 1;
  }
  return { value: mapping, consumed: index - startIndex };
}

const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;

/**
 * Split `content` into its `---`-delimited frontmatter mapping and the
 * Markdown body that follows. Never throws: a malformed frontmatter block
 * (no opening/closing delimiter) yields `{ ok: false }` with a named reason,
 * and any single unparsable line inside a well-delimited block is skipped
 * rather than failing the whole parse.
 */
export function parseAgentFrontmatter(content: string): AgentFrontmatterParseResult {
  if (!content.startsWith("---")) {
    return { ok: false, error: { reason: "missing-delimiter", message: "file does not open with a `---` frontmatter delimiter" } };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { ok: false, error: { reason: "unterminated-block", message: "frontmatter block has no closing `---` delimiter" } };
  }
  const afterDelimiter = end + 4; // length of "\n---"
  const bodyStart = content.indexOf("\n", afterDelimiter);
  const body = bodyStart === -1 ? "" : content.slice(bodyStart + 1);

  const lines = content.slice(3, end).split("\n");
  const data: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    const match = TOP_LEVEL_KEY.exec(line);
    if (match === null) {
      i += 1; // not a recognizable `key: value` line — skip it, forgivingly
      continue;
    }
    const key = match[1] ?? "";
    const rawValue = (match[2] ?? "").trim();

    if (rawValue.length === 0) {
      const { value, consumed } = parseIndentedBlock(lines, i + 1);
      if (value !== undefined) {
        data[key] = value;
      }
      i += 1 + consumed;
      continue;
    }
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      data[key] = parseFlowArray(rawValue);
      i += 1;
      continue;
    }
    if (/^-?\d+$/.test(rawValue)) {
      data[key] = Number.parseInt(rawValue, 10);
      i += 1;
      continue;
    }
    data[key] = stripQuotes(rawValue);
    i += 1;
  }

  return { ok: true, result: { data, body } };
}
