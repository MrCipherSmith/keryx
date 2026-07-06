import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { ScopeMetrics, ScopeSelector } from "./types";

export type BaselineEntry = { health_score: number; risk_score: number };
export type BaselineFile = {
  generatedAt: string;
  scopes: Record<string, BaselineEntry>;
};

function baselinePath(cwd: string): string {
  return path.join(cwd, ".metaproject", "health", "baselines", "scores.json");
}

export async function loadBaseline(
  cwd: string,
): Promise<Map<string, BaselineEntry>> {
  const file = baselinePath(cwd);
  if (!(await pathExists(file))) {
    return new Map();
  }
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as BaselineFile;
    return new Map(Object.entries(data.scopes ?? {}));
  } catch {
    return new Map();
  }
}

export async function hasBaseline(cwd: string): Promise<boolean> {
  return pathExists(baselinePath(cwd));
}

export async function writeBaseline(
  cwd: string,
  metrics: ScopeMetrics[],
  generatedAt: string,
  selector?: ScopeSelector,
): Promise<string[]> {
  const existing = await loadBaseline(cwd);
  const updated: string[] = [];

  for (const metric of metrics) {
    if (selector && !scopeMatches(selector, metric)) {
      continue;
    }
    existing.set(metric.key, {
      health_score: metric.health_score,
      risk_score: metric.risk_score,
    });
    updated.push(metric.key);
  }

  const scopes: Record<string, BaselineEntry> = {};
  for (const [key, value] of [...existing.entries()].sort()) {
    scopes[key] = value;
  }

  const file = baselinePath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ generatedAt, scopes }, null, 2)}\n`,
    "utf8",
  );
  return updated;
}

function scopeMatches(selector: ScopeSelector, metric: ScopeMetrics): boolean {
  switch (selector.kind) {
    case "project":
      return true;
    case "module":
      return metric.kind === "module" && metric.name === selector.name;
    case "file":
      return metric.kind === "file" && metric.name === selector.path;
    case "changed":
      return true;
  }
}
