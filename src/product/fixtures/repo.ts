// Test support: lay the checked-in corpus out as a project root in a temp
// directory, so a test can index, edit and re-index it without touching the repo.

import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CORPUS = path.join(import.meta.dir, "corpus");

/** Five flows (four closed) and three requirements packages, as `.metaproject/flows` and `docs/requirements`. */
export async function copyFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-product-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await cp(path.join(CORPUS, "flows"), path.join(root, ".metaproject", "flows"), { recursive: true });
  await cp(path.join(CORPUS, "requirements"), path.join(root, "docs", "requirements"), { recursive: true });
  return root;
}

export const FIXTURE_COUNTS = {
  intents: 8,
  flows: 5,
  docpacks: 3,
  closed: 4,
  noCriterion: 2,
  notObserved: 1,
  observed: 1,
  unusable: 1,
} as const;
