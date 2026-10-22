import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export type CompletionWriter = (file: string, content: string) => Promise<void>;

export class ReviewCompletionChangedError extends Error {
  constructor() {
    super("Review completion snapshot changed; ask the current question again.");
    this.name = "ReviewCompletionChangedError";
  }
}

/** Track exact authorized writes, never re-baseline unrelated changes after a waiver. */
export function completionWriter(packageDir: string, snapshot: string): { write: CompletionWriter; assertUnchanged: () => void; rollback: () => void } {
  const parsed = JSON.parse(snapshot) as Record<string, string | null> | string[];
  // Old callers supplied the original five-file array; retain that API without weakening new snapshots.
  const names = Array.isArray(parsed) ? ["manifest.json", "report.md", "research.json", "findings.json", "decisions.md"] : Object.keys(parsed);
  const expected: Array<string | null> = Array.isArray(parsed) ? [...parsed] : names.map((name) => parsed[name] ?? null);
  const original = [...expected];
  const written = new Set<number>();
  const assertUnchanged = (): void => {
    for (const [index, name] of names.entries()) {
      let content: string | null;
      try { content = readFileSync(path.join(packageDir, name), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        content = Array.isArray(parsed) && name === "research.json" ? "{}" : null;
      }
      if (content !== expected[index]) throw new ReviewCompletionChangedError();
    }
  };
  const rollback = (): void => {
    const errors: unknown[] = [];
    for (const index of [...written].reverse()) {
      const file = path.join(packageDir, names[index]!);
      const temporary = `${file}.${randomUUID()}.rollback-tmp`;
      try {
        // Only undo our own last version; preserve any subsequently edited file.
        if (readFileSync(file, "utf8") !== expected[index]) continue;
        if (original[index] === null) {
          rmSync(file, { force: true });
          expected[index] = null;
          continue;
        }
        writeFileSync(temporary, original[index]!, { mode: 0o600, flag: "wx" });
        if (readFileSync(file, "utf8") === expected[index]) {
          renameSync(temporary, file);
          expected[index] = original[index]!;
        }
      } catch (error) {
        errors.push(error);
      } finally {
        try { rmSync(temporary, { force: true }); }
        catch (error) { errors.push(error); }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Review completion rollback failed");
  };
  return { assertUnchanged, rollback, write: async (file, content) => {
    const index = names.findIndex((name) => path.resolve(packageDir, name) === path.resolve(file));
    if (index < 0) throw new ReviewCompletionChangedError();
    const temporary = `${file}.${randomUUID()}.completion-tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      // No await between the final fence and rename: in-process callbacks cannot cross it.
      assertUnchanged();
      renameSync(temporary, file);
      expected[index] = content;
      written.add(index);
    } finally {
      rmSync(temporary, { force: true });
    }
  } };
}
