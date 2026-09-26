// `keryx review jev-profile` — flow 344's recommended-profile helper.
//
// Every `review.jev.*` key this programme's own measurement pass produced a
// verdict for, in one place, so a project does not have to read six flow
// journals to know which Jev review steps are worth turning on. Pure
// merge/render logic lives here; `src/commands/review-jev-profile.ts` is
// where it meets `.metaproject/tasks.config.json` on disk.

/** One measured (or explicitly not-yet-measured) `review.jev.*` key. */
export interface JevProfileKey {
  readonly key: string;
  readonly recommended: boolean;
  readonly verdict: string;
}

/**
 * The full recommended profile, keyed exactly as `.metaproject/tasks.config.json`'s
 * `review.jev.*` block names them. `edit_guard` is read by a PARALLEL feature
 * (`keryx review jev-edit-guard`, a separate PR) — this profile only turns the
 * key on; it implements nothing.
 */
export const RECOMMENDED_JEV_PROFILE: readonly JevProfileKey[] = [
  {
    key: "ci_triage",
    recommended: true,
    verdict:
      "PROVEN — sorted failed CI jobs (flaky/regression/infra) at 38% vs Sonnet 5's 25% on 103 reliable labels (p=0.035); " +
      "cut developer minutes per failure from 30 to 15.4 under an explicit cost model.",
  },
  {
    key: "select",
    recommended: true,
    verdict:
      "UNMEASURED, most promising cost lever — reviewer (sub-agent) selection was never measured before flow 344. " +
      "Recall-first: only skips below `select_skip_below` (default 0.15), never the core safety set, fails open on any error.",
  },
  {
    key: "edit_guard",
    recommended: true,
    verdict:
      "`keryx review jev-edit-guard` — flags rule-breaking edits during the FIX phase, when the " +
      "author's agent applies fixes, and is already wired into job-orchestrator/flow-orchestrator/" +
      "task-implementer/code-verifier. This profile only sets the key.",
  },
  {
    key: "risk",
    recommended: false,
    verdict:
      "Measured weaker than a strong model — review-jev-risk (which files/reviewers to focus on) scored top-3 recall 21% " +
      "vs 30% for \"largest diff first\", and 44% for Sonnet. Keep off by default.",
  },
  {
    key: "contract",
    recommended: false,
    verdict:
      "Measured weaker than a strong model — review-jev-contract (false claims in PR bodies) caught 12.5% vs Sonnet's " +
      "67.5%. Keep off by default.",
  },
  {
    key: "rules",
    recommended: false,
    verdict: "Not useful on top of a strong reviewer — as an extra reviewer over a strong reviewer, review-jev-rules added +0 findings.",
  },
  { key: "scenarios", recommended: false, verdict: "Experimental — not measured." },
  { key: "docs", recommended: false, verdict: "Experimental — not measured." },
  { key: "comments", recommended: false, verdict: "Experimental — not measured." },
];

/** Deep-enough merge for `.metaproject/tasks.config.json`: preserves every key this profile does not name, at every level it touches. */
export function mergeRecommendedJevProfile(existing: unknown): Record<string, unknown> {
  const root = typeof existing === "object" && existing !== null ? { ...(existing as Record<string, unknown>) } : {};
  const review = typeof root["review"] === "object" && root["review"] !== null ? { ...(root["review"] as Record<string, unknown>) } : {};
  const jev = typeof review["jev"] === "object" && review["jev"] !== null ? { ...(review["jev"] as Record<string, unknown>) } : {};
  for (const entry of RECOMMENDED_JEV_PROFILE) {
    jev[entry.key] = entry.recommended;
  }
  review["jev"] = jev;
  root["review"] = review;
  return root;
}

/**
 * Flip one `review.jev.<key>` boolean, preserving every other key at every
 * level untouched — the modal's per-row toggle. An unset/non-boolean current
 * value is treated as `false` before flipping, so the first toggle always
 * turns a key ON regardless of whether it was previously absent or `false`.
 */
export function toggleJevProfileKey(existing: unknown, key: string): Record<string, unknown> {
  const root = typeof existing === "object" && existing !== null ? { ...(existing as Record<string, unknown>) } : {};
  const review = typeof root["review"] === "object" && root["review"] !== null ? { ...(root["review"] as Record<string, unknown>) } : {};
  const jev = typeof review["jev"] === "object" && review["jev"] !== null ? { ...(review["jev"] as Record<string, unknown>) } : {};
  const current = jev[key];
  jev[key] = typeof current === "boolean" ? !current : true;
  review["jev"] = jev;
  root["review"] = review;
  return root;
}

/** The `review.jev.*` block as it currently reads, one boolean (or `undefined` when unset) per profile key. */
export function currentJevProfile(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null) return {};
  const review = (parsed as Record<string, unknown>)["review"];
  if (typeof review !== "object" || review === null) return {};
  const jev = (review as Record<string, unknown>)["jev"];
  if (typeof jev !== "object" || jev === null) return {};
  return jev as Record<string, unknown>;
}

/**
 * Flow 346 — Jev default-on. The three RECOMMENDED, fail-open `review.jev.*`
 * keys (`ci_triage`, `select`, `edit_guard` — the same trio
 * `RECOMMENDED_JEV_PROFILE` marks `recommended: true`) now apply BY DEFAULT
 * wherever Jev is reachable, so a project needs no per-project opt-in when
 * the operator has a working OpenRouter/Jev credential and has not turned
 * `/external` off. `risk`/`contract`/`rules`/`scenarios`/`docs`/`comments`
 * are NOT in this set — they stay off unless explicitly enabled, exactly as
 * `RECOMMENDED_JEV_PROFILE` already documents.
 */
export const JEV_DEFAULT_ON_KEYS: ReadonlySet<string> = new Set(["ci_triage", "select", "edit_guard"]);

/** Which rule decided a `review.jev.*` key's effective value — `keryx review jev-profile show` displays this per key. */
export type JevProfileFlagSource = "explicit" | "default-because-jev-available" | "off-by-external" | "off";

export interface JevProfileFlagResult {
  readonly value: boolean;
  readonly source: JevProfileFlagSource;
}

/**
 * What a caller must already know to resolve one key — deliberately NOT
 * computed in here. `externalOn` needs only `resolveExternalSetting`
 * (`src/lib/external-switch.ts`, SHARED zone, safe from this CORE module).
 * `jevAvailable` needs `resolveJevApiKey` (`src/harness/decision/
 * jev-client.ts`, CLIENT zone) — `src/review/` may never import CLIENT
 * (`import-zones.ts`'s core->client rule, no exception), so every caller of
 * this function (and of the three `review.jev.*` readers that call through
 * it: `readCiTriageEnabled`, `readJevSelectEnabled`,
 * `readJevEditGuardEnabled`) computes `jevAvailable` itself, in its own
 * CLIENT/ADAPTER zone, and passes it in. Design §4: "reuse
 * `resolveJevApiKey` WITHOUT passing a project dir" — the per-project
 * credential dir override that some Jev callers use for other purposes is
 * deliberately NOT part of this default-on check.
 */
export interface JevProfileFlagContext {
  readonly externalOn: boolean;
  readonly jevAvailable: boolean;
}

/**
 * THE single place every `review.jev.*` reader goes through (design §4) to
 * decide a key's effective boolean:
 *
 *   1. An explicit `true`/`false` in `.metaproject/tasks.config.json` always
 *      wins — a project's own choice is never overridden by a default.
 *   2. Otherwise, a key outside {@link JEV_DEFAULT_ON_KEYS} (risk, contract,
 *      rules, scenarios, docs, comments) stays off — unmeasured/measured-
 *      weaker steps get no default-on.
 *   3. Otherwise (a `JEV_DEFAULT_ON_KEYS` member, unset): off when
 *      `/external` is off (`"off-by-external"`) — the switch always wins
 *      over the default, never the other way around.
 *   4. Otherwise: on when a Jev credential resolves
 *      (`"default-because-jev-available"`), off when it does not (`"off"`
 *      — no credential means Jev could not run anyway; reporting it as
 *      "on" would be a default that lies about what will happen).
 */
export function resolveJevProfileFlag(key: string, explicit: boolean | undefined, ctx: JevProfileFlagContext): JevProfileFlagResult {
  if (typeof explicit === "boolean") {
    return { value: explicit, source: "explicit" };
  }
  if (!JEV_DEFAULT_ON_KEYS.has(key)) {
    return { value: false, source: "off" };
  }
  if (!ctx.externalOn) {
    return { value: false, source: "off-by-external" };
  }
  if (ctx.jevAvailable) {
    return { value: true, source: "default-because-jev-available" };
  }
  return { value: false, source: "off" };
}

export function renderJevProfileMarkdown(current: Record<string, unknown>, applied: boolean): string {
  const lines = [
    "# keryx review jev-profile",
    "",
    applied ? "Recommended profile applied to `.metaproject/tasks.config.json` (`review.jev.*`)." : "Current `review.jev.*` state (not modified — `show`).",
    "",
    "| key | current | recommended | verdict |",
    "|---|---|---|---|",
  ];
  for (const entry of RECOMMENDED_JEV_PROFILE) {
    const value = current[entry.key];
    const currentLabel = typeof value === "boolean" ? String(value) : "(unset)";
    lines.push(`| ${entry.key} | ${currentLabel} | ${entry.recommended} | ${entry.verdict.replace(/\|/g, "\\|")} |`);
  }
  lines.push(
    "",
    "`edit_guard` is read by `keryx review jev-edit-guard`; this command only sets the key.",
  );
  return `${lines.join("\n")}\n`;
}
