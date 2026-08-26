import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dedupeSeeds, type Slate, type SlateChildDispatch, type SlateSeed, type SlateSeedKind } from "../session/slate";
import type { CourseProjection } from "../session/slate-course";

const execFileAsync = promisify(execFile);

export type AttributedSeed = { text: string; kind: SlateSeedKind; source: "parent" | { childDispatchId: string } };

export function describeSource(source: AttributedSeed["source"]): string {
  return source === "parent" ? "parent" : `child:${source.childDispatchId}`;
}

export function dedupedAttributedSeeds(slate: Slate): AttributedSeed[] {
  const seen = new Set<string>();
  const result: AttributedSeed[] = [];
  const take = (seeds: SlateSeed[], source: AttributedSeed["source"]): void => {
    for (const seed of dedupeSeeds(seeds)) {
      const key = seed.text.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ text: seed.text, kind: seed.kind ?? "follow-up", source });
    }
  };
  take(slate.seeds, "parent");
  const children: Record<string, SlateChildDispatch> = slate.childDispatches ?? {};
  for (const [id, dispatch] of Object.entries(children)) take(dispatch.seeds, { childDispatchId: id });
  return result;
}

export async function gitDiff(cwd: string): Promise<string> {
  try { return (await execFileAsync("git", ["diff"], { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch { return ""; }
}

export function diffStatLine(diffText: string): string {
  if (diffText.trim().length === 0) return "no working-tree changes";
  return `working-tree diff: +${(diffText.match(/^\+(?!\+\+)/gm) ?? []).length}/-${(diffText.match(/^-(?!--)/gm) ?? []).length} line(s)`;
}

export function courseStatusLine(course: CourseProjection): string {
  if (course.state !== "bound") return "flow: unbound";
  return `flow ${course.flowRef.uri} snapshot=${course.flowRef.snapshot} completed=${course.completed.length} next=${course.next.length} blocked=${course.blocked.length}`;
}
