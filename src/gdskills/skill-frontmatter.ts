/**
 * The one parse of a `SKILL.md`'s routing frontmatter.
 *
 * Two callers read these fields for two different reasons, and they must not
 * drift: `metaproject-adapter` SERVES them to an agent through `skills_catalog`,
 * and `bundled-eval` VALIDATES them before the tree ships. When each owned its
 * own parse they did drift — the validator checked that a `description:` line
 * existed, the runtime read only that line's text, and 15 bundled skills whose
 * description was a YAML block scalar shipped with the catalog serving the bare
 * indicator "|". The sweep reported `frontmatter:description: pass` the whole
 * time. A validator that cannot see what the runtime sees is not a validator,
 * so both now call this.
 *
 * Lives in `gdskills` because that is the lower layer: `harness` imports from
 * here, not the other way round.
 */

/** Strip a single layer of matching `"`/`'` quotes, if present. */
function stripSkillFieldQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** What a `SKILL.md`'s frontmatter declares for routing. Both fields optional. */
export interface SkillFrontmatter {
  /** The routing text, block scalars folded to one line. */
  readonly description?: string;
  /** The `triggers:` list, in declaration order. */
  readonly triggers?: string[];
  /** `metadata.category`, whatever shape it was declared in. */
  readonly metadataCategory?: string;
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

/** Split a comma-separated scalar (already unquoted) into trimmed, non-empty names. */
function splitHarnessScalar(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * `compatible_harnesses`'s value on the SAME line as its key, in either of
 * the two single-line shapes it may take: a flow list (`[a, b]`) or a
 * (usually quoted) comma-separated scalar. `undefined` when `value` is empty
 * — the caller is left to decide that means "look for a block list next".
 */
function parseInlineHarnesses(value: string): string[] | undefined {
  if (value.length === 0) return undefined;
  const flowList = /^\[(.*)\]$/.exec(value);
  if (flowList !== null) {
    return splitHarnessScalar((flowList[1] ?? "").replace(/["']/g, ""));
  }
  return splitHarnessScalar(stripSkillFieldQuotes(value));
}

/**
 * Forgiving frontmatter parse for a SKILL.md's routing and metadata fields.
 * Never throws: a malformed or absent frontmatter block yields `{}`, degrading
 * that one catalog entry rather than failing the whole `skillsCatalog` call.
 *
 * `description` takes either a plain scalar or a YAML block scalar (`|`/`>`,
 * with an optional `-`/`+` chomping indicator) whose text sits on the following
 * indented lines. `metadata.category` and `metadata.compatible_harnesses` are
 * read from inside the `metadata:` mapping, wherever it opens.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  if (!content.startsWith("---")) {
    return {};
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  const lines = content.slice(3, end).split("\n");
  let description: string | undefined;
  const triggers: string[] = [];
  let inTriggers = false;
  let inMetadata = false;
  let metadataCategory: string | undefined;
  let compatibleHarnesses: string[] | undefined;
  /** True on the line right after an empty `compatible_harnesses:`, looking for a block list next. */
  let awaitingHarnessesList = false;
  /** Collected lines of an open block scalar, or `null` when none is open. */
  let descriptionBlock: string[] | null = null;

  /** Join a block scalar's lines into one line, the shape a catalog row wants. */
  const foldBlock = (block: string[]): string => block.join(" ").replace(/\s+/g, " ").trim();

  for (const line of lines) {
    if (descriptionBlock !== null) {
      // The block runs until the first line that is neither blank nor indented.
      if (line.trim() === "" || /^\s/.test(line)) {
        descriptionBlock.push(line.trim());
        continue;
      }
      description = foldBlock(descriptionBlock);
      descriptionBlock = null;
    }
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch !== null && descMatch[1] !== undefined) {
      const value = descMatch[1].trim();
      if (/^[|>][-+]?$/.test(value)) {
        descriptionBlock = [];
      } else {
        description = stripSkillFieldQuotes(value);
      }
      inTriggers = false;
      inMetadata = false;
      awaitingHarnessesList = false;
      continue;
    }
    if (/^triggers:\s*$/.test(line)) {
      inTriggers = true;
      inMetadata = false;
      awaitingHarnessesList = false;
      continue;
    }
    if (inTriggers) {
      const itemMatch = /^\s+-\s*(.+)$/.exec(line);
      if (itemMatch !== null && itemMatch[1] !== undefined) {
        triggers.push(stripSkillFieldQuotes(itemMatch[1].trim()));
        continue;
      }
      inTriggers = false;
    }
    // A block list continuing from an empty `compatible_harnesses:` line,
    // checked ahead of the top-level-key test below so a `- name` item (no
    // colon of its own) is not mistaken for the mapping having ended.
    if (awaitingHarnessesList) {
      const itemMatch = /^\s+-\s*(.+)$/.exec(line);
      if (itemMatch !== null && itemMatch[1] !== undefined) {
        (compatibleHarnesses ??= []).push(stripSkillFieldQuotes(itemMatch[1].trim()));
        continue;
      }
      awaitingHarnessesList = false;
    }
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    if (inMetadata) {
      // The mapping ends at the first line that is not indented under it —
      // a blank line does not end it (YAML permits blank lines inside a
      // block mapping), but a new top-level key or the body starting does.
      if (line.trim() !== "" && !/^\s/.test(line)) {
        inMetadata = false;
      } else {
        const categoryMatch = /^\s+category:\s*(.+)$/.exec(line);
        if (categoryMatch !== null && categoryMatch[1] !== undefined) {
          metadataCategory = stripSkillFieldQuotes(categoryMatch[1].trim());
          continue;
        }
        const harnessesMatch = /^\s+compatible_harnesses:\s*(.*)$/.exec(line);
        if (harnessesMatch !== null) {
          const inline = parseInlineHarnesses((harnessesMatch[1] ?? "").trim());
          if (inline !== undefined) {
            compatibleHarnesses = inline;
          } else {
            // Empty value on this line: a block list may follow, one `- name` per line.
            awaitingHarnessesList = true;
          }
          continue;
        }
      }
    }
  }
  if (descriptionBlock !== null) {
    description = foldBlock(descriptionBlock);
  }
  return {
    ...(description !== undefined ? { description } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(metadataCategory !== undefined ? { metadataCategory } : {}),
    ...(compatibleHarnesses !== undefined ? { compatibleHarnesses } : {}),
  };
}
