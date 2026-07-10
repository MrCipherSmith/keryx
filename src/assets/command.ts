// Uniform `assets` subcommand (specification.md §6). Every opt-in module
// delegates here to gain `assets list | verify [<id>] | pull <id>`. This is the
// sole asset-management surface; only `pull` touches the network (`A-6`). The
// seam adds NO top-level command — modules mount this on `<module> assets ...`.
//
// The command is a pure function of `(cwd, module, args)` returning an exit code
// plus its rendered lines, so it is fully testable without a real network: the
// fetcher for `pull` is injectable.

import { loadAssetsLock } from "./lock";
import { registryFromLock } from "./lock";
import { resolveAsset } from "./resolver";
import { pullAsset, type AssetFetcher } from "./pull";

export interface AssetsCommandOptions {
  fetcher?: AssetFetcher;
  cache?: string;
}

export interface AssetsCommandResult {
  exitCode: number;
  lines: string[];
}

// Run `<module> assets <sub> [id]`. Returns the result rather than calling
// `process.exit`, so callers control I/O and tests can assert deterministically.
export async function runAssetsSubcommand(
  cwd: string,
  moduleName: string,
  args: string[],
  options: AssetsCommandOptions = {},
): Promise<AssetsCommandResult> {
  const sub = args[0];
  const rest = args.slice(1);
  const lock = await loadAssetsLock(cwd);
  const registry = registryFromLock(lock);

  if (!sub || sub === "list") {
    const lines: string[] = [`${moduleName} assets:`];
    const ids = Object.keys(lock.assets).sort();
    if (ids.length === 0) {
      lines.push("  (no assets declared in assets.lock.json)");
      return { exitCode: 0, lines };
    }
    for (const id of ids) {
      const resolved = await resolveAsset(registry, id);
      const state = resolved ? "resolved" : "missing";
      lines.push(`  ${id}  [${state}]`);
    }
    return { exitCode: 0, lines };
  }

  if (sub === "verify") {
    const ids = rest[0] ? [rest[0]] : Object.keys(lock.assets).sort();
    const lines: string[] = [];
    let failed = false;
    for (const id of ids) {
      if (!lock.assets[id]) {
        lines.push(`  ${id}: unknown asset (not in assets.lock.json)`);
        failed = true;
        continue;
      }
      const resolved = await resolveAsset(registry, id);
      if (resolved) {
        lines.push(`  ${id}: verified (${resolved.sha256})`);
      } else {
        lines.push(`  ${id}: unverified — missing or checksum mismatch`);
        failed = true;
      }
    }
    return { exitCode: failed ? 1 : 0, lines };
  }

  if (sub === "pull") {
    const id = rest[0];
    if (!id) {
      return { exitCode: 1, lines: ["usage: assets pull <id>"] };
    }
    try {
      const resolved = await pullAsset(id, lock, {
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.cache ? { destDir: options.cache } : {}),
      });
      return {
        exitCode: 0,
        lines: [`  ${id}: pulled and verified → ${resolved.path}`],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, lines: [`  ${id}: ${message}`] };
    }
  }

  return { exitCode: 1, lines: [`unknown assets subcommand: ${sub}`] };
}
