// E3 — MCP manifest threat detector (specification.md §8; AC5, E-3, E-9).
//
// Pure and network-free. `scanMcpManifest(manifest)` inspects an MCP tool
// manifest (tool descriptions + input JSON schemas) and returns
// `DetectorMatch[]` covering three threat classes:
//
//   - tool-poisoning : hidden instruction-injection aimed at the agent
//   - line-jumping   : content that tries to alter handling of OTHER tools
//   - rug-pull       : a tool definition whose sha256 diverges from a pinned
//                      baseline (definition drift after trust)
//
// Findings are LEAK-SAFE (E-9): the `value` field carries a category token, not
// raw manifest content, so no secret ever reaches a committed artifact. Matches
// use existing `SecurityCategory` values so they slot into the shared finding
// pipeline (`buildFinding`) exactly like every other detector.

import { createHash } from "node:crypto";
import type { DetectorMatch, SecurityCategory, SecuritySeverity } from "../types";

// A parsed MCP tool definition (the subset we inspect).
interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ScanMcpOptions {
  // Pinned baseline of tool-definition sha256 hashes, keyed by tool name
  // (rug-pull detection). Absent ⇒ no rug-pull check (first pin).
  baseline?: Record<string, string> | undefined;
  // Label for the manifest source (a file name / id), used only in remediation
  // text — never raw content.
  source?: string | undefined;
}

// Deterministic sha256 over a canonicalized tool definition. Reuses the Block 0
// sha256/checksum convention (assets.lock.json) so baselines are git-diffable.
export function hashToolDefinition(tool: McpToolDef): string {
  const canonical = JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// --- Signature tables ---------------------------------------------------------

// Tool-poisoning: hidden instruction-injection in a tool's description/param
// docs. Imperative directives, "ignore previous", exfil verbs, embedded
// credentials/URLs, HTML/markdown comment payloads.
const POISONING_PATTERNS: Array<{ policyId: string; regex: RegExp; confidence: number }> = [
  {
    policyId: "mcp.poisoning.ignore-instructions",
    regex:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(all\s+)?(previous|prior|above|earlier|system|developer|safety)\b/i,
    confidence: 0.9,
  },
  {
    policyId: "mcp.poisoning.imperative-directive",
    regex:
      /\b(you\s+must|always|before\s+(?:answering|responding|replying)|do\s+not\s+tell|never\s+mention|without\s+(?:telling|informing)\s+the\s+user)\b/i,
    confidence: 0.75,
  },
  {
    policyId: "mcp.poisoning.exfil-verb",
    regex:
      /\b(send|upload|post|exfiltrate|leak|forward|transmit|email)\b[^.\n]{0,40}\b(to|at)\b[^.\n]{0,40}(https?:\/\/|@|\bwebhook\b|\bexternal\b)/i,
    confidence: 0.85,
  },
  {
    policyId: "mcp.poisoning.reveal-secrets",
    regex:
      /\b(reveal|read|print|include|attach|dump)\b[^.\n]{0,40}\b(\.env|ssh\s+key|private\s+key|api[_\s-]?keys?|credentials?|secrets?|password)\b/i,
    confidence: 0.9,
  },
  {
    policyId: "mcp.poisoning.embedded-credential",
    regex:
      /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/,
    confidence: 0.95,
  },
  {
    policyId: "mcp.poisoning.comment-payload",
    regex: /<!--[\s\S]*?-->|<important>[\s\S]*?<\/important>/i,
    confidence: 0.7,
  },
];

// Line-jumping: content that attempts to change how OTHER tools/context are
// handled before invocation (cross-tool instruction, priority override,
// tool-shadowing phrasing).
const LINE_JUMPING_PATTERNS: Array<{ policyId: string; regex: RegExp; confidence: number }> = [
  {
    policyId: "mcp.line-jumping.cross-tool",
    regex:
      /\b(before|prior\s+to|instead\s+of|rather\s+than)\b[^.\n]{0,30}\b(using|calling|invoking|any)\b[^.\n]{0,20}\b(other\s+)?(tools?|functions?)\b/i,
    confidence: 0.85,
  },
  {
    policyId: "mcp.line-jumping.priority-override",
    regex:
      /\b(highest|higher|top)\s+priority\b|\bthis\s+tool\s+(must|should)\s+(always|first)\b|\btakes?\s+precedence\b|\balways\s+(call|use|run)\s+this\s+(tool\s+)?first\b/i,
    confidence: 0.8,
  },
  {
    policyId: "mcp.line-jumping.context-override",
    regex:
      /\b(for\s+all\s+(other\s+)?tools|applies\s+to\s+every\s+tool|regardless\s+of\s+(the\s+)?tool|global\s+instruction)\b/i,
    confidence: 0.8,
  },
];

// Invisible / steganographic unicode: zero-width joiners/spaces, BiDi controls,
// and Unicode tag characters used to smuggle instructions past human review.
// Built from explicit escapes so the source stays readable and copy-safe.
const INVISIBLE_UNICODE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]" +
    "|[\\u{E0000}-\\u{E007F}]",
  "u",
);

// --- Match builders -----------------------------------------------------------

function makeMatch(
  category: SecurityCategory,
  policyId: string,
  severity: SecuritySeverity,
  confidence: number,
  token: string,
  remediation: string,
): DetectorMatch {
  return {
    category,
    policyId,
    severity,
    confidence,
    start: 0,
    end: 0,
    // Leak-safe: a category token, never raw manifest content (E-9).
    value: token,
    remediation,
  };
}

function parseTools(manifest: unknown): McpToolDef[] {
  if (!manifest || typeof manifest !== "object") {
    return [];
  }
  const rawTools = (manifest as { tools?: unknown }).tools;
  const list = Array.isArray(rawTools)
    ? rawTools
    : rawTools && typeof rawTools === "object"
      ? Object.values(rawTools as Record<string, unknown>)
      : [];
  const tools: McpToolDef[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    tools.push({
      name: typeof entry.name === "string" ? entry.name : "(unnamed)",
      description: typeof entry.description === "string" ? entry.description : "",
      inputSchema: entry.inputSchema,
    });
  }
  return tools;
}

// Concatenate every human-facing text surface of a tool: its description plus
// all schema property descriptions/titles (where poisoned instructions hide).
function toolText(tool: McpToolDef): string {
  const parts: string[] = [tool.description ?? ""];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 6 || !value || typeof value !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "description" || key === "title") && typeof nested === "string") {
        parts.push(nested);
      } else if (nested && typeof nested === "object") {
        collect(nested, depth + 1);
      }
    }
  };
  collect(tool.inputSchema, 0);
  return parts.join("\n");
}

// --- Public API ---------------------------------------------------------------

// Scan a parsed MCP manifest and return leak-safe detector matches. Pure and
// network-free; deterministic for a given input + baseline.
export function scanMcpManifest(
  manifest: unknown,
  options: ScanMcpOptions = {},
): DetectorMatch[] {
  const tools = parseTools(manifest);
  const matches: DetectorMatch[] = [];
  const seenNames = new Map<string, number>();

  for (const tool of tools) {
    const text = toolText(tool);

    for (const pattern of POISONING_PATTERNS) {
      if (pattern.regex.test(text)) {
        const category: SecurityCategory =
          pattern.policyId === "mcp.poisoning.embedded-credential"
            ? "secret"
            : pattern.policyId === "mcp.poisoning.exfil-verb"
              ? "egress"
              : "prompt-injection";
        matches.push(
          makeMatch(
            category,
            pattern.policyId,
            "high",
            pattern.confidence,
            `tool:${tool.name}`,
            `Tool "${tool.name}" description contains a tool-poisoning signal; treat MCP tool metadata as untrusted.`,
          ),
        );
      }
    }

    for (const pattern of LINE_JUMPING_PATTERNS) {
      if (pattern.regex.test(text)) {
        matches.push(
          makeMatch(
            "prompt-injection",
            pattern.policyId,
            "high",
            pattern.confidence,
            `tool:${tool.name}`,
            `Tool "${tool.name}" attempts to influence handling of other tools (line-jumping).`,
          ),
        );
      }
    }

    if (INVISIBLE_UNICODE.test(text)) {
      matches.push(
        makeMatch(
          "prompt-injection",
          "mcp.poisoning.invisible-unicode",
          "critical",
          0.9,
          `tool:${tool.name}`,
          `Tool "${tool.name}" description hides invisible/steganographic unicode; reject or normalize it.`,
        ),
      );
    }

    // Tool-shadowing: duplicate tool names in one manifest.
    const count = (seenNames.get(tool.name) ?? 0) + 1;
    seenNames.set(tool.name, count);
    if (count > 1) {
      matches.push(
        makeMatch(
          "prompt-injection",
          "mcp.line-jumping.tool-shadowing",
          "high",
          0.8,
          `tool:${tool.name}`,
          `Duplicate tool name "${tool.name}" shadows another tool definition.`,
        ),
      );
    }

    // Rug-pull: definition drift versus the pinned baseline.
    if (options.baseline && Object.prototype.hasOwnProperty.call(options.baseline, tool.name)) {
      const pinned = options.baseline[tool.name];
      const current = hashToolDefinition(tool);
      if (pinned !== current) {
        matches.push(
          makeMatch(
            "artifact-safety",
            "mcp.rug-pull.definition-drift",
            "high",
            0.95,
            `tool:${tool.name}`,
            `Tool "${tool.name}" definition diverges from the pinned baseline (possible rug-pull). Re-review and re-pin.`,
          ),
        );
      }
    }
  }

  return matches;
}

// Build a fresh baseline map (name -> sha256) from a manifest, for pinning.
export function buildMcpBaseline(manifest: unknown): Record<string, string> {
  const baseline: Record<string, string> = {};
  for (const tool of parseTools(manifest)) {
    baseline[tool.name] = hashToolDefinition(tool);
  }
  return baseline;
}
