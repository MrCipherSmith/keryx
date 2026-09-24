// Security scan of learned text (W3 spec, "Safety" > "Security scan of
// learned text"): every trigger/action/evidence preview passes this before a
// record can leave `status: candidate` review or before apply/graduate write
// anything. A finding is reported as a category name only — never the
// matched text (schema: `redaction.findings`).
import { loadSecurityConfig } from "../security/config";
import { memoizeResolved, scanContent } from "../security/service";
import type { SecurityConfig } from "../security/types";

// O-5: `scanContent` (unlike `analyze`) never touches
// `.metaproject/data/security/` — no state read/write, no incident append —
// so a redaction scan run on every observation event does not race a
// concurrent `keryx security scan`/`check-output` writer, or grow an
// incidents log the operator never asked this path to write to.
//
// O-6: the security config is loaded once per project root per process
// (`memoizeResolved`), not on every `redactPreview`/`scanLearnedText` call —
// this path can run once per hook event.
const configLoaders = new Map<string, () => Promise<SecurityConfig>>();
function configFor(root: string): () => Promise<SecurityConfig> {
  let loader = configLoaders.get(root);
  if (loader === undefined) {
    loader = memoizeResolved(() => loadSecurityConfig(root));
    configLoaders.set(root, loader);
  }
  return loader;
}

export interface ScanResult {
  /** Distinct category names only, sorted — never the matched text. */
  findings: string[];
}

/**
 * Deterministic, local detector for imperative-injection shapes embedded in
 * what should be a description of a pattern (W3 spec: "'ignore previous
 * instructions and…'"). Runs in addition to `keryx security check-output`
 * (`analyze`) rather than instead of it — `analyze`'s own `prompt-injection`
 * detector is tuned for a different corpus (tool output / fetched content),
 * and learned trigger/action text is short, hand-generalized prose where a
 * few fixed phrase shapes cover the realistic imperative-injection attempts.
 */
const INJECTION_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions?\b/i,
  /\bdisregard\b[^.\n]{0,60}\binstructions?\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\bsystem\s+prompt\b/i,
  /<\s*\/?\s*(system|assistant|user)\s*>/i,
  /\bact\s+as\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bdo\s+not\s+tell\s+the\s+user\b/i,
];

/** Local imperative-injection detector. Returns the category `"prompt-injection"` on a match, else `undefined`. */
export function detectInjectionShape(text: string): "prompt-injection" | undefined {
  return INJECTION_SHAPE_PATTERNS.some((pattern) => pattern.test(text)) ? "prompt-injection" : undefined;
}

/**
 * Scans `texts` (trigger/action/evidence-preview strings) via
 * `keryx security check-output` (`source: "untrusted-external"` — the
 * strictest posture, since this text is distilled from tool output/prompts
 * the operator did not directly author) plus the local injection-shape
 * detector, and returns the distinct finding category names. Never returns
 * matched text.
 */
export async function scanLearnedText(root: string, texts: string[]): Promise<ScanResult> {
  const categories = new Set<string>();
  const config = await configFor(root)();
  for (const text of texts) {
    if (text.length === 0) continue;
    const shape = detectInjectionShape(text);
    if (shape !== undefined) categories.add(shape);
    const { decision } = await scanContent(root, { content: text, source: "untrusted-external" }, { config });
    for (const finding of decision.findings) categories.add(finding.category);
  }
  return { findings: [...categories].sort() };
}

/**
 * Redact one preview string for the observation writer (T6): scans `text`
 * (unbounded, so an injection shape past the 200-char bound is still caught)
 * and returns either the truncated preview or `"[redacted:<category>]"` when
 * a finding fires — matching the W3 spec's "a finding truncates the preview
 * to the category name... rather than dropping the line" rule.
 */
export async function redactPreview(root: string, text: string, maxLen = 200): Promise<string> {
  // O-6: scan only what could ever survive into the preview, plus a little
  // slack for a finding that starts just past `maxLen` — not the whole
  // (potentially very large) raw tool input/output.
  const scanBudget = maxLen + 1024;
  const scanText = text.length > scanBudget ? text.slice(0, scanBudget) : text;
  const { findings } = await scanLearnedText(root, [scanText]);
  if (findings.length > 0) {
    return `[redacted:${findings[0]}]`;
  }
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
