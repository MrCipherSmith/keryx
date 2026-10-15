// The pointer to the review package whose orchestrator call log is being written (flow 454).
// `review start|attach` writes it, `review complete` removes it. It lives in the project's data
// directory and is not committed. It is honoured only while the manifest it names exists and is not
// closed, so a review that crashed leaves a stale pointer that records nothing.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const ACTIVE_REVIEW_DIR = path.join(".metaproject", "data", "review-active");
const POINTER_FILE = "active-review.json";

export interface ActiveReview {
  id: string;
  /** Absolute path of the package directory. */
  dir: string;
  startedAt: string;
}

function pointerPath(projectRoot: string): string {
  return path.join(projectRoot, ACTIVE_REVIEW_DIR, POINTER_FILE);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Points the project at `packageDir`. Never throws: a review that cannot write its pointer is simply not recorded. */
export async function writeActiveReview(
  projectRoot: string,
  review: { id: string; dir: string },
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const file = pointerPath(projectRoot);
    await mkdir(path.dirname(file), { recursive: true });
    const body: ActiveReview = { id: review.id, dir: path.resolve(projectRoot, review.dir), startedAt: now.toISOString() };
    await writeFile(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Removes the pointer; with `id`, only when it names that review (another review may have taken over since). */
export async function clearActiveReview(projectRoot: string, id?: string): Promise<void> {
  try {
    if (id !== undefined) {
      const current = await readPointer(projectRoot);
      if (current !== undefined && current.id !== id) return;
    }
    await rm(pointerPath(projectRoot), { force: true });
  } catch {
    // Nothing to clear, or nothing that can be cleared.
  }
}

async function readPointer(projectRoot: string): Promise<ActiveReview | undefined> {
  try {
    const parsed = JSON.parse(await readFile(pointerPath(projectRoot), "utf8")) as Partial<ActiveReview>;
    if (typeof parsed.id !== "string" || typeof parsed.dir !== "string" || typeof parsed.startedAt !== "string") return undefined;
    return { id: parsed.id, dir: parsed.dir, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

/** The package being recorded, or undefined: no pointer, one that names a missing or closed package, or one that leaves the project. */
export async function resolveActiveReview(projectRoot: string): Promise<ActiveReview | undefined> {
  const pointer = await readPointer(projectRoot);
  if (pointer === undefined) return undefined;
  const dir = path.resolve(projectRoot, pointer.dir);
  if (!inside(projectRoot, dir)) return undefined;
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { status?: unknown };
    if (manifest.status === "closed") return undefined;
  } catch {
    return undefined;
  }
  return { ...pointer, dir };
}
