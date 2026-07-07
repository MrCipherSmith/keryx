import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { computeComplexity } from "./metrics/complexity";

export type SourceFileAnalysis = {
  file: string;
  loc: number;
  complexity: number[];
};

export async function analyzeSourceFiles(
  cwd: string,
  sourceFiles: string[],
): Promise<Map<string, SourceFileAnalysis>> {
  const entries = await Promise.all(sourceFiles.map((file) => analyzeSourceFile(cwd, file)));
  return new Map(entries.filter((entry): entry is [string, SourceFileAnalysis] => entry !== null));
}

async function analyzeSourceFile(
  cwd: string,
  file: string,
): Promise<[string, SourceFileAnalysis] | null> {
  const abs = path.join(cwd, file);
  if (!(await pathExists(abs))) {
    return null;
  }
  const content = await readFile(abs, "utf8");
  return [
    file,
    {
      file,
      loc: content.split("\n").length,
      complexity: computeComplexity(content).functions,
    },
  ];
}
