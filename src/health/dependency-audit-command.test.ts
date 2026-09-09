import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditCommand, dependencyAuditAdapter } from "./sources/dependency-audit";

/**
 * F-240-02's sibling in production code (flow 240 T6).
 *
 * The adapter chose its command from BINARY PRESENCE:
 *
 *   const bun = resolveBin(ctx.cwd, "bun");
 *   const command = bun ? [bun, "audit", "--json"] : [npm, "audit", "--json"];
 *
 * so on any machine with Bun installed — most machines that run this tool — an
 * npm project got `bun audit`, which has no `bun.lock` to resolve. Same
 * confusion as the shipped skill's, from the other direction: "this tool exists"
 * is not "this tool can audit THIS project".
 */

/** A workspace with fake, executable `bun`/`npm`/`pnpm` in node_modules/.bin. */
async function workspace(lockfiles: string[], bins = ["bun", "npm", "pnpm"]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-audit-cmd-"));
  const binDir = path.join(root, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  for (const bin of bins) {
    const file = path.join(binDir, bin);
    await writeFile(file, "#!/bin/sh\nprintf '{}\\n'\n", "utf8");
    await chmod(file, 0o755);
  }
  for (const lockfile of lockfiles) await writeFile(path.join(root, lockfile), "", "utf8");
  return root;
}

async function chosenBinary(lockfiles: string[], bins?: string[]): Promise<string> {
  const root = await workspace(lockfiles, bins);
  try {
    return path.basename(auditCommand(root)[0] ?? "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the audit command follows the lockfile, not whichever binary is installed", async () => {
  // Every binary is present in all four cases, so only the lockfile can be
  // deciding. Before the fix all four answered "bun".
  expect(await chosenBinary(["bun.lock"])).toBe("bun");
  expect(await chosenBinary(["bun.lockb"])).toBe("bun");
  expect(await chosenBinary(["package-lock.json"])).toBe("npm");
  expect(await chosenBinary(["npm-shrinkwrap.json"])).toBe("npm");
  expect(await chosenBinary(["pnpm-lock.yaml"])).toBe("pnpm");
});

test("no recognised lockfile keeps the previous binary-based choice", async () => {
  // Not a refusal to run: the adapter cannot know that a project without a root
  // lockfile has nothing to audit (workspaces, vendored manifests). What must
  // never happen is that attempt reporting zero advisories, which `validate()`
  // refuses below.
  expect(await chosenBinary([])).toBe("bun");
});

/**
 * The measured shape of the failure F-240-02 named, asserted against the real
 * decoder: `npm audit --json` without a lockfile exits 1 and writes 240 bytes
 * that parse to `keys: ["error"]`, with `vulnerabilities: undefined`. Grouping
 * that by severity yields zero for every severity — a broken check reading as a
 * clean one. The adapter must refuse to read it as a result at all.
 */
test("npm's ENOLOCK envelope is not a clean audit", () => {
  const enolock = JSON.stringify({
    error: {
      code: "ENOLOCK",
      summary: "This command requires an existing lockfile.",
      detail: "Try creating one first with: npm i --package-lock-only",
    },
  });
  const raw = {
    source: "dependencyAudit",
    command: "npm audit --json",
    toolVersion: null,
    exitCode: 1,
    rawPath: "",
    content: enolock,
    imported: false,
  };

  expect(dependencyAuditAdapter.validate?.(raw)).toMatchObject({ valid: false });
  expect(dependencyAuditAdapter.parse(raw, {} as never)).toHaveLength(0);
});

test("an audit that really did run and found nothing is still recognised", () => {
  // Non-vacuity for the assertion above: `valid: false` must mean "not a
  // result", not "no findings". `bun audit` prints `{}` for a clean project.
  const raw = {
    source: "dependencyAudit",
    command: "bun audit --json",
    toolVersion: null,
    exitCode: 0,
    rawPath: "",
    content: "{}",
    imported: false,
  };
  expect(dependencyAuditAdapter.validate?.(raw)).toMatchObject({ valid: true });
  expect(dependencyAuditAdapter.parse(raw, {} as never)).toHaveLength(0);
});
