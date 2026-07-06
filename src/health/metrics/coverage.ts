import { existsSync } from "node:fs";
import path from "node:path";
import type { SourceStatus } from "../types";

const SUMMARY_PATHS = [
  "coverage/coverage-summary.json",
  "coverage/coverage-final.json",
];

export type CoverageData = {
  status: SourceStatus;
  total: number | null;
  byFile: Map<string, number>;
};

// Reads Istanbul-style coverage-summary.json when present.
export async function getCoverage(cwd: string): Promise<CoverageData> {
  const summary = SUMMARY_PATHS.map((rel) => path.join(cwd, rel)).find((abs) =>
    existsSync(abs),
  );
  if (!summary) {
    return { status: "missing", total: null, byFile: new Map() };
  }

  let data: Record<string, { lines?: { pct?: number } }>;
  try {
    data = JSON.parse(await Bun.file(summary).text());
  } catch {
    return { status: "configured-but-failed", total: null, byFile: new Map() };
  }

  const byFile = new Map<string, number>();
  let total: number | null = null;

  for (const [key, value] of Object.entries(data)) {
    const pct = value?.lines?.pct;
    if (typeof pct !== "number") {
      continue;
    }
    if (key === "total") {
      total = pct;
      continue;
    }
    const relative = path.isAbsolute(key) ? path.relative(cwd, key) : key;
    byFile.set(relative.replace(/\\/g, "/"), pct);
  }

  return { status: "available", total, byFile };
}
