// Project wiki commands run in a terminal tab. Wiki enrich builds its arguments from a dialog.

/** One menu entry: the keryx arguments it runs (the program itself is the app's keryx). */
export interface ProjectCommand {
  id: string;
  label: string;
  description: string;
  args: readonly string[];
}

export const PROJECT_COMMANDS: readonly ProjectCommand[] = [
  { id: "wiki-status", label: "Wiki status", description: "Pages, drafts and what needs work", args: ["wiki", "status"] },
  { id: "wiki-collect", label: "Wiki collect", description: "Draft pages from graph, health and test data", args: ["wiki", "collect"] },
  { id: "wiki-index", label: "Wiki index", description: "Rebuild the wiki index", args: ["wiki", "index"] },
  { id: "wiki-validate", label: "Wiki validate", description: "Metadata, links and index checks", args: ["wiki", "validate"] },
  { id: "wiki-freshness", label: "Wiki freshness", description: "Pages the code has moved under", args: ["wiki", "freshness"] },
  { id: "wiki-refresh", label: "Wiki refresh", description: "Regenerate Reference blocks from the graph", args: ["wiki", "refresh"] },
];

/** `--concurrency` above this is clamped by keryx. */
export const MAX_CONCURRENCY = 16;

export interface EnrichSettings {
  /** One worker over the whole batch, or waves of related groups (`--group related`). */
  mode: "one" | "waves";
  /** Empty: the provider from auth.json, as the CLI picks it. */
  provider: string;
  /** Empty: the provider's default model. */
  model: string;
  groupMin: number;
  groupMax: number;
  /** Groups at a time (waves only). */
  concurrency: number;
  /** Drafts only, or every page (`--force`). */
  scope: "drafts" | "force";
  /** Internal keryx workers; external agents have no CLI path yet. */
  workers: "internal" | "external";
}

export const DEFAULT_ENRICH: EnrichSettings = {
  mode: "waves",
  provider: "",
  model: "",
  groupMin: 10,
  groupMax: 20,
  concurrency: 4,
  scope: "drafts",
  workers: "internal",
};

export type EnrichBuild = { ok: true; args: string[] } | { ok: false; error: string };

const isInt = (n: number) => Number.isInteger(n);
// Provider ids and model names: no whitespace or shell-special characters, never a flag.
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/** The `keryx wiki enrich` arguments for `s`, or why they cannot be built. */
export function buildEnrichArgs(s: EnrichSettings): EnrichBuild {
  if (s.workers === "external") return { ok: false, error: "External agents are not supported by keryx wiki enrich yet." };
  const provider = s.provider.trim();
  const model = s.model.trim();
  if (provider && !SAFE_VALUE.test(provider)) return { ok: false, error: "The provider id has characters keryx does not accept." };
  if (model && !SAFE_VALUE.test(model)) return { ok: false, error: "The model name has characters keryx does not accept." };
  const args = ["wiki", "enrich", "--all"];
  if (s.scope === "force") args.push("--force");
  if (s.mode === "waves") {
    if (!isInt(s.groupMin) || !isInt(s.groupMax) || s.groupMin < 1 || s.groupMax < 1) {
      return { ok: false, error: "Group sizes must be whole numbers of 1 or more." };
    }
    if (s.groupMin > s.groupMax) return { ok: false, error: "The smallest group cannot be larger than the largest." };
    if (!isInt(s.concurrency) || s.concurrency < 1) return { ok: false, error: "Groups at a time must be a whole number of 1 or more." };
    if (s.concurrency > MAX_CONCURRENCY) return { ok: false, error: `At most ${MAX_CONCURRENCY} groups at a time.` };
    args.push("--group", "related", "--group-size", `${s.groupMin}-${s.groupMax}`, "--concurrency", String(s.concurrency));
  }
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  return { ok: true, args };
}

/** `--list` over the same selection: prints the related groups and runs nothing. */
export function previewGroupsArgs(s: EnrichSettings): EnrichBuild {
  const built = buildEnrichArgs({ ...s, mode: "waves" });
  if (!built.ok) return built;
  const args = ["wiki", "enrich", "--list"];
  if (s.scope === "force") args.push("--force");
  args.push("--group", "related", "--group-size", `${s.groupMin}-${s.groupMax}`);
  return { ok: true, args };
}

/** A shell-readable form of `keryx <args>` for display (the app runs the argv itself, not this string). */
export function commandLine(args: readonly string[]): string {
  return ["keryx", ...args].map((a) => (/^[A-Za-z0-9._:/@+=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
