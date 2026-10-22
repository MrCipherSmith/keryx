import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { withFileLock } from "../lib/fs";

const owners = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

/** Serialize completion and its waivers across processes; nested waiver writes share ownership. */
export async function withCompletionLock<T>(packageDir: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(packageDir, ".completion.lock");
  if (owners.getStore()?.get(key)?.active) return work();
  return withFileLock(key, async () => {
    const owner = { active: true };
    const scope = new Map(owners.getStore());
    scope.set(key, owner);
    try { return await owners.run(scope, work); }
    finally { owner.active = false; }
  });
}
