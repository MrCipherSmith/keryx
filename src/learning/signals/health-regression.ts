// W3 spec, "Deterministic extraction signals" > "Health regressions". Reuses
// `parseHealthFindings` from `src/gdskills/learn.ts` (exported, unchanged
// behaviour) rather than re-implementing the "what counts as a finding"
// shape. Reads `.metaproject/data/health/history/*.json` — the durable,
// stamped run history `keryx health run` already writes
// (`src/health/run.ts` `writeOutputs`) — never re-runs health checks itself.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseHealthFindings } from "../../gdskills/learn";
import { clampLearningText } from "./text";
import type { ObservationLine, SignalDraft, SignalRunner } from "./types";

const HEALTH_HISTORY_DIR = ["data", "health", "history"] as const;

async function listHealthReportFiles(root: string): Promise<string[]> {
  const dir = path.join(root, ".metaproject", ...HEALTH_HISTORY_DIR);
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function reportGeneratedAt(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { generatedAt?: unknown };
    return typeof parsed.generatedAt === "string" ? parsed.generatedAt : null;
  } catch {
    return null;
  }
}

type Occurrence = {
  file: string;
  index: number;
  suggestedAction: string | null;
  observedAt: string;
};

/**
 * A finding (matched by `scope.skill` + `message`) present in `>= 2` distinct
 * health-report files yields one draft, with one evidence item per
 * occurrence (so a third and further repeat keep reinforcing the same
 * record via `extract.ts`'s evidence dedup, rather than each producing a new
 * draft for the same finding).
 */
export async function healthRegressionSignal(root: string, _window: ObservationLine[]): Promise<SignalDraft[]> {
  const files = await listHealthReportFiles(root);
  if (files.length < 2) return [];

  const bySkillMessage = new Map<string, Occurrence[]>();
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(path.join(root, ".metaproject", ...HEALTH_HISTORY_DIR, file), "utf8");
    } catch {
      continue;
    }
    const generatedAt = reportGeneratedAt(raw) ?? new Date(0).toISOString();
    parseHealthFindings(raw).forEach((finding, index) => {
      const skill = finding.scope?.skill;
      if (!skill || typeof finding.message !== "string" || finding.message.length === 0) return;
      const key = `${skill}\u0000${finding.message}`;
      const occurrence: Occurrence = {
        file,
        index,
        suggestedAction: typeof finding.suggestedAction === "string" ? finding.suggestedAction : null,
        observedAt: generatedAt,
      };
      const existing = bySkillMessage.get(key);
      if (existing) existing.push(occurrence);
      else bySkillMessage.set(key, [occurrence]);
    });
  }

  const drafts: SignalDraft[] = [];
  for (const [key, occurrences] of bySkillMessage) {
    const distinctFiles = new Set(occurrences.map((occurrence) => occurrence.file));
    if (distinctFiles.size < 2) continue;
    const separator = key.indexOf("\u0000");
    const skill = key.slice(0, separator);
    const message = key.slice(separator + 1);
    const suggestedAction = occurrences.find((occurrence) => occurrence.suggestedAction !== null)?.suggestedAction ?? null;

    drafts.push({
      domain: "tooling",
      trigger: clampLearningText(`When Code Health repeatedly flags "${message}" in ${skill} in this project`),
      action: clampLearningText(
        suggestedAction ?? `Treat the repeat as confirmed: fix "${message}" in ${skill} rather than deferring it again.`,
      ),
      evidence: occurrences.map((occurrence) => ({
        kind: "reinforcement" as const,
        sourceType: "health" as const,
        sourceRef: path.posix.join(".metaproject", ...HEALTH_HISTORY_DIR, `${occurrence.file}#finding-${occurrence.index}`),
        observedAt: occurrence.observedAt,
        weight: 1,
      })),
      extractor: "health-regression",
    });
  }
  return drafts;
}

export const HEALTH_REGRESSION_SIGNAL: SignalRunner = {
  name: "health-regression",
  domain: "tooling",
  run: healthRegressionSignal,
};
