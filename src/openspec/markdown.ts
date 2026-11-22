export type OpenSpecDeltaOperation = "added" | "modified" | "removed" | "renamed";

export interface OpenSpecMarkdownScenario {
  title: string;
  markdown: string;
  startLine: number;
  endLine: number;
}

export interface OpenSpecMarkdownRequirement extends OpenSpecMarkdownScenario {
  operation?: OpenSpecDeltaOperation;
  renamedTo?: string;
  scenarios: OpenSpecMarkdownScenario[];
}

const DIAGNOSTIC_MESSAGES = {
  "unknown-operation": "This heading does not name a supported OpenSpec operation.",
  "unsupported-requirement": "Expected a stock OpenSpec requirement heading here.",
  "orphan-requirement": "This requirement is outside a supported delta operation.",
  "malformed-requirement": "This requirement heading needs a title.",
  "malformed-scenario": "This scenario heading needs a title.",
  "orphan-scenario": "This scenario has no enclosing requirement.",
  "malformed-rename": "Expected a FROM or TO entry containing a requirement heading.",
  "unpaired-rename": "This rename entry has no matching FROM or TO in its section.",
  "unclosed-frontmatter": "The leading frontmatter has no closing delimiter.",
} as const;

export interface OpenSpecMarkdownDiagnostic {
  code: keyof typeof DIAGNOSTIC_MESSAGES;
  line: number;
  endLine: number;
  message: string;
}

interface MarkdownSource {
  lines: string[];
  lineEndings: string[];
  visible: string[];
  diagnostics: OpenSpecMarkdownDiagnostic[];
}

interface Heading {
  level: number;
  text: string;
}

interface Block {
  title: string;
  index: number;
}

interface Section {
  index: number;
  end: number;
  operation?: OpenSpecDeltaOperation;
}

function report(
  source: MarkdownSource,
  code: OpenSpecMarkdownDiagnostic["code"],
  index: number,
  end = index + 1,
): void {
  source.diagnostics.push({ code, line: index + 1, endLine: end, message: DIAGNOSTIC_MESSAGES[code] });
}

function headingText(text: string): string {
  return text.replace(/[ \t]+#+[ \t]*$/, "").trim();
}

function heading(line: string): Heading | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(line);
  const marks = match?.[1];
  return marks ? { level: marks.length, text: headingText(match[2] ?? "") } : undefined;
}

// Keep the authored lines for rendering. This second view is only for recognizing structure.
function readMarkdown(markdown: string): MarkdownSource {
  const lines = markdown.split(/\r\n?|\n/);
  const visible: string[] = [];
  const lineEndings = markdown.match(/\r\n?|\n/g) ?? [];
  const source: MarkdownSource = { lines, lineEndings, visible, diagnostics: [] };
  const first = (lines[0] ?? "").replace(/^\uFEFF/, "");
  let frontmatterEnd = -1;
  if (/^---[ \t]*$/.test(first)) {
    frontmatterEnd = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
    if (frontmatterEnd < 0) {
      frontmatterEnd = lines.length - 1;
      report(source, "unclosed-frontmatter", 0, lines.length);
    }
  }

  let fence: string | undefined;
  let inComment = false;
  for (const [index, original] of lines.entries()) {
    visible.push("");
    if (index <= frontmatterEnd) continue;

    const line = index === 0 ? first : original;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marks = marker?.[1];
    const suffix = marker?.[2] ?? "";
    if (fence) {
      if (marks?.startsWith(fence) && suffix.trim() === "") fence = undefined;
      continue;
    }
    if (!inComment && marks && (marks.startsWith("~") || !suffix.includes("`"))) {
      fence = marks;
      continue;
    }

    const fragments: string[] = [];
    let start = 0;
    while (start < line.length) {
      if (inComment) {
        const close = line.indexOf("-->", start);
        if (close < 0) break;
        start = close + 3;
        inComment = false;
      } else {
        const open = line.indexOf("<!--", start);
        if (open < 0) {
          fragments.push(line.slice(start));
          break;
        }
        fragments.push(line.slice(start, open));
        if (open > start) fragments.push(" ");
        start = open + 4;
        inComment = true;
      }
    }
    visible[index] = fragments.join("");
  }
  return source;
}

function operationFor(text: string): OpenSpecDeltaOperation | undefined {
  switch (text.toLowerCase()) {
    case "added requirements": return "added";
    case "modified requirements": return "modified";
    case "removed requirements": return "removed";
    case "renamed requirements": return "renamed";
    default: return undefined;
  }
}

function sections(source: MarkdownSource, delta: boolean): Section[] {
  const result: Section[] = [];
  let current: Section = { index: -1, end: source.lines.length };
  for (const [index, line] of source.visible.entries()) {
    const boundary = heading(line);
    if (!boundary || boundary.level > 2) continue;
    current.end = index;
    result.push(current);
    const operation = delta && boundary.level === 2 ? operationFor(boundary.text) : undefined;
    if (delta && boundary.level === 2 && !operation && /\brequirements?\b/i.test(boundary.text)) {
      report(source, "unknown-operation", index);
    }
    current = { index, end: source.lines.length, ...(operation && { operation }) };
  }
  result.push(current);
  return result;
}

function snippet(source: MarkdownSource, block: Block, end: number): OpenSpecMarkdownScenario {
  while (end > block.index + 1 && (source.lines[end - 1] ?? "").trim() === "") end--;
  return {
    title: block.title,
    markdown: source.lines.slice(block.index, end).map((line, offset) => {
      const index = block.index + offset;
      return index + 1 < end ? line + (source.lineEndings[index] ?? "") : line;
    }).join(""),
    startLine: block.index + 1,
    endLine: end,
  };
}

function requirementTitle(line: string): string | undefined {
  const match = /^ {0,3}###[ \t]*Requirement:(.*)$/i.exec(line);
  return match ? headingText(match[1] ?? "") : undefined;
}

function unwrapCode(line: string): string {
  const text = line.trim();
  if (!text.startsWith("`") || !text.endsWith("`")) return text;
  const delimiter = /^`+/.exec(text)?.[0] ?? "";
  return text.length > delimiter.length * 2 && text.endsWith(delimiter)
    ? text.slice(delimiter.length, -delimiter.length).trim()
    : text;
}

function removalTitle(line: string): string | undefined {
  const bullet = /^[ \t]*[-*+][ \t]+(.*)$/.exec(line);
  return bullet ? requirementTitle(unwrapCode(bullet[1] ?? "")) : undefined;
}

function scenarios(source: MarkdownSource, requirement: Block, end: number): OpenSpecMarkdownScenario[] {
  const result: OpenSpecMarkdownScenario[] = [];
  let current: Block | undefined;
  for (let index = requirement.index + 1; index < end; index++) {
    const line = source.visible[index] ?? "";
    const parsed = heading(line);
    if (parsed?.level !== 4) continue;
    if (current) result.push(snippet(source, current, index));
    current = undefined;
    if (!/^Scenario:/i.test(parsed.text)) continue;

    const title = parsed.text.slice("Scenario:".length).trim();
    if (title) current = { title, index };
    else report(source, "malformed-scenario", index);
  }
  if (current) result.push(snippet(source, current, end));
  return result;
}

function requirements(source: MarkdownSource, section: Section, delta: boolean): OpenSpecMarkdownRequirement[] {
  const result: OpenSpecMarkdownRequirement[] = [];
  const { operation } = section;
  let current: Block | undefined;
  const finish = (end: number) => {
    if (!current) return;
    result.push({
      ...snippet(source, current, end),
      ...(operation && { operation }),
      scenarios: scenarios(source, current, end),
    });
    current = undefined;
  };
  for (let index = section.index + 1; index < section.end; index++) {
    const line = source.visible[index] ?? "";
    const parsed = heading(line);
    const listed = removalTitle(line);
    const title = listed ?? requirementTitle(line);
    if (parsed?.level === 3 || title !== undefined) {
      finish(index);
      if (title === undefined || (listed !== undefined && operation !== "removed")) {
        if (operation || listed !== undefined) report(source, "unsupported-requirement", index);
      } else if (!title) {
        report(source, "malformed-requirement", index);
      } else if (delta && !operation) {
        report(source, "orphan-requirement", index);
      } else {
        current = { title, index };
        if (listed !== undefined) finish(index + 1);
      }
    } else if (!current && parsed?.level === 4 && /^Scenario:/i.test(parsed.text)) {
      report(source, "orphan-scenario", index);
    }
  }
  finish(section.end);
  return result;
}

function renames(source: MarkdownSource, section: Section): OpenSpecMarkdownRequirement[] {
  const result: OpenSpecMarkdownRequirement[] = [];
  let pending: Block | undefined;
  for (let index = section.index + 1; index < section.end; index++) {
    const line = source.visible[index] ?? "";
    if (!line.trim()) continue;

    const entry = /^[ \t]*(?:[-*+][ \t]+)?(FROM|TO):[ \t]*(.*)$/.exec(line);
    const title = entry ? requirementTitle(unwrapCode(entry[2] ?? "")) : undefined;
    if (!title) {
      report(source, "malformed-rename", index);
      if (entry && pending) {
        report(source, "unpaired-rename", pending.index);
        pending = undefined;
      }
    } else if (entry?.[1] === "FROM") {
      if (pending) report(source, "unpaired-rename", pending.index);
      pending = { title, index };
    } else if (pending) {
      result.push({ ...snippet(source, pending, index + 1), operation: "renamed", renamedTo: title, scenarios: [] });
      pending = undefined;
    } else {
      report(source, "unpaired-rename", index);
    }
  }
  if (pending) report(source, "unpaired-rename", pending.index);
  return result;
}

export function parseOpenSpecMarkdown(
  markdown: string,
  { delta }: { delta: boolean },
): { requirements: OpenSpecMarkdownRequirement[]; diagnostics: OpenSpecMarkdownDiagnostic[] } {
  const source = readMarkdown(markdown);
  return {
    requirements: sections(source, delta).flatMap((section) =>
      section.operation === "renamed" ? renames(source, section) : requirements(source, section, delta)),
    diagnostics: source.diagnostics.sort((a, b) => a.line - b.line),
  };
}
