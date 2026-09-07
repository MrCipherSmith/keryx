import { readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "./fs";
import {
  renderRoutingEntrypointPair,
  ROUTING_FILENAME,
  type RoutingEntrypointOptions,
  type RoutingEntrypointPair,
} from "./templates";

const ROUTING_LOCK_FILENAME = ".routing-entrypoint.lock";

/**
 * Publish the full router before its compact pointer under one Keryx writer
 * lock. A failed file operation is propagated; rerunning safely recalculates
 * both documents and skips any member that already has the expected bytes.
 */
export async function writeRoutingEntrypointPair(
  metaprojectRoot: string,
  options: RoutingEntrypointOptions,
): Promise<RoutingEntrypointPair> {
  const pair = renderRoutingEntrypointPair(options);
  return withFileLock(path.join(metaprojectRoot, ROUTING_LOCK_FILENAME), async () => {
    await writeTextIfChanged(path.join(metaprojectRoot, ROUTING_FILENAME), pair.routing);
    await writeTextIfChanged(path.join(metaprojectRoot, "index.md"), pair.index);
    return pair;
  });
}

async function writeTextIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await readFile(filePath, "utf8")) === content) {
      return;
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  await writeFileAtomic(filePath, content);
}
