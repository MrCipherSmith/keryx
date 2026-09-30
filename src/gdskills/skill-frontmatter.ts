/**
 * The one reader of a `SKILL.md`'s frontmatter.
 *
 * Every consumer that needs a frontmatter field — the catalog, the bundled-tree
 * validator, the importer, the review inventory, `review jev-rules`, the stack
 * gate — reads it through this module. When each owned its own parse they
 * drifted, and every fix to one parse left the others on the old behaviour:
 *
 * - the validator checked that a `description:` line existed while the runtime
 *   read only that line's text, and 15 bundled skills whose description was a
 *   YAML block scalar shipped with the catalog serving the bare indicator "|";
 * - a CRLF or BOM file had "no frontmatter" in some readers and not others, so
 *   `metadata.category: quality` was lost and the package landed in `review`;
 * - a trailing `# comment` became flags and path triggers in one reader;
 * - `metadata.paths` as a block list gated a reviewer in the inventory and was
 *   ignored by `review jev-rules`.
 *
 * It is deliberately a reader for the YAML subset these files use, not a YAML
 * implementation (the package has no runtime dependencies by policy):
 *
 * - the block opens with a `---` line at the very start of the file (a leading
 *   BOM is ignored) and closes at the next `---` line; `\r\n` reads as `\n`;
 * - top-level `key: value` pairs, and one level of nested mapping under a key
 *   with no value — `metadata:` is the one consumers ask about. Only keys at the
 *   mapping's own indentation are its fields; deeper keys belong to a nested
 *   mapping and are never read as the parent's;
 * - a value is a plain or quoted scalar (one layer of matching quotes removed,
 *   no escape processing), a flow list `[a, "b"]`, a block list of `- item`
 *   lines (an empty `-` item is skipped), or a block scalar `|` / `>` folded to
 *   one line;
 * - a `#` that starts the value or follows whitespace, outside quotes, starts a
 *   comment and is dropped — except inside a block scalar, where it is text;
 * - the first occurrence of a duplicated key wins.
 *
 * Anything else — flow mappings, nested flow lists, anchors, multi-line quoted
 * scalars — reads as "unsupported" and yields nothing rather than a guess.
 *
 * Lives in `gdskills` because that is the lower layer: `review`, `harness` and
 * `commands` import from here, never the other way round.
 */

/** A frontmatter value in the supported subset. */
export type FrontmatterValue =
  /** A scalar on the key's own line: comment dropped, quotes removed. `""` when the key has no value. */
  | { readonly kind: "scalar"; readonly text: string }
  /** A flow list or a block list, items unquoted and empty items dropped. */
  | { readonly kind: "list"; readonly items: readonly string[] }
  /** A `|` / `>` block scalar, its lines trimmed and folded to one line. */
  | { readonly kind: "block"; readonly text: string }
  /** A nested block mapping: only the keys at its own indentation. */
  | { readonly kind: "mapping"; readonly fields: FrontmatterFields }
  /** A shape outside the subset. Consumers read it as "not declared". */
  | { readonly kind: "unsupported" };

export type FrontmatterFields = ReadonlyMap<string, FrontmatterValue>;

/** Where a field sits: at the frontmatter's top level, or directly under `metadata:`. */
export type FrontmatterScope = "top" | "metadata";

/**
 * The lines between the opening and closing `---` fences, without their line
 * endings — or `undefined` when the file does not open with a fence, or the
 * fence is never closed.
 */
export function frontmatterLines(content: string): string[] | undefined {
  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  return close === -1 ? undefined : lines.slice(1, close);
}

/** The top-level fields of the frontmatter, or `undefined` when there is none. */
export function readFrontmatter(content: string): FrontmatterFields | undefined {
  const lines = frontmatterLines(content);
  return lines === undefined ? undefined : readMapping(lines, 0);
}

/** One field, top-level or directly under `metadata:`. */
export function frontmatterField(content: string, key: string, scope: FrontmatterScope = "top"): FrontmatterValue | undefined {
  const top = readFrontmatter(content);
  if (top === undefined) return undefined;
  if (scope === "top") return top.get(key);
  const metadata = top.get("metadata");
  return metadata?.kind === "mapping" ? metadata.fields.get(key) : undefined;
}

/**
 * A field's text when it is a scalar or a block scalar; `undefined` when it is
 * absent, a list, a mapping or unsupported. A key with no value reads as `""`.
 */
export function frontmatterScalar(content: string, key: string, scope: FrontmatterScope = "top"): string | undefined {
  return scalarText(frontmatterField(content, key, scope));
}

/**
 * The entries of a list-valued field: a flow list, a block list, or a
 * comma-separated scalar (`paths: "a, b"`), each entry trimmed and unquoted.
 * Every other shape — and an absent field — is `[]`.
 */
export function frontmatterList(content: string, key: string, scope: FrontmatterScope = "top"): string[] {
  return listItems(frontmatterField(content, key, scope));
}

/** {@link frontmatterList} under `metadata:`. */
export function metadataList(content: string, key: string): string[] {
  return frontmatterList(content, key, "metadata");
}

function scalarText(value: FrontmatterValue | undefined): string | undefined {
  return value?.kind === "scalar" || value?.kind === "block" ? value.text : undefined;
}

function listItems(value: FrontmatterValue | undefined): string[] {
  if (value?.kind === "list") return [...value.items];
  if (value?.kind === "scalar") return splitOutsideQuotes(value.text).map(unquote).filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// The reader.
// ---------------------------------------------------------------------------

const KEY_LINE = /^("[^"]*"|'[^']*'|[^\s#"'\-[\]{},:][^:]*?):(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^-(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR = /^[|>][-+]?[0-9]?$/;

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

/** Blank, or nothing but a comment. */
function isFiller(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * The block mapping whose keys sit at `indent`. A line at any other
 * indentation that is not inside a key's value is outside the subset and
 * skipped, never read as a key of this mapping.
 */
function readMapping(lines: readonly string[], indent: number): Map<string, FrontmatterValue> {
  const fields = new Map<string, FrontmatterValue>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    index += 1;
    if (isFiller(line) || indentOf(line) !== indent) continue;
    const match = KEY_LINE.exec(line.slice(indent));
    if (match === null) continue;
    // The key's value runs over the lines indented under it, and over `- item`
    // lines at its own indentation (YAML allows a list there).
    const start = index;
    while (index < lines.length) {
      const next = lines[index] as string;
      const nextIndent = indentOf(next);
      if (isFiller(next) || nextIndent > indent || (nextIndent === indent && LIST_ITEM.test(next.slice(nextIndent)))) {
        index += 1;
      } else {
        break;
      }
    }
    const key = unquote(match[1] as string);
    if (!fields.has(key)) fields.set(key, readValue(match[2] ?? "", lines.slice(start, index), indent));
  }
  return fields;
}

function readValue(rest: string, children: readonly string[], keyIndent: number): FrontmatterValue {
  const text = stripTrailingComment(rest);
  if (BLOCK_SCALAR.test(text)) {
    // A line at or left of the key's indentation inside the run is a comment line.
    const body = children.filter((line) => line.trim() === "" || indentOf(line) > keyIndent);
    return { kind: "block", text: body.map((line) => line.trim()).join(" ").replace(/\s+/g, " ").trim() };
  }
  if (text.startsWith("[")) return readFlowList(text);
  if (text.startsWith("{") || text.startsWith("&") || text.startsWith("*") || text.startsWith("!")) {
    return { kind: "unsupported" };
  }
  if (text !== "") return { kind: "scalar", text: unquote(text) };
  const first = children.find((line) => !isFiller(line));
  if (first === undefined) return { kind: "scalar", text: "" };
  const firstIndent = indentOf(first);
  if (LIST_ITEM.test(first.slice(firstIndent))) return readBlockList(children, keyIndent);
  // A multi-line plain scalar starting on the next line is outside the subset.
  if (!KEY_LINE.test(first.slice(firstIndent))) return { kind: "unsupported" };
  return { kind: "mapping", fields: readMapping(children, firstIndent) };
}

/**
 * `- item` lines at or right of the key's indentation. The list ends at the
 * first line that is not one; an empty `-` item is skipped, not an end.
 */
function readBlockList(children: readonly string[], keyIndent: number): FrontmatterValue {
  const items: string[] = [];
  for (const line of children) {
    if (isFiller(line)) continue;
    const lineIndent = indentOf(line);
    const item = lineIndent >= keyIndent ? LIST_ITEM.exec(line.slice(lineIndent)) : null;
    if (item === null) break;
    const text = stripTrailingComment(item[1] ?? "");
    if (text.startsWith("[") || text.startsWith("{")) return { kind: "unsupported" };
    const entry = unquote(text);
    if (entry !== "") items.push(entry);
  }
  return { kind: "list", items };
}

function readFlowList(text: string): FrontmatterValue {
  if (!text.endsWith("]")) return { kind: "unsupported" };
  const inner = text.slice(1, -1);
  const entries = splitOutsideQuotes(inner);
  if (entries.some((entry) => /^[[{]/.test(entry.trim()))) return { kind: "unsupported" };
  return { kind: "list", items: entries.map(unquote).filter(Boolean) };
}

/** Is `index` the start of a token — the value's start, or right after whitespace or flow punctuation? */
function atTokenStart(text: string, index: number): boolean {
  return index === 0 || /[\s[{,]/.test(text[index - 1] as string);
}

/**
 * The value without a trailing YAML comment. A `#` starts a comment when it
 * opens the value or follows whitespace, outside a quoted scalar; a quote only
 * opens a quoted scalar at the start of a token (`it's` is plain text).
 */
export function stripTrailingComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) {
        if (quote === "'" && value[index + 1] === "'") index += 1;
        else quote = undefined;
      }
      continue;
    }
    if ((char === '"' || char === "'") && atTokenStart(value, index)) quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(value[index - 1] as string))) return value.slice(0, index).trim();
  }
  return value.trim();
}

/** Split on commas that are outside quoted scalars. */
function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if ((char === '"' || char === "'") && current.trim() === "") {
      quote = char;
    } else if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Trimmed, with one layer of matching `"` / `'` quotes removed. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// The routing projection the catalog and the bundled-tree validator share.
// ---------------------------------------------------------------------------

/** What a `SKILL.md`'s frontmatter declares for routing. Every field optional. */
export interface SkillFrontmatter {
  /** The top-level `name:` scalar, when declared. */
  readonly name?: string;
  /** The routing text, block scalars folded to one line. */
  readonly description?: string;
  /** The `triggers:` list, in declaration order. */
  readonly triggers?: string[];
  /** `metadata.category`, whatever shape it was declared in. */
  readonly metadataCategory?: string;
  /** `metadata.version`, as the skill's author declared it. */
  readonly metadataVersion?: string;
  /**
   * `metadata.origin` — provenance (W1 authoring standard):
   * `authored | generated | imported | learned`. Read as a free-form string;
   * the closed-set check belongs to the authoring lint, not this parser.
   */
  readonly metadataOrigin?: string;
  /**
   * `metadata.compatible_harnesses`, split into individual harness names
   * regardless of whether the source wrote a quoted comma-separated scalar
   * (`"cursor,codex,claude"`, the shape every shipped skill uses today), a
   * flow list (`[cursor, codex, claude]`), or a YAML block list (one `- name`
   * per line). All three are valid YAML for the same field; a caller that
   * only understood the first would silently stop checking a skill the
   * moment it — or a future one — used either of the other two.
   */
  readonly compatibleHarnesses?: string[];
}

/** A metadata scalar that is declared with a value; `""` reads as not declared. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Forgiving projection of a SKILL.md's routing and metadata fields. Never
 * throws: a malformed or absent frontmatter block yields `{}`, degrading that
 * one catalog entry rather than failing the whole `skillsCatalog` call.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const top = readFrontmatter(content);
  if (top === undefined) return {};
  const metadataValue = top.get("metadata");
  const metadata: FrontmatterFields = metadataValue?.kind === "mapping" ? metadataValue.fields : new Map();

  const name = scalarText(top.get("name"));
  const description = scalarText(top.get("description"));
  const triggersValue = top.get("triggers");
  const triggers = triggersValue?.kind === "list" ? [...triggersValue.items] : [];
  const metadataCategory = nonEmpty(scalarText(metadata.get("category")));
  const metadataVersion = nonEmpty(scalarText(metadata.get("version")));
  const metadataOrigin = nonEmpty(scalarText(metadata.get("origin")));
  const harnessesValue = metadata.get("compatible_harnesses");
  const compatibleHarnesses =
    harnessesValue?.kind === "list" || (harnessesValue?.kind === "scalar" && harnessesValue.text !== "")
      ? listItems(harnessesValue)
      : undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(metadataCategory !== undefined ? { metadataCategory } : {}),
    ...(metadataVersion !== undefined ? { metadataVersion } : {}),
    ...(metadataOrigin !== undefined ? { metadataOrigin } : {}),
    ...(compatibleHarnesses !== undefined ? { compatibleHarnesses } : {}),
  };
}
