// A hermetic "project" for the prepare / promote / remove tests: the shared git
// fixture plus a committed worktree configuration, a committed memory entry, a
// committed lock file, and untracked-but-ignored `.env` and `node_modules` in the
// main checkout. Never touches the real $HOME or the network.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMemoryService } from "../memory/service";
import type { RunInstall } from "./deps";
import { createFixture, fixtureGit, type Fixture } from "./test-support";

export interface ProjectFixture extends Fixture {
  /** Where tests point the user area (memory, learning) so the real ~/.keryx is never read or written. */
  userHome: string;
  /** Title of the memory entry committed on `main`. */
  committedMemoryTitle: string;
  /** Every install command the fake runner was asked to run. */
  installs: string[];
  runInstall: RunInstall;
}

const CONFIG = {
  version: 1,
  envFiles: [".env", ".env.local"],
  dependencies: [{ dir: "node_modules", lockfiles: ["bun.lock"], install: "fake-install" }],
  ports: { web: { env: "PORT", range: [5200, 5209] } },
  prepare: { rebuildIndexes: ["memory"] },
};

/** `isPortFree` for tests: every port is free, so allocation never depends on the machine. */
export const everyPortFree = (): boolean => true;

export async function createProjectFixture(): Promise<ProjectFixture> {
  const fixture = createFixture();
  const { base, main } = fixture;
  const userHome = path.join(base, "user-home");
  mkdirSync(userHome);

  writeFileSync(path.join(main, ".gitignore"), ".env\n.env.ignored\nnode_modules\n.metaproject/data/\n");
  mkdirSync(path.join(main, ".metaproject"));
  writeFileSync(path.join(main, ".metaproject", "worktree.config.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
  writeFileSync(path.join(main, "bun.lock"), "lock-v1\n");

  const committedMemoryTitle = "Worktree readiness lesson";
  await createMemoryService().create({ cwd: main, type: "lesson", slug: "worktree-readiness-lesson", title: committedMemoryTitle });
  // Search serves accepted entries by default; a committed entry is one someone accepted.
  const entryFile = path.join(main, ".metaproject", "memory", "lessons", "worktree-readiness-lesson.md");
  writeFileSync(entryFile, readFileSync(entryFile, "utf8").replace("Status: draft", "Status: accepted"));

  fixtureGit(base, main, ["add", "."]);
  fixtureGit(base, main, ["commit", "-q", "-m", "project"]);

  writeFileSync(path.join(main, ".env"), "SECRET=top-secret-value\n");
  writeFileSync(path.join(main, ".env.local"), "LOCAL=also-secret\n");
  mkdirSync(path.join(main, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(main, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

  const installs: string[] = [];
  const runInstall: RunInstall = async (command, cwd) => {
    installs.push(command);
    mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
    return { code: 0 };
  };
  return { ...fixture, userHome, committedMemoryTitle, installs, runInstall };
}

/** `git status --porcelain` (optionally with ignored files) of one checkout. */
export function statusOf(fixture: Fixture, cwd: string, ignored = false): string {
  return fixtureGit(fixture.base, cwd, ["status", "--porcelain", ...(ignored ? ["--ignored"] : [])]);
}
