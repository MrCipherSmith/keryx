// T20 finding 3 (flow 234 review, MAJOR): `renderSearchMarkdown` (memory/
// search.ts) carries full AFC-25/AC6 provenance (version, scope, source/link,
// author, confirmedBy, caveat) but had no production caller anywhere in the
// tree -- the real `keryx memory search` command built its own inline
// one-line-per-result renderer that carried no provenance at all. These tests
// exercise the command function directly (mirrors `gdgraph.test.ts`'s
// `gdgraphCommand` pattern: chdir into a fixture, capture console output,
// reset `process.exitCode`), proving the CLI's actual text output -- not just
// the renderer in isolation -- now shows what AC6 requires.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryCommand } from "./memory";

describe("keryx memory search — routed through the shared provenance-preserving renderer", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let loggedErr: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-memory-search-cmd-"));
    cwd = process.cwd();
    process.chdir(root);

    await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "memory", "decisions", "canary.md"),
      `# Roll out canary deploys for the release pipeline

Version: 3.4.1
Type: decision
Status: accepted
Confidence: high

## Summary

Adopt canary deploys for the release pipeline.

## Provenance

- Source: pr#901
- Link: https://example.invalid/pr/901
- Author: author:carol
- Confirmed-By: reviewer:alice
- Created: 2026-06-01
- Updated: 2026-06-01
`,
      "utf8",
    );

    loggedOut = [];
    loggedErr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(cwd);
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("the real CLI text output carries version, scope, provenance, author and confirming participant", async () => {
    await memoryCommand(["search", "canary deploys release pipeline"]);

    expect(process.exitCode).toBe(0);
    const output = loggedOut.join("\n");
    expect(output).toContain("Roll out canary deploys for the release pipeline");
    expect(output).toContain("decisions/canary.md");
    // The defect: before the fix, none of this appeared anywhere in the
    // command's real output -- only the score/title/type/status/path.
    expect(output).toContain("version: 3.4.1");
    expect(output).toContain("provenance: pr#901");
    expect(output).toContain("https://example.invalid/pr/901");
    expect(output).toContain("author: author:carol");
    expect(output).toContain("confirmedBy: reviewer:alice");
  });

  test("an unsourced entry shows the explicit unknown sentinel, never a dropped/blank line", async () => {
    await writeFile(
      path.join(root, ".metaproject", "memory", "decisions", "unsourced.md"),
      "# Adopt trunk-based development for the release pipeline\n\nType: decision\nStatus: accepted\n\n## Summary\n\nAdopt trunk-based development for the release pipeline.\n",
      "utf8",
    );

    await memoryCommand(["search", "trunk-based development release pipeline"]);

    expect(process.exitCode).toBe(0);
    const output = loggedOut.join("\n");
    expect(output).toContain("Adopt trunk-based development for the release pipeline");
    expect(output).toContain("provenance: unknown");
    expect(output).toContain("author: unknown");
    expect(output).toContain("confirmedBy: unknown");
  });

  test("--json output is unaffected by the markdown renderer wiring", async () => {
    await memoryCommand(["search", "canary deploys release pipeline", "--json"]);

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(loggedOut.join("\n")) as { results: Array<{ path: string }> };
    expect(payload.results.map((r) => r.path)).toContain("decisions/canary.md");
  });

  // T24 (flow 234) F-005 (MAJOR): `--json` used to hand-roll five fields
  // (score/title/type/status/path), dropping every AC6 provenance carrier the
  // human text form above already shows (version, provenance.source/link,
  // author, confirmedBy) -- and because the keys were simply absent, a
  // consumer of the JSON form could not tell "this entry has no source" apart
  // from "this surface doesn't report sources at all". These assert the JSON
  // form now carries the SAME provenance the text form does, built from the
  // report formatter's own per-result projection (`renderMemorySearchReport`,
  // `../memory/report.ts`) rather than a hand-rolled, strictly weaker subset.
  test("--json carries the same AC6 provenance the text form does (version, provenance, author, confirmedBy)", async () => {
    await memoryCommand(["search", "canary deploys release pipeline", "--json"]);

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(loggedOut.join("\n")) as {
      results: Array<{
        path: string;
        version: string;
        provenance: { source: string; link: string };
        author: string;
        confirmedBy: string;
      }>;
    };
    const canary = payload.results.find((r) => r.path === "decisions/canary.md");
    expect(canary?.version).toBe("3.4.1");
    expect(canary?.provenance).toEqual({ source: "pr#901", link: "https://example.invalid/pr/901" });
    expect(canary?.author).toBe("author:carol");
    expect(canary?.confirmedBy).toBe("reviewer:alice");
  });

  test("--json shows the explicit 'unknown' sentinel for an unsourced entry, never a dropped/absent key", async () => {
    await writeFile(
      path.join(root, ".metaproject", "memory", "decisions", "unsourced.md"),
      "# Adopt trunk-based development for the release pipeline\n\nType: decision\nStatus: accepted\n\n## Summary\n\nAdopt trunk-based development for the release pipeline.\n",
      "utf8",
    );

    await memoryCommand(["search", "trunk-based development release pipeline", "--json"]);

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(loggedOut.join("\n")) as {
      results: Array<{
        path: string;
        version: string;
        provenance: { source: string; link: string };
        author: string;
        confirmedBy: string;
      }>;
    };
    const unsourced = payload.results.find((r) => r.path === "decisions/unsourced.md");
    expect(unsourced).toBeDefined();
    expect(unsourced?.version).toBe("unknown");
    expect(unsourced?.provenance).toEqual({ source: "unknown", link: "unknown" });
    expect(unsourced?.author).toBe("unknown");
    expect(unsourced?.confirmedBy).toBe("unknown");
  });
});

// AFC-06 (flow 234) T22 -- AC1's second half: "historical режим явно
// размечен". Memory already had the explicit mode (`--as-of`, overrides the
// default `current` exclusion) but only ever printed an entry's raw
// `status`, which does not distinguish e.g. an `accepted`-status entry
// that's merely future/expired relative to TODAY from one genuinely current.
// These tests exercise the real CLI, not `computeLifecycle` in isolation.
describe("keryx memory search --as-of — historical items are labelled with lifecycle state/reason", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let loggedErr: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-memory-asof-cmd-"));
    cwd = process.cwd();
    process.chdir(root);

    await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "memory", "decisions", "legacy-canary.md"),
      `# Retire the legacy canary rollout for the release pipeline

Type: decision
Status: deprecated

## Summary

Retire the legacy canary rollout for the release pipeline.
`,
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "memory", "decisions", "current-canary.md"),
      `# Keep canary rollout current for the release pipeline

Type: decision
Status: accepted

## Summary

Keep canary rollout current for the release pipeline.
`,
      "utf8",
    );

    loggedOut = [];
    loggedErr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(cwd);
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("default retrieval (no --as-of): the deprecated entry is absent and no Historical section appears", async () => {
    await memoryCommand(["search", "canary rollout release pipeline"]);

    expect(process.exitCode).toBe(0);
    const output = loggedOut.join("\n");
    expect(output).not.toContain("legacy canary rollout");
    expect(output).not.toContain("## Historical");
  });

  test("--as-of admits the deprecated entry and labels it with state and reason in the real text output", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await memoryCommand(["search", "canary rollout release pipeline", "--as-of", today]);

    expect(process.exitCode).toBe(0);
    const output = loggedOut.join("\n");
    expect(output).toContain("Retire the legacy canary rollout for the release pipeline");
    expect(output).toContain("## Historical");
    expect(output).toContain("state=deprecated");
    expect(output).toContain("reason=status-deprecated");
  });

  test("--as-of --json: the same historical labelling appears as structured fields", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await memoryCommand(["search", "canary rollout release pipeline", "--as-of", today, "--json"]);

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(loggedOut.join("\n")) as {
      results: Array<{ path: string; historical?: boolean; lifecycleState?: string; lifecycleReasons?: string[] }>;
    };
    const legacy = payload.results.find((r) => r.path === "decisions/legacy-canary.md");
    expect(legacy?.historical).toBe(true);
    expect(legacy?.lifecycleState).toBe("deprecated");
    expect(legacy?.lifecycleReasons).toEqual(["status-deprecated"]);

    const current = payload.results.find((r) => r.path === "decisions/current-canary.md");
    expect(current?.historical).toBeUndefined();
  });
});
