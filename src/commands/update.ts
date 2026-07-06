import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import path from "node:path";
import { pathExists } from "../lib/fs";

export async function updateCommand(): Promise<void> {
  const runtimeRoot = findRuntimeRoot(process.cwd());

  if (runtimeRoot) {
    await run("git", ["fetch", "--depth", "1", "origin", "main"], runtimeRoot);
    await run("git", ["checkout", "--force", "FETCH_HEAD"], runtimeRoot);
    console.log(`Updated runtime: ${runtimeRoot}`);
  } else {
    console.log("Runtime update skipped: no managed runtime found.");
  }

  await runPostUpdateHooks(process.cwd());
}

function findRuntimeRoot(projectRoot: string): string | null {
  const projectRuntime = path.join(projectRoot, ".metaproject", "runtime", "gd-metapro");
  if (existsSync(path.join(projectRuntime, ".git"))) {
    return projectRuntime;
  }

  const globalRuntime = path.join(process.env.HOME ?? "", ".gd-metapro", "gd-metapro");
  if (existsSync(path.join(globalRuntime, ".git"))) {
    return globalRuntime;
  }

  return null;
}

async function runPostUpdateHooks(projectRoot: string): Promise<void> {
  const hooksDir = path.join(projectRoot, ".metaproject", "hooks", "post-update.d");
  if (!(await pathExists(hooksDir))) {
    return;
  }

  const entries = (await readdir(hooksDir)).sort();
  for (const entry of entries) {
    const hookPath = path.join(hooksDir, entry);
    try {
      await access(hookPath, constants.X_OK);
    } catch {
      continue;
    }

    console.log(`Running post-update hook: ${entry}`);
    await run(hookPath, [], projectRoot);
  }
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}
