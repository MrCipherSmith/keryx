// flow 335 (AC1/AC2/AC6/AC7): `keryx review jev-contract`, driven through the
// real CLI dispatcher — fixture PR via `--pr --fixtures`, fixture Jev
// responses, schema validation against `reviewer-finding.schema.json`, and
// the `--flow` linked-acceptance-criteria track (reusing `runCheckAc`).
// Hermetic: no network (a fixtures dir stands in for Jev/gh), macOS-safe
// (mkdtemp under the OS tmp dir).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { validateJson } from "../gdskills/contracts";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps } from "../flow/types";
import { computeJevContractResult } from "./review-jev-contract";

type JsonSchema = Parameters<typeof validateJson>[1];

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

async function projectRoot(enabled: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-contract-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { contract: enabled } } }), "utf8");
  return dir;
}

async function writePrFixture(root: string, body: string, diff: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-contract-pr-"));
  await writeFile(path.join(dir, "pr.json"), JSON.stringify({ number: 42, title: "Add widget, no API change", body, diff }), "utf8");
  // `fixtureJevFetch` reads this eagerly even when no call is ever made
  // (e.g. `--max-calls 0`) — an empty queue is a valid "zero calls expected" fixture.
  await writeFile(path.join(dir, "jev-responses.json"), "[]", "utf8");
  return dir;
}

async function appendJevResponses(fixturesDir: string, responses: unknown[]): Promise<void> {
  const jsonPath = path.join(fixturesDir, "jev-responses.json");
  const existing = (await Bun.file(jsonPath).exists()) ? (JSON.parse(await readFile(jsonPath, "utf8")) as unknown[]) : [];
  await writeFile(jsonPath, JSON.stringify([...existing, ...responses]), "utf8");
}

function flowDeps(): FlowServiceDeps {
  return { tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-09-25T00:00:00Z") };
}

/** Same shape `flow-check-ac.test.ts`'s own `frozenFlow` uses. */
async function frozenFlow(root: string, title: string, criteria: string): Promise<string> {
  const service = createFlowService(flowDeps());
  const created = await service.init({ cwd: root, title });
  const dir = path.basename(created.dir);
  await writeFile(path.join(root, ".metaproject", "flows", dir, "acceptance-criteria.md"), `# Acceptance Criteria\n\n## Criteria\n\n${criteria}\n`, "utf8");
  await service.freeze({ cwd: root, id: dir });
  return dir;
}

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ORIGINAL_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
  }
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

const DIFF = ["diff --git a/src/widget.ts b/src/widget.ts", "index 0000000..1111111 100644", "--- a/src/widget.ts", "+++ b/src/widget.ts", "@@ -1,1 +1,2 @@", " export {};", "+export function widget() {}", ""].join("\n");

describe("AC1/AC2/AC6: keryx review jev-contract --pr <n> --fixtures <dir> --json", () => {
  test("a contradicted no-change claim is major; an unsupported claim is minor; both schema-valid", async () => {
    ROOT = await projectRoot(true);
    const body = ["- Does not change the public API.", "- Adds a brand-new retry mechanism for flaky requests."].join("\n");
    const fixturesDir = await writePrFixture(ROOT, body, DIFF);
    // CLAIM1 ("Does not change the public API.") is contradicted by facts
    // regardless of its noul score; CLAIM2 scores low, so it is unsupported.
    await appendJevResponses(fixturesDir, [
      { answers: { CLAIM1: { type: "noul", noul: 0.9 }, CLAIM2: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 100, output_tokens: 5, cost: 0.001 } },
    ]);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-contract", "--pr", "42", "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as {
      status: string;
      reviewer: string;
      findings: Array<Record<string, unknown>>;
      stats: Record<string, number>;
      claims: Array<{ id: string; intent: string }>;
    };
    expect(parsed.reviewer).toBe("review-jev-contract");
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.findings).toHaveLength(2);
    const major = parsed.findings.find((f) => f.severity === "major");
    const minor = parsed.findings.find((f) => f.severity === "minor");
    expect(major).toBeDefined();
    expect(minor).toBeDefined();
    expect(major?.class_scope).toBeDefined();
    expect(process.exitCode ?? 0).toBe(0);

    const schemaRaw = await readFile(
      path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-orchestrator", "reviewer-finding.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(schemaRaw) as JsonSchema;
    const errors = await validateJson(parsed, schema);
    expect(errors).toEqual([]);
  });

  test("a claim evidenced at/above threshold produces no finding", async () => {
    ROOT = await projectRoot(true);
    const fixturesDir = await writePrFixture(ROOT, "- Adds a brand-new widget function.", DIFF);
    await appendJevResponses(fixturesDir, [{ answers: { CLAIM1: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 50, output_tokens: 5, cost: 0.0005 } }]);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-contract", "--pr", "42", "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; status: string; tokens: { jevCalls: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.status).toBe("DONE");
    expect(parsed.tokens.jevCalls).toBe(1);
  });

  test("--max-calls caps the claims scored, reported rather than silently truncated", async () => {
    ROOT = await projectRoot(true);
    const body = ["- Adds a widget.", "- Fixes a bug.", "- Removes dead code."].join("\n");
    const fixturesDir = await writePrFixture(ROOT, body, DIFF);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-contract", "--pr", "42", "--fixtures", fixturesDir, "--max-calls", "0", "--json"]);
    const parsed = JSON.parse(output()) as { budget: { maxCalls: number; claimsScored: number; claimsSkipped: number }; tokens: { jevCalls: number } };
    expect(parsed.budget.maxCalls).toBe(0);
    expect(parsed.budget.claimsScored).toBe(0);
    expect(parsed.budget.claimsSkipped).toBe(3);
    expect(parsed.tokens.jevCalls).toBe(0);
  });
});

describe("AC4: --flow reuses check-ac.ts's frozen-criteria pipeline, no duplicated logic", () => {
  test("a linked flow's acceptance criteria are checked and merged into the output as acCheck", async () => {
    ROOT = await projectRoot(true);
    const flowDir = await frozenFlow(ROOT, "widget flow", "- AC1: `src/widget.ts` exports `widget`, evidenced in the diff.\n- AC2: `src/nowhere/absent.ts` is touched (it never is).");
    const fixturesDir = await writePrFixture(ROOT, "- Adds a widget.", DIFF);
    await appendJevResponses(fixturesDir, [{ answers: { CLAIM1: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 50, output_tokens: 5, cost: 0.0005 } }]);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-contract", "--pr", "42", "--flow", flowDir, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as {
      acCheck?: { flowId: string; verdicts: Array<{ id: string; status: string }>; jevAsked: boolean; summary: Record<string, number> };
    };
    expect(parsed.acCheck).toBeDefined();
    expect(parsed.acCheck?.verdicts.map((v) => v.id)).toEqual(["AC1", "AC2"]);
    // review.jev.ac_check is not opted in for this test project, so the AC
    // track degrades to facts-only — no extra Jev call is made or consumed.
    expect(parsed.acCheck?.jevAsked).toBe(false);
  });
});

describe("a Jev batch failure (e.g. a real vendor max_tokens_exceeded) degrades only that batch, never the whole run", () => {
  test("computeJevContractResult reports jevError and still returns facts-only claims", async () => {
    const description = "- Adds a brand-new widget function.\n- Fixes a bug.";
    const throwingFetch = (async () => {
      throw new Error('HTTP 400 — {"detail":{"error_type":"max_tokens_exceeded"}}');
    }) as unknown as typeof fetch;
    const result = await computeJevContractResult({ cwd: "/tmp", description, diffText: DIFF, targetLabel: "PR #1", fetchFn: throwingFetch });
    expect(result.jevError).toContain("max_tokens_exceeded");
    expect(result.claims).toHaveLength(2);
    expect(result.claims.every((c) => c.probability === undefined)).toBe(true);
    expect(result.tokens.jevCalls).toBe(0);
    // No finding is synthesized for a claim Jev was never actually asked about
    // and the facts do not contradict — silence here is honest (jevError says
    // why), not a false "unsupported" verdict manufactured from a missing answer.
    expect(result.findings).toEqual([]);
  });
});

describe("AC7: opt-in and credential gating — both refuse before any read", () => {
  test("review.jev.contract absent/false: refused, the fixtures dir is never even opened", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-contract", "--pr", "42", "--json"]);

    expect(output().toLowerCase()).toContain("review.jev.contract");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY (and no saved key): refused, no network call possible", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["jev-contract", "--pr", "42", "--json"]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("usage: exactly one of --diff/--pr is required", () => {
  test("none given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-contract", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-contract");
  });

  test("two given is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-contract", "--diff", "HEAD", "--pr", "1", "--json"]);
    expect(output()).toContain("Usage: keryx review jev-contract");
  });
});

describe("keryx review reviewers --json lists review-jev-contract with engine: jev", () => {
  test("once its SKILL.md is installed under .metaproject", async () => {
    ROOT = await projectRoot(true);
    const dir = path.join(ROOT, ".metaproject", "skills", "gdskills", "review", "review-jev-contract");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), '---\nname: review-jev-contract\nmetadata:\n  engine: "jev"\n---\n', "utf8");
    process.chdir(ROOT);

    await reviewCommand(["reviewers", "--json"]);
    const parsed = JSON.parse(output()) as { bundled: Array<{ name: string; engine?: string }> };
    const entry = parsed.bundled.find((r) => r.name === "review-jev-contract");
    expect(entry?.engine).toBe("jev");
  });
});
