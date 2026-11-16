// A hand-edited index.md written by an older keryx blocks only the routing
// pair. `keryx update` must still install the current rules and skills: the
// old behaviour (publish nothing) left projects on the previous rule set.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const BUNDLED_RULE = path.join(import.meta.dir, "..", "gdskills", "bundled", "rules", "core", "api-contracts.mdc");

async function run(args: string[], cwd: string, home: string): Promise<{ code: number; out: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { HOME: home, XDG_DATA_HOME: home, KERYX_NONINTERACTIVE: "1" });
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}

test("a diverged index.md from an older writer still lets update install the current rules", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "keryx-upd-div-home-"));
  const project = mkdtempSync(path.join(tmpdir(), "keryx-upd-div-proj-"));
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
  const init = await run(["init", "--yes", "--no-gdgraph", "--no-health", "--no-testing"], project, home);
  expect(init.code).toBe(0);

  const meta = path.join(project, ".metaproject");
  // Make the recorded writer an older version, as after an npm upgrade.
  const journalPath = path.join(meta, "runtime", "install", "journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    writerVersion: string;
    steps: Record<string, { writerVersion: string }>;
  };
  journal.writerVersion = "0.0.1";
  for (const step of Object.values(journal.steps)) step.writerVersion = "0.0.1";
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");
  // The owner curated index.md; the installed rule is the previous release's.
  const indexPath = path.join(meta, "index.md");
  writeFileSync(indexPath, `${readFileSync(indexPath, "utf8")}\n<!-- curated by the owner -->\n`, "utf8");
  const rulePath = path.join(meta, "rules", "core", "api-contracts.mdc");
  writeFileSync(rulePath, "# previous release text\n", "utf8");

  const update = await run(["update", "--skip-runtime"], project, home);

  expect(readFileSync(rulePath, "utf8")).toBe(readFileSync(BUNDLED_RULE, "utf8"));
  expect(readFileSync(indexPath, "utf8")).toContain("<!-- curated by the owner -->");
  expect(update.out).toContain("Routing entrypoint not updated");
  expect(update.out).toContain("--keep-existing");
  expect(update.out).not.toContain("published nothing");
  expect(update.code).toBe(1);
}, 120_000);
