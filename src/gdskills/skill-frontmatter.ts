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
}

/**
 * Forgiving frontmatter parse for a SKILL.md's `description`/`triggers` fields.
 * Never throws: a malformed or absent frontmatter block yields `{}`, degrading
 * that one catalog entry rather than failing the whole `skillsCatalog` call.
 *
 * `description` takes either a plain scalar or a YAML block scalar (`|`/`>`,
 * with an optional `-`/`+` chomping indicator) whose text sits on the following
 * indented lines.
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
      continue;
    }
    if (/^triggers:\s*$/.test(line)) {
      inTriggers = true;
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
  }
  if (descriptionBlock !== null) {
    description = foldBlock(descriptionBlock);
  }
  return { ...(description !== undefined ? { description } : {}), ...(triggers.length > 0 ? { triggers } : {}) };
}
