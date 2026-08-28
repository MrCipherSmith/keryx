// Regression: the security module must write into the ENCLOSING project's
// `.metaproject/`, never into whatever directory the process was started in.
//
// Every security path was `path.join(cwd, ".metaproject", …)`. Run from a
// subdirectory — a docs folder, a fixture folder, a flow package — the module
// missed the project's config and created a second `.metaproject/` there
// holding `data/security/raw/hmac.key` + `data/security/raw/state.json`. The
// repository accumulated ten of those. The scattered directories are the
// visible half; the damaging half is that the per-project HMAC key (which is
// what keeps a finding hash from being brute-forceable) was regenerated per
// working directory, and the self-protection state that detects a mode
// downgrade or a disabled policy started empty on every such invocation, so a
// downgrade was never surfaced.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { analyze } from "./service";
import { configPath, securityDataRoot, renderSecurityConfig, DEFAULT_SECURITY_CONFIG } from "./config";
import { isSecurityEnabled } from "./guard";
import { getHmacKey } from "./redact";
import type { SecurityConfig } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-security-root-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeProject(dir: string, config?: SecurityConfig): Promise<void> {
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(dir, ".metaproject", "metaproject.json"),
    `${JSON.stringify({ modules: { security: { enabled: true } } }, null, 2)}\n`,
    "utf8",
  );
  if (config) {
    await writeFile(path.join(dir, ".metaproject", "security.config.json"), renderSecurityConfig(config), "utf8");
  }
}

test("analyze from a subdirectory writes into the project root and creates no nested .metaproject", async () => {
  await makeProject(root);
  const sub = path.join(root, "docs", "requirements", "some-package");
  await mkdir(sub, { recursive: true });

  await analyze(sub, { content: "nothing sensitive here\n", source: "trusted-project" });

  // The bug's exact tell: a `.metaproject/` materialising beside the caller.
  expect(existsSync(path.join(sub, ".metaproject"))).toBe(false);
  expect(existsSync(path.join(root, "docs", ".metaproject"))).toBe(false);
  expect(existsSync(path.join(root, "docs", "requirements", ".metaproject"))).toBe(false);

  // The state the module actually needs lands in the one project root.
  expect(existsSync(path.join(root, ".metaproject", "data", "security", "raw", "hmac.key"))).toBe(true);
  expect(existsSync(path.join(root, ".metaproject", "data", "security", "raw", "state.json"))).toBe(true);
});

test("the HMAC key is per PROJECT, not per working directory", async () => {
  await makeProject(root);
  const sub = path.join(root, "fixtures", "corpus");
  await mkdir(sub, { recursive: true });

  const fromRoot = await getHmacKey(root);
  const fromSub = await getHmacKey(sub);

  // A regenerated key silently changes every finding hash, which is what made
  // this more than a tidiness problem.
  expect(fromSub).toBe(fromRoot);
  expect(existsSync(path.join(sub, ".metaproject"))).toBe(false);
});

test("config and data paths resolve to the enclosing project from any depth", async () => {
  await makeProject(root, { ...DEFAULT_SECURITY_CONFIG, mode: "enforced" });
  const sub = path.join(root, "a", "b", "c");
  await mkdir(sub, { recursive: true });

  expect(configPath(sub)).toBe(configPath(root));
  expect(securityDataRoot(sub)).toBe(securityDataRoot(root));

  // The enabled-check drives every write seam; from a subdirectory it used to
  // report the module as disabled and skip the check entirely.
  expect(await isSecurityEnabled(sub)).toBe(true);
});

test("a genuine standalone project root still resolves to itself", async () => {
  await makeProject(root);

  expect(configPath(root)).toBe(path.join(root, ".metaproject", "security.config.json"));
  expect(securityDataRoot(root)).toBe(path.join(root, ".metaproject", "data", "security"));

  await analyze(root, { content: "plain text\n", source: "trusted-project" });
  expect(existsSync(path.join(root, ".metaproject", "data", "security", "raw", "hmac.key"))).toBe(true);
});

test("a directory with no project marker at all stays contained to itself", async () => {
  const bare = path.join(root, "bare");
  await mkdir(bare, { recursive: true });

  // No `.metaproject` and no `.git` anywhere above it (the temp root has
  // neither), so the fallback must be the directory itself — unchanged
  // behaviour for a fresh, un-initialised workspace.
  expect(securityDataRoot(bare)).toBe(path.join(bare, ".metaproject", "data", "security"));
});

test("a nested directory that IS its own project keeps its own .metaproject", async () => {
  await makeProject(root);
  // Test fixtures under `fixtures/` ship their own `.metaproject/` on purpose;
  // the walk must stop at the nearest marker rather than hoisting them to the
  // outer repository.
  const fixture = path.join(root, "fixtures", "temporal");
  await makeProject(fixture);

  expect(securityDataRoot(fixture)).toBe(path.join(fixture, ".metaproject", "data", "security"));
  expect(securityDataRoot(path.join(fixture, "deeper"))).toBe(
    path.join(fixture, ".metaproject", "data", "security"),
  );
});

// End-to-end through the CLI, because that is how every stray directory in this
// repository was actually produced: an agent ran `keryx security …` with its
// shell sitting in a subdirectory.
test("`keryx security check-input` from a subdirectory leaves no .metaproject behind", async () => {
  await makeProject(root);
  const sub = path.join(root, "docs", "requirements");
  await mkdir(sub, { recursive: true });

  const cli = path.join(import.meta.dir, "..", "cli.ts");
  const proc = Bun.spawn(["bun", cli, "security", "check-input", "--json"], {
    cwd: sub,
    stdin: new TextEncoder().encode("just a sentence\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  expect(existsSync(path.join(sub, ".metaproject"))).toBe(false);
  expect(existsSync(path.join(root, "docs", ".metaproject"))).toBe(false);
  expect(existsSync(path.join(root, ".metaproject", "data", "security", "raw", "state.json"))).toBe(true);
}, 60_000);
