import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "./fs";
import { placePathWithinSync } from "./contained-path";

const MAX_ENTRIES = 12_000;
const MAX_BYTES = 64 * 1024 * 1024;

// Lifecycle operations with a conditional effect get a scope, not an exact
// digest-planned edit. Keep the scopes limited to service files, scaffolds,
// and hooks. Flow, wiki page, and graph storage trees are user/runtime data.
const SERVICE_SCOPES = [
  "metaproject.json", "README.md", "index.md", "routing.md", "keryx-dashboard.html",
  "assets.lock.json", "gdctx.config.json", "health.config.json", "testing.config.json",
  "memory.config.json", "security.config.json",
  "core", "modules", "rules", "skills", "project-skills", "templates",
  "hooks/README.md", "flows/README.md", "wiki/index.md", "wiki/templates", "wiki/testing",
  "memory/index.md", "memory/templates", "data/gdskills", "data/testing/context.md",
] as const;

export async function captureSetupWriteScope(root: string, commonDir: string | null, entrypointPaths: readonly string[]) {
  const hash = createHash("sha256");
  let entries = 0;
  let remainingBytes = MAX_BYTES;
  const paths = [
    ...SERVICE_SCOPES.map((relative) => `.metaproject/${relative}`),
    ".keryx/sandbox-policy.json", ".claude/settings.json", ".claude/settings.local.json",
    ".gitattributes", ...entrypointPaths.filter((relative) => relative !== "."),
  ];
  const hookPaths = commonDir ? ["config", "info/exclude", "info/attributes", "hooks/commit-msg", "hooks/keryx-commit-msg", "hooks/post-commit", "hooks/pre-push"] : [];

  async function capture(base: string, relative: string, ancestors = new Set<string>()): Promise<void> {
    if (++entries > MAX_ENTRIES) throw new Error("The setup write scope has too many entries to verify.");
    const placed = placePathWithinSync(base, relative, base);
    if (!placed.ok) throw new Error(placed.message);
    const target = placed.path;
    hash.update(JSON.stringify([relative, path.relative(base, target)]));
    const metadata = await lstat(target).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!metadata) {
      hash.update("missing");
      return;
    }
    if (metadata.isDirectory()) {
      if (ancestors.has(target)) throw new Error(`Directory alias cycle in setup scope: ${relative}.`);
      const next = new Set(ancestors).add(target);
      hash.update("directory");
      for (const name of (await readdir(target)).sort()) {
        await capture(base, path.join(relative, name), next);
      }
      return;
    }
    if (!metadata.isFile()) throw new Error(`Expected a regular file in setup scope: ${relative}.`);
    const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > remainingBytes) throw new Error("The setup write scope could not be verified within its read limit.");
      const bytes = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== opened.size) throw new Error(`The file changed during preview: ${relative}.`);
      remainingBytes -= offset;
      hash.update(JSON.stringify([opened.mode, createHash("sha256").update(bytes.subarray(0, offset)).digest("hex")]));
    } finally {
      await handle.close();
    }
  }

  for (const relative of [...new Set(paths)].sort()) await capture(root, relative);
  if (commonDir) for (const relative of hookPaths) await capture(commonDir, relative);
  return {
    fingerprint: hash.digest("hex"),
    effects: [
      { paths: SERVICE_SCOPES.map((relative) => `.metaproject/${relative}`), detail: "Refresh managed service files or create missing scaffolds according to the selected modules." },
      { paths: [".claude/settings.json", ".claude/settings.local.json", ".keryx/sandbox-policy.json"], detail: "Reconcile managed settings or create the local policy skeleton if missing." },
      ...(commonDir ? [{ paths: hookPaths.filter((relative) => relative.startsWith("hooks/")).map((relative) => `Git common directory/${relative}`), detail: "Reconcile the managed hook blocks." }] : []),
    ],
  };
}
