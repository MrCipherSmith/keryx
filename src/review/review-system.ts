import type { ApprovalMeta } from "../commands/agent";
import { splitSegments } from "../lib/shell-syntax";

export type ReviewSystem = "inherit" | "review-auto";

export const ENV_REVIEW_SYSTEM = "KERYX_REVIEW_SYSTEM";

let current: ReviewSystem = "inherit";

export function parseReviewSystem(value: string | undefined): ReviewSystem | undefined {
  const v = value?.trim().toLowerCase();
  if (v === "review-auto") return "review-auto";
  if (v === "inherit" || v === "default") return "inherit";
  return undefined;
}

export function setReviewSystem(value: ReviewSystem): void {
  current = value;
}

export function getReviewSystem(env: Record<string, string | undefined> = process.env): ReviewSystem {
  if (current === "review-auto") return "review-auto";
  return parseReviewSystem(env[ENV_REVIEW_SYSTEM]) ?? "inherit";
}

export function reviewAutoActive(env: Record<string, string | undefined> = process.env): boolean {
  return getReviewSystem(env) === "review-auto";
}

const REVIEW_AUTO_PHRASE =
  /review-auto|автоматическ[а-яё]*\s+(?:код-?\s*)?ревью|ревью\s+автоматическ[а-яё]*|автоматическ[а-яё]*\s+review|automatic(?:ally)?\s+(?:code\s+)?review|auto[- ]review/i;

/** True when the operator's own line asks for an automatic review. Only ever fed the operator's text, never tool output. */
export function asksForReviewAuto(userLine: string): boolean {
  return REVIEW_AUTO_PHRASE.test(userLine);
}

/** What the model reads when it repeats a call the operator or policy already refused. */
export const REFUSED_EARLIER = "refused earlier: choose another path";

const OUTPUT_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--yaml",
  "--raw",
  "--quiet",
  "--silent",
  "--no-color",
  "--plain",
  "--pretty",
  "--compact",
]);
const OUTPUT_VALUE_FLAGS: ReadonlySet<string> = new Set(["--format", "--output-format"]);

function normalizeSegmentWords(words: readonly string[]): string {
  const expanded = words.flatMap((w) => {
    const eq = w.indexOf("=");
    return w.startsWith("--") && eq > 2 ? [w.slice(0, eq), w.slice(eq + 1)] : [w];
  });
  const kept: string[] = [];
  for (let i = 0; i < expanded.length; i += 1) {
    const w = expanded[i]!;
    if (OUTPUT_FLAGS.has(w)) continue;
    if (OUTPUT_VALUE_FLAGS.has(w)) {
      if (expanded[i + 1] !== undefined && !expanded[i + 1]!.startsWith("-")) i += 1;
      continue;
    }
    kept.push(w);
  }
  if (kept.length > 1 && kept[kept.length - 1] === "--help") kept.pop();
  const firstDash = kept.findIndex((w) => w.startsWith("-"));
  const head = firstDash === -1 ? kept : kept.slice(0, firstDash);
  const rest = firstDash === -1 ? [] : kept.slice(firstDash);
  const units: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i]!;
    const next = rest[i + 1];
    if (w.startsWith("-") && next !== undefined && !next.startsWith("-")) {
      units.push(`${w}\u001f${next}`);
      i += 1;
    } else {
      units.push(w);
    }
  }
  return `${head.join("\u001f")}\u001e${units.sort().join("\u001e")}`;
}

/**
 * The key a refusal is remembered under. A shell command is normalized so that spacing, quoting,
 * `--flag=value`, the order of flag pairs, output-style flags (`--json`) and a trailing `--help` do not
 * make a refused call look new. Any other call (or an unreadable command) keeps `fallback`, its exact hash.
 */
export function refusalFingerprint(tool: string, rawInput: string, fallback: string): string {
  let command: unknown;
  try {
    command = (JSON.parse(rawInput) as { command?: unknown } | null)?.command;
  } catch {
    return fallback;
  }
  if (typeof command !== "string" || command.trim().length === 0) return fallback;
  const segments = splitSegments(command);
  if (segments.length === 0) return fallback;
  const parts = segments.map((seg) => `${seg.precededBy ?? ""}\u001d${normalizeSegmentWords(seg.words)}`);
  return `${tool}\u0000cmd:${parts.join("\u001d")}`;
}

const operatorDenials = new Set<string>();
let operatorRefused = false;

/**
 * Remember an action the operator refused under review-auto, so it can neither grant it again nor ask itself to
 * overturn it. Only review-auto writes and reads the per-call set. It also marks the question floor, like
 * `noteOperatorRefusal`, which is what the other modes call on their own.
 */
export function recordOperatorDenial(fingerprint: string): void {
  operatorDenials.add(fingerprint);
  noteOperatorRefusal();
}

export function operatorDenied(fingerprint: string): boolean {
  return operatorDenials.has(fingerprint);
}

/** A person at the keyboard said no to an approval, in any mode: the question floor now keeps permission questions for them. */
export function noteOperatorRefusal(): void {
  operatorRefused = true;
}

/** Cleared on `/clear`, `/new`, a resumed session and a permission-mode change, so a refusal does not outlive the conversation or the posture it was made under. */
export function resetOperatorDenials(): void {
  operatorDenials.clear();
  operatorRefused = false;
}

const PERMISSION_WORDS =
  /\b(?:allow|deny|denied|permit|permission|grant|approve|approval|consent|authori[sz]e)\b|разреш|запрет|одобр|отклон|согласи|доступ|привилег/i;

/**
 * Whether review-auto may answer an `ask_user` menu itself. Not for an irreversible question, and not for a
 * permission-style choice once the operator has refused an action in this shell: the agent cannot ask itself
 * to overturn a refusal. "Permission-style" is decided by the question's wording, so this is a floor for
 * questions phrased as a permission request, not a guarantee against a differently worded one.
 */
export function reviewAutoMayAnswer(request: {
  question: string;
  options: ReadonlyArray<{ id: string; label: string; description: string }>;
  irreversible?: boolean;
}): boolean {
  if (request.irreversible === true) return false;
  if (!operatorRefused) return true;
  const text = [request.question, ...request.options.flatMap((o) => [o.id, o.label, o.description])].join("\n");
  return !PERMISSION_WORDS.test(text);
}

/**
 * Whether review-auto answers an approval question itself. A bounded reviewer child is granted even after
 * untrusted content (it has no shell); any other tool only when no floor applies: destructive, credential,
 * publish-lease, hook-tightened and untrusted-origin calls still reach a human.
 */
export function reviewAutoGrants(tool: string, meta: ApprovalMeta | undefined): boolean {
  if (meta === undefined) return false;
  if (meta.destructive || meta.credentials === true || meta.publishLease === true || meta.hookAsk === true) return false;
  if (meta.alwaysAsk === true) return false;
  if (tool === "spawn_subagent") return true;
  return meta.untrustedOrigin !== true;
}
