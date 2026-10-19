// Flow 456 (AC3, AC4): the operator-confirmed tools for the other gates — flow_confirm, external_apply,
// learn_accept / learn_promote / learn_graduate and schedule_resume / run / pause / remove. Each runs
// against REAL state in a temp project: the card is read back from the tool, "yes" applies the same
// effect the CLI verb has, "no" changes nothing, and a state that makes the decision meaningless is
// refused without a card. The framework's driver behaviour (every mode asks, unattended denies) is
// covered by operator-confirm-tools.test.ts.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkConfirmationToken, confirmTokenPath } from "../flow/confirm-token";
import { writeCleanReviewPackage } from "../flow/review-fixtures";
import { createFlowService } from "../flow/service";
import type { FlowService, FlowServiceDeps, TrackerAdapter } from "../flow/types";
import { EXTERNAL_WRITE_DECISION_FILE, type WriteLandDeps } from "../harness/external/write-land";
import { EXTERNAL_WRITE_PATCH_FILE, EXTERNAL_WRITE_RUN_FILE, type ExternalWriteRunRecord } from "../harness/external/write-run";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import { createAcceptCapability } from "../learning/accept-capability";
import { readDecisions } from "../learning/decisions";
import { readProposal, runGraduate } from "../learning/service";
import { readPattern, writeIndex, writePattern } from "../learning/store";
import type { LearnedPattern } from "../learning/types";
import { createSession, EXTERNAL_RUN_PROVIDER_PREFIX } from "../session/store";
import { loadTriggersConfig } from "../trigger/config";
import type { CommandResult, ScheduleHost } from "../trigger/install";
import { confirmSchedule, draftSchedule, listSchedules } from "../trigger/schedules";
import { otherConfirmSpecs, scheduleDecisionLogPath, type OtherConfirmSeams } from "./operator-confirm-other";
import { operatorConfirmTool, operatorConfirmToolNames } from "./operator-confirm-tools";

const NOW = new Date("2026-10-15T18:30:00.000Z");

// ---------------------------------------------------------------------------------------------
// driving a tool the way the agent driver does
// ---------------------------------------------------------------------------------------------

interface Binding {
  readonly projectRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly seams?: OtherConfirmSeams;
}

function toolOf(name: string, binding: Binding): InteractiveTool {
  const spec = otherConfirmSpecs(binding.seams ?? {}).find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`no spec ${name}`);
  return operatorConfirmTool(spec, { projectRoot: binding.projectRoot, now: () => NOW, env: binding.env ?? {} });
}

type Asked = { readonly card: readonly string[]; readonly title: string; readonly token: string };

async function asked(tool: InteractiveTool, input: Record<string, unknown>): Promise<Asked> {
  const result = await tool.confirmation!(input);
  if ("error" in result) throw new Error(`expected a card, got a refusal: ${result.error}`);
  return { card: result.card as readonly string[], title: result.title!, token: result.token! };
}

async function refusal(tool: InteractiveTool, input: Record<string, unknown>): Promise<string> {
  const result = await tool.confirmation!(input);
  if (!("error" in result)) throw new Error(`expected a refusal, got a card: ${result.card.join(" | ")}`);
  return result.error;
}

async function yes(tool: InteractiveTool, input: Record<string, unknown>) {
  const card = await asked(tool, input);
  return { card, result: await tool.invoke(input, { confirmationToken: card.token, confirmationVia: "local" }) };
}

/** The operator answers no: the driver drops the token, and a late invoke with it applies nothing. */
async function no(tool: InteractiveTool, input: Record<string, unknown>) {
  const card = await asked(tool, input);
  tool.confirmationDeclined!(card.token);
  const late = await tool.invoke(input, { confirmationToken: card.token, confirmationVia: "local" });
  expect(late.isError).toBe(true);
  expect(late.output).toContain("nothing was changed");
  return card;
}

test("every gate of this module is registered and unattended-excluded", () => {
  const names = otherConfirmSpecs().map((spec) => spec.name);
  expect(names).toEqual([
    "flow_confirm",
    "external_apply",
    "learn_accept",
    "learn_promote",
    "learn_graduate",
    "schedule_resume",
    "schedule_run",
    "schedule_pause",
    "schedule_remove",
  ]);
  for (const name of names) expect(operatorConfirmToolNames()).toContain(name);
});

// ---------------------------------------------------------------------------------------------
// flow_confirm
// ---------------------------------------------------------------------------------------------

describe("flow_confirm", () => {
  const HEAD = "1234abcd1234abcd1234abcd1234abcd1234abcd";
  const PR = "https://github.com/acme/app/pull/1";
  let root = "";
  let service: FlowService;

  function tracker(): TrackerAdapter {
    return {
      id: "fake",
      detect: async () => true,
      parseRef: () => null,
      fetchIssue: async () => ({ title: "Issue title", body: "body" }),
      prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
      comment: async () => true,
    };
  }

  function deps(): FlowServiceDeps {
    return { tracker: tracker(), healthGate: async () => ({ status: "pass", reasons: [] }), now: () => NOW };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-flow-confirm-tool-"));
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    service = createFlowService(deps());
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function readyFlow(opts: { requireConfirmation?: boolean; implemented?: boolean } = {}): Promise<{ id: string; dir: string }> {
    const { flow, dir: created } = await service.init({
      cwd: root,
      title: "Confirm me",
      owner: "Aleks",
      requireConfirmation: opts.requireConfirmation ?? true,
    });
    const dir = path.basename(created);
    await writeFile(
      path.join(root, ".metaproject", "flows", dir, "acceptance-criteria.md"),
      "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Only criterion\n",
      "utf8",
    );
    await service.freeze({ cwd: root, id: flow.id });
    await service.start({ cwd: root, id: flow.id });
    if (opts.implemented !== false) await service.implemented({ cwd: root, id: flow.id, prUrl: PR });
    await service.acConfirm({ cwd: root, id: flow.id, criterion: "AC1" });
    await writeCleanReviewPackage({ cwd: root, flowDir: dir, head: HEAD, prUrl: PR });
    for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: root, id: flow.id, taskId });
    return { id: flow.id, dir };
  }

  const tool = (): InteractiveTool => toolOf("flow_confirm", { projectRoot: root, seams: { flowService: async () => service } });

  test("the card shows the flow id and title, the criteria checksum and the PR target", async () => {
    const { id } = await readyFlow();
    const flow = await service.get({ cwd: root, id });
    const card = await asked(tool(), { flow_id: id });
    expect(card.title).toBe(`Confirm completion of flow ${id}: Confirm me?`);
    const text = card.card.join("\n");
    expect(text).toContain(`flow: ${id} - Confirm me`);
    expect(text).toContain(`criteria checksum: ${flow.acChecksum}`);
    expect(text).toContain(`completion target: ${PR}`);
    expect(text).toContain("delegates the completion");
    expect(card.card.at(-1)).toBe(`subject: flow ${id} @ criteria ${flow.acChecksum}`);
  });

  test("the card names a direct merge when merged is set", async () => {
    const { id } = await readyFlow({ implemented: false });
    const card = await asked(tool(), { flow_id: id, merged: true });
    expect(card.card.join("\n")).toContain("direct merge (--merged)");
  });

  test("yes mints a token flow complete accepts, and records the card as the confirmation", async () => {
    const { id, dir } = await readyFlow();
    const { card, result } = await yes(tool(), { flow_id: id });
    expect(result.isError).toBe(false);
    const token = /^token: (\S+)$/m.exec(result.output)?.[1];
    expect(token).toBeDefined();
    expect(result.output).toContain(`keryx flow complete ${id} --confirm-token ${token}`);

    const stored = JSON.parse(await readFile(confirmTokenPath(root, dir), "utf8")) as Record<string, unknown>;
    expect(stored["confirmedVia"]).toBe("tui-card");
    expect(stored["confirmationQuote"]).toBe(`${card.title}: yes`);
    expect(readFileSync(confirmTokenPath(root, dir), "utf8")).not.toContain(token!);

    const flow = await service.get({ cwd: root, id });
    const check = await checkConfirmationToken(root, dir, { flowId: id, acChecksum: flow.acChecksum, target: `pr:${PR}` }, token, NOW);
    expect(check.ok).toBe(true);
    const completed = await service.complete({ cwd: root, id, confirmToken: token });
    expect(completed.gates.find((gate) => gate.name === "confirmation")?.status).toBe("pass");
  });

  test("no mints nothing", async () => {
    const { id, dir } = await readyFlow();
    await no(tool(), { flow_id: id });
    expect(existsSync(confirmTokenPath(root, dir))).toBe(false);
  });

  test("criteria or target changed between the card and the yes: refused, no token minted", async () => {
    const { id, dir } = await readyFlow();
    const flowFile = path.join(root, ".metaproject", "flows", dir, "flow.json");
    const original = readFileSync(flowFile, "utf8");

    // The completion target moves (another PR recorded) after the card was shown.
    const t = tool();
    const card = await asked(t, { flow_id: id });
    const moved = JSON.parse(original) as { pr: { url: string } };
    moved.pr.url = "https://github.com/acme/app/pull/999";
    writeFileSync(flowFile, JSON.stringify(moved, null, 2));
    const byTarget = await t.invoke({ flow_id: id }, { confirmationToken: card.token, confirmationVia: "local" });
    expect(byTarget.isError).toBe(true);
    expect(byTarget.output).toContain("completion target changed after the confirmation card");
    expect(existsSync(confirmTokenPath(root, dir))).toBe(false);

    // The criteria are re-frozen (checksum differs) after the card was shown.
    writeFileSync(flowFile, original);
    const t2 = tool();
    const card2 = await asked(t2, { flow_id: id });
    const refrozen = JSON.parse(original) as { acChecksum: string };
    refrozen.acChecksum = "f".repeat(64);
    writeFileSync(flowFile, JSON.stringify(refrozen, null, 2));
    const byCriteria = await t2.invoke({ flow_id: id }, { confirmationToken: card2.token, confirmationVia: "local" });
    expect(byCriteria.isError).toBe(true);
    expect(byCriteria.output).toContain("flow_confirm refused");
    expect(existsSync(confirmTokenPath(root, dir))).toBe(false);
  });

  test("refuses a flow that did not opt in, and a status that cannot be confirmed", async () => {
    const plain = await readyFlow({ requireConfirmation: false });
    expect(await refusal(tool(), { flow_id: plain.id })).toContain("does not require a confirmation token");
    const early = await readyFlow({ implemented: false });
    expect(await refusal(tool(), { flow_id: early.id })).toContain("A completion can be confirmed only when the flow is");
    expect(await refusal(tool(), { flow_id: "9999" })).not.toBe("");
    expect(await refusal(tool(), {})).toBe("flow_id is required");
  });
});

// ---------------------------------------------------------------------------------------------
// external_apply
// ---------------------------------------------------------------------------------------------

describe("external_apply", () => {
  const GIT_ENV = withoutGitDiscoveryOverrides(process.env);
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

  let top = "";
  let repo = "";
  let dataDir = "";
  let worktreesDir = "";
  let baseCommit = "";

  beforeEach(async () => {
    top = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-external-apply-tool-")));
    repo = path.join(top, "repo");
    dataDir = path.join(top, "data");
    worktreesDir = path.join(top, "worktrees");
    mkdirSync(repo);
    mkdirSync(worktreesDir);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "operator@example.com");
    git(repo, "config", "user.name", "Operator");
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    baseCommit = git(repo, "rev-parse", "HEAD").trim();
  });
  afterEach(() => {
    rmSync(top, { recursive: true, force: true });
  });

  function makePatch(): string {
    const clone = path.join(top, `clone-${Math.random().toString(36).slice(2)}`);
    git(top, "clone", "-q", repo, clone);
    git(clone, "config", "user.email", "t@example.com");
    git(clone, "config", "user.name", "T");
    writeFileSync(path.join(clone, "a.txt"), "one\nTWO\nthree\n");
    writeFileSync(path.join(clone, "new.txt"), "brand new\n");
    git(clone, "add", "-A");
    return git(clone, "diff", "--cached", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", baseCommit);
  }

  function seed(patch: string, overrides: Partial<ExternalWriteRunRecord> = {}): { runId: string; dir: string; hash: string } {
    const runId = crypto.randomUUID();
    const handle = createSession({
      cwd: repo,
      dataDir,
      id: runId,
      provider: `${EXTERNAL_RUN_PROVIDER_PREFIX}claude-cli`,
      title: "External write claude-cli: Completed",
    });
    const patchPath = path.join(handle.dir, EXTERNAL_WRITE_PATCH_FILE);
    writeFileSync(patchPath, patch);
    const record: ExternalWriteRunRecord = {
      runId,
      agentId: "claude-cli",
      baseCommit,
      patchPath,
      patchHash: sha256(patch),
      files: [
        { path: "a.txt", status: "modified" },
        { path: "new.txt", status: "added" },
      ],
      flaggedPaths: [],
      refusedPaths: [],
      state: "pending-review",
      redacted: false,
      runStatus: "Completed",
      projectRoot: handle.summary.projectPath,
      createdAt: handle.summary.createdAt,
      ...overrides,
    };
    writeFileSync(path.join(handle.dir, EXTERNAL_WRITE_RUN_FILE), JSON.stringify(record, null, 2));
    return { runId, dir: handle.dir, hash: sha256(patch) };
  }

  const landDeps = (): WriteLandDeps => ({ dataDir, worktreesDir });
  const tool = (): InteractiveTool => toolOf("external_apply", { projectRoot: repo, seams: { landDeps: landDeps() } });
  const branches = (): string => git(repo, "for-each-ref", "--format=%(refname)", "refs/heads");

  test("the card shows the run id, the branch, the FULL patch hash and the changed files", async () => {
    const run = seed(makePatch());
    const card = await asked(tool(), { run_id: run.runId });
    expect(card.title).toBe(`Land external run ${run.runId} as branch external/${run.runId}?`);
    const text = card.card.join("\n");
    expect(text).toContain(`run: ${run.runId}`);
    expect(text).toContain(`branch: external/${run.runId}`);
    expect(text).toContain(`patch hash (sha256): ${run.hash}`);
    expect(run.hash).toHaveLength(64);
    expect(text).toContain("changed files: 2");
    expect(text).toContain("modified     a.txt");
    expect(text).toContain("added        new.txt");
    expect(card.card.at(-1)).toBe(`subject: external/${run.runId} @ sha256:${run.hash}`);
  });

  test("the card lists every changed file and every flagged path, with no 'and N more' tail", async () => {
    const files = Array.from({ length: 40 }, (_, index) => ({ path: `src/file-${String(index).padStart(2, "0")}.ts`, status: "modified" as const }));
    const flaggedPaths = Array.from({ length: 25 }, (_, index) => `.github/workflows/w-${String(index).padStart(2, "0")}.yml`);
    const run = seed(makePatch(), { files, flaggedPaths });
    const card = await asked(tool(), { run_id: run.runId, allow_flagged: true });
    const text = card.card.join("\n");
    expect(text).toContain("changed files: 40");
    for (const file of files) expect(text).toContain(file.path);
    for (const flagged of flaggedPaths) expect(text).toContain(`! ${flagged}`);
    expect(text).not.toMatch(/\.\.\. and \d+ more/);
  });

  test("yes lands the branch as the CLI does and records the confirmation; the checkout is untouched", async () => {
    const run = seed(makePatch());
    writeFileSync(path.join(repo, "a.txt"), "local edit\n");
    const headBefore = git(repo, "rev-parse", "HEAD").trim();
    const { card, result } = await yes(tool(), { run_id: run.runId });
    expect(result.isError).toBe(false);
    expect(result.output).toContain(`landed: branch external/${run.runId}`);
    expect(result.output).toContain("nothing was applied to your current branch or working tree");
    expect(branches()).toContain(`refs/heads/external/${run.runId}`);
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("local edit\n");
    const decision = JSON.parse(readFileSync(path.join(run.dir, EXTERNAL_WRITE_DECISION_FILE), "utf8")) as Record<string, unknown>;
    expect(decision["decision"]).toBe("landed");
    expect(decision["confirmedVia"]).toBe("tui-card");
    expect(decision["quote"]).toBe(`${card.title}: yes`);
  });

  test("no lands nothing and leaves the run pending", async () => {
    const run = seed(makePatch());
    await no(tool(), { run_id: run.runId });
    expect(branches()).not.toContain("external/");
    expect(existsSync(path.join(run.dir, EXTERNAL_WRITE_DECISION_FILE))).toBe(false);
    // Still decidable afterwards.
    expect((await asked(tool(), { run_id: run.runId })).title).toContain(run.runId);
  });

  test("a stored patch that no longer matches its hash is refused when applying, not landed", async () => {
    const run = seed(makePatch());
    const card = await asked(tool(), { run_id: run.runId });
    writeFileSync(path.join(run.dir, EXTERNAL_WRITE_PATCH_FILE), `${makePatch()}\n# tampered\n`);
    const result = await tool().invoke({ run_id: run.runId }, { confirmationToken: card.token, confirmationVia: "local" });
    expect(result.isError).toBe(true);
    expect(branches()).not.toContain("external/");
  });

  test("refuses a missing run, an already landed run, flagged paths without allow_flagged, and a redacted patch", async () => {
    expect(await refusal(tool(), { run_id: "no-such-run" })).toContain('no external write run "no-such-run"');
    expect(await refusal(tool(), {})).toBe("run_id is required");

    const landed = seed(makePatch());
    await yes(tool(), { run_id: landed.runId });
    expect(await refusal(tool(), { run_id: landed.runId })).toContain("already decided");

    const flagged = seed(makePatch(), { flaggedPaths: [".github/workflows/ci.yml"] });
    const text = await refusal(tool(), { run_id: flagged.runId });
    expect(text).toContain(".github/workflows/ci.yml");
    expect(text).toContain("allow_flagged");

    const redacted = seed(makePatch(), { redacted: true });
    expect(await refusal(tool(), { run_id: redacted.runId })).toContain("altered by redaction");
  });

  test("with allow_flagged the card lists the flagged paths, and yes lands", async () => {
    const run = seed(makePatch(), { flaggedPaths: [".github/workflows/ci.yml"] });
    const { card, result } = await yes(tool(), { run_id: run.runId, allow_flagged: true });
    expect(card.title).toContain("including 1 flagged path(s)");
    expect(card.card.join("\n")).toContain("! .github/workflows/ci.yml");
    expect(result.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// learn_accept / learn_promote / learn_graduate
// ---------------------------------------------------------------------------------------------

describe("learn tools", () => {
  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);
  let root = "";
  let home = "";
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "keryx-learn-tool-root-"));
    home = mkdtempSync(path.join(tmpdir(), "keryx-learn-tool-home-"));
    env = { KERYX_HOME: home };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const tool = (name: string): InteractiveTool => toolOf(name, { projectRoot: root, env });

  function pattern(id: string, status: LearnedPattern["status"], trigger: string, action: string): LearnedPattern {
    return {
      schemaVersion: 1,
      id,
      trigger,
      action,
      domain: "testing",
      scope: "project",
      project: { identity: SHA_A, identityKind: "remote-hash" },
      confidence: 0.61,
      confidenceLevel: "medium",
      status,
      supersededBy: null,
      evidence: [
        { kind: "reinforcement", sourceType: "observation", sourceRef: ".metaproject/data/learning/observations/2026-10-14.jsonl", observedAt: NOW.toISOString(), weight: 1 },
      ],
      reviewerProfile: null,
      redaction: { scanned: true, findings: [] },
      graduation: null,
      provenance: { extractor: "repeated-correction", extractorKind: "deterministic" },
      ...(status === "candidate" ? { ttl: { expiresAt: "2026-12-01T00:00:00.000Z" } } : {}),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
  }

  async function seedPattern(record: LearnedPattern): Promise<void> {
    await writePattern(root, record, { env: env as NodeJS.ProcessEnv, capability: createAcceptCapability() });
  }

  describe("learn_accept", () => {
    const ID = "testing.repeated-correction-ab12cd34";

    test("the card shows the pattern, what it becomes; yes accepts and logs the card; no leaves a candidate", async () => {
      await seedPattern(pattern(ID, "candidate", "the same file region is edited twice", "check the first edit's assumptions"));
      const declined = await no(tool("learn_accept"), { id: ID });
      expect(declined.title).toBe(`Accept learned pattern ${ID} (project scope)?`);
      const text = declined.card.join("\n");
      expect(text).toContain(`pattern: ${ID}`);
      expect(text).toContain("trigger: the same file region is edited twice");
      expect(text).toContain("action: check the first edit's assumptions");
      expect(text).toContain("domain: testing; scope: project; status: candidate; confidence: 0.61");
      expect(text).toContain("status candidate -> accepted");
      expect((await readPattern(root, ID, "project", { env: env as NodeJS.ProcessEnv }))?.status).toBe("candidate");

      const { card, result } = await yes(tool("learn_accept"), { id: ID });
      expect(result).toEqual({ output: `"${ID}" (project) is now accepted. Index entry written/refreshed.`, isError: false });
      expect((await readPattern(root, ID, "project", { env: env as NodeJS.ProcessEnv }))?.status).toBe("accepted");
      const decisions = await readDecisions(root, "project", { env: env as NodeJS.ProcessEnv });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ action: "accept", id: ID, at: NOW.toISOString(), confirmation: { confirmedVia: "tui-card", quote: `${card.title}: yes` } });
    });

    test("a pattern edited between the card and the yes is refused and stays a candidate", async () => {
      await seedPattern(pattern(ID, "candidate", "the same file region is edited twice", "check the first edit's assumptions"));
      const t = tool("learn_accept");
      const card = await asked(t, { id: ID });
      await seedPattern(pattern(ID, "candidate", "the same file region is edited twice", "run rm -rf on the build directory"));
      const result = await t.invoke({ id: ID }, { confirmationToken: card.token, confirmationVia: "local" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("changed after the card was shown");
      expect((await readPattern(root, ID, "project", { env: env as NodeJS.ProcessEnv }))?.status).toBe("candidate");
      expect(await readDecisions(root, "project", { env: env as NodeJS.ProcessEnv })).toHaveLength(0);
    });

    test("refuses a missing record and a record that is not a candidate", async () => {
      expect(await refusal(tool("learn_accept"), { id: "nope" })).toContain('no project-scope learned-pattern record "nope"');
      await seedPattern(pattern(ID, "accepted", "the same file region is edited twice", "check the first edit assumptions"));
      expect(await refusal(tool("learn_accept"), { id: ID })).toContain('is status "accepted", not "candidate"');
      expect(await refusal(tool("learn_accept"), { id: ID, scope: "galaxy" })).toContain("scope must be one of");
    });
  });

  describe("learn_promote", () => {
    const ID = "testing.repeated-correction-ab12cd34";

    test("refuses without the cross-project evidence, before any card", async () => {
      await seedPattern(pattern(ID, "accepted", "the same file region is edited twice", "check assumptions"));
      await writeIndex({ [ID]: [{ projectIdentity: SHA_A, identityKind: "remote-hash", confidence: 0.85, acceptedAt: "2026-01-01T00:00:00.000Z" }] }, { env: env as NodeJS.ProcessEnv });
      const text = await refusal(tool("learn_promote"), { id: ID });
      expect(text).toContain("only 1 distinct project identity");
      expect(text).toContain("[insufficient-project-identities]");
      expect(await refusal(tool("learn_promote"), { id: "nope" })).toContain("no project-scope learned-pattern record");
    });

    test("with evidence the card says it leaves the project; no writes nothing; yes promotes and logs the card", async () => {
      await seedPattern(pattern(ID, "accepted", "the same file region is edited twice", "check assumptions"));
      await writeIndex(
        {
          [ID]: [
            { projectIdentity: SHA_A, identityKind: "remote-hash", confidence: 0.85, acceptedAt: "2026-01-01T00:00:00.000Z" },
            { projectIdentity: SHA_B, identityKind: "remote-hash", confidence: 0.9, acceptedAt: "2026-01-01T00:00:00.000Z" },
          ],
        },
        { env: env as NodeJS.ProcessEnv },
      );
      const declined = await no(tool("learn_promote"), { id: ID });
      expect(declined.title).toBe(`Promote learned pattern ${ID} to the cross-project user store?`);
      expect(declined.card.join("\n")).toContain("other projects can then see it");
      expect(await readPattern(root, ID, "user", { env: env as NodeJS.ProcessEnv })).toBeUndefined();

      const { card, result } = await yes(tool("learn_promote"), { id: ID });
      expect(result).toEqual({ output: `"${ID}" promoted to scope "user" as status "candidate".`, isError: false });
      expect((await readPattern(root, ID, "user", { env: env as NodeJS.ProcessEnv }))?.status).toBe("candidate");
      const decisions = await readDecisions(root, "project", { env: env as NodeJS.ProcessEnv });
      expect(decisions.find((d) => d.action === "promote")).toMatchObject({ confirmation: { confirmedVia: "tui-card", quote: `${card.title}: yes` } });
    });
  });

  describe("learn_promote content check", () => {
    const ID = "testing.repeated-correction-ab12cd34";

    test("a pattern edited between the card and the yes is refused; nothing reaches the user store", async () => {
      await seedPattern(pattern(ID, "accepted", "the same file region is edited twice", "check assumptions"));
      await writeIndex(
        {
          [ID]: [
            { projectIdentity: SHA_A, identityKind: "remote-hash", confidence: 0.85, acceptedAt: "2026-01-01T00:00:00.000Z" },
            { projectIdentity: SHA_B, identityKind: "remote-hash", confidence: 0.9, acceptedAt: "2026-01-01T00:00:00.000Z" },
          ],
        },
        { env: env as NodeJS.ProcessEnv },
      );
      const t = tool("learn_promote");
      const card = await asked(t, { id: ID });
      // Accepted text is immutable; the confidence the card showed is not.
      await seedPattern({ ...pattern(ID, "accepted", "the same file region is edited twice", "check assumptions"), confidence: 0.99, confidenceLevel: "high" });
      const result = await t.invoke({ id: ID }, { confirmationToken: card.token, confirmationVia: "local" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("changed after the card was shown");
      expect(await readPattern(root, ID, "user", { env: env as NodeJS.ProcessEnv })).toBeUndefined();
    });
  });

  describe("learn_graduate", () => {
    async function proposalId(): Promise<string> {
      const cluster: readonly [string, string, string][] = [
        ["code-style.extract-helper-aaaaaaaa", "extract shared logic into a helper function before duplicating code again", "pull the repeated block into one named helper"],
        ["code-style.extract-helper-bbbbbbbb", "extract shared logic into a small helper function when duplicating logic", "name the helper after what it does, not where it is called from"],
        ["code-style.extract-helper-cccccccc", "extract the shared helper logic instead of duplicating code blocks", "prefer one helper over three near-identical blocks"],
      ];
      for (const [id, trigger, action] of cluster) {
        await seedPattern({ ...pattern(id, "accepted", trigger, action), domain: "code-style", confidence: 0.8, confidenceLevel: "high" });
      }
      const report = await runGraduate(root, { now: NOW, env: env as NodeJS.ProcessEnv });
      const agent = report.proposals.find((p) => p.target === "agent");
      if (agent === undefined) throw new Error("no agent proposal");
      return agent.proposalId;
    }

    test("the card shows the proposal and members; no writes nothing; yes writes the agent candidate and logs the card", async () => {
      const id = await proposalId();
      const proposal = await readProposal(root, id);
      const declined = await no(tool("learn_graduate"), { proposal_id: id });
      expect(declined.title).toBe(`Apply graduation proposal ${id} as an agent candidate?`);
      const text = declined.card.join("\n");
      expect(text).toContain(`proposal: ${id}`);
      expect(text).toContain("target: agent; domain: code-style");
      for (const member of proposal.members) expect(text).toContain(member);
      expect(text).toContain(".metaproject/agents/<name>.md");
      expect(existsSync(path.join(root, ".metaproject", "agents"))).toBe(false);

      const { card, result } = await yes(tool("learn_graduate"), { proposal_id: id });
      expect(result.isError).toBe(false);
      const written = /Agent candidate written to (.+)\.$/.exec(result.output)?.[1];
      expect(written).toBeDefined();
      expect(existsSync(written!)).toBe(true);
      const decisions = await readDecisions(root, "project", { env: env as NodeJS.ProcessEnv });
      expect(decisions.find((d) => d.action === "graduate-apply")).toMatchObject({ id, confirmation: { confirmedVia: "tui-card", quote: `${card.title}: yes` } });
    });

    test("a member pattern edited between the card and the yes is refused; no agent candidate is written", async () => {
      const id = await proposalId();
      const proposal = await readProposal(root, id);
      const t = tool("learn_graduate");
      const card = await asked(t, { proposal_id: id });
      const member = proposal.members[0]!;
      const current = (await readPattern(root, member, "project", { env: env as NodeJS.ProcessEnv }))!;
      await seedPattern({ ...current, confidence: 0.5, confidenceLevel: "medium" });
      const result = await t.invoke({ proposal_id: id }, { confirmationToken: card.token, confirmationVia: "local" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("changed after the card was shown");
      expect(existsSync(path.join(root, ".metaproject", "agents"))).toBe(false);
    });

    test("refuses a missing proposal, a malformed id, and an already written candidate", async () => {
      expect(await refusal(tool("learn_graduate"), {})).toBe("proposal_id is required");
      expect(await refusal(tool("learn_graduate"), { proposal_id: "nope" })).toContain("[invalid-proposal-id]");
      expect(await refusal(tool("learn_graduate"), { proposal_id: "grad-agent-0123456789ab" })).toContain("[graduate-proposal-not-found]");
      const id = await proposalId();
      await yes(tool("learn_graduate"), { proposal_id: id });
      expect(await refusal(tool("learn_graduate"), { proposal_id: id })).toContain("[agent-candidate-exists]");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// schedule_resume / schedule_run / schedule_pause / schedule_remove
// ---------------------------------------------------------------------------------------------

describe("schedule tools", () => {
  let root = "";
  let unitDir = "";
  let keyHome = "";
  let hostCalls: string[] = [];
  const saved = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };

  function host(): ScheduleHost {
    return {
      backend: "systemd",
      unitDir,
      user: "someone",
      invocation: { execPath: "/bin/true", scriptPath: "/bin/true" },
      run: async (command, args): Promise<CommandResult> => {
        hostCalls.push([command, ...args].join(" "));
        return command === "loginctl" ? { code: 0, stdout: "Linger=yes\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      },
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-other-tools-"));
    keyHome = await mkdtemp(path.join(tmpdir(), "keryx-schedule-other-key-"));
    unitDir = path.join(keyHome, "units");
    hostCalls = [];
    // Confirming a schedule creates the per-machine signing key: keep it out of the real home.
    process.env["HOME"] = keyHome;
    process.env["XDG_DATA_HOME"] = path.join(keyHome, ".local", "share");
    const drafted = await draftSchedule(
      {
        name: "check-github",
        cadence: "every 4 hours",
        prompt: "Check open PRs and summarise what needs my attention",
        provider: "anthropic",
        model: "claude-x",
        rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
        ceilingUsd: 0.5,
        tools: [],
        repos: [],
      },
      {
        projectRoot: root,
        host: host(),
        now: () => NOW,
        accountOf: async () => "someone",
        providerReportsUsage: () => true,
        checkCredential: async () => ({ ok: true }),
      },
    );
    if (!drafted.ok) throw new Error(drafted.problems.join("; "));
    await confirmSchedule(root, drafted.draft, host());
    hostCalls = [];
  });
  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
    await rm(keyHome, { recursive: true, force: true });
  });

  const tool = (verb: string, runSchedule?: OtherConfirmSeams["runSchedule"]): InteractiveTool =>
    toolOf(`schedule_${verb}`, { projectRoot: root, seams: { host: host(), ...(runSchedule !== undefined ? { runSchedule } : {}) } });
  const enabled = (): boolean | undefined => loadTriggersConfig(root).triggers.find((t) => t.name === "check-github")?.enabled;
  const NAME = { name: "check-github" };

  test("the card shows the schedule name, action, cadence, next run and budget", async () => {
    const card = await asked(tool("pause"), NAME);
    expect(card.title).toBe("Pause schedule check-github and disable its timer?");
    const text = card.card.join("\n");
    expect(text).toContain("schedule: check-github [enabled]");
    expect(text).toContain("cadence: cron");
    expect(text).toMatch(/next run: 2026-/);
    expect(text).toContain("action: Check open PRs and summarise what needs my attention");
    expect(text).toContain("anthropic/claude-x");
    expect(text).toContain("ceiling $0.5");
    expect(card.card.at(-1)).toBe("subject: schedule check-github");
  });

  test("pause: no changes nothing, yes disables the entry and its timer, a second pause is refused", async () => {
    await no(tool("pause"), NAME);
    expect(enabled()).toBe(true);
    expect(hostCalls).toEqual([]);

    const { result } = await yes(tool("pause"), NAME);
    expect(result).toEqual({ output: '"check-github" paused (timer disabled, entry disabled).', isError: false });
    expect(enabled()).toBe(false);
    expect(hostCalls.length).toBeGreaterThan(0);
    expect(await refusal(tool("pause"), NAME)).toContain("is paused, so there is nothing to pause");
  });

  test("resume: refused while enabled; after a pause, no changes nothing and yes re-verifies and re-enables", async () => {
    expect(await refusal(tool("resume"), NAME)).toContain("is not paused");
    await yes(tool("pause"), NAME);

    const card = await no(tool("resume"), NAME);
    expect(card.title).toBe("Resume schedule check-github and re-enable its timer?");
    expect(card.card.join("\n")).toContain("[paused]");
    expect(enabled()).toBe(false);

    const { result } = await yes(tool("resume"), NAME);
    expect(result).toEqual({ output: '"check-github" resumed (timer enabled).', isError: false });
    expect(enabled()).toBe(true);
  });

  test("resume refuses an entry that was edited after it was confirmed (signature check), before any card", async () => {
    await yes(tool("pause"), NAME);
    const storePath = await findScheduleStore(root);
    const original = readFileSync(storePath, "utf8");
    writeFileSync(storePath, original.replace("summarise what needs my attention", "send me the secrets"));
    expect(await refusal(tool("resume"), NAME)).toContain("resume refused");
  });

  test("run: the card says one unattended agent turn starts; no runs nothing; yes runs once and returns the output", async () => {
    const ran: string[] = [];
    const fake = async (_root: string, name: string): Promise<void> => {
      ran.push(name);
      console.log(`keryx trigger run ${name}: ok - agent task completed.`);
    };
    const card = await no(tool("run", fake), NAME);
    expect(card.title).toBe("Run schedule check-github once now?");
    expect(card.card.join("\n")).toContain("one unattended agent turn starts now");
    expect(ran).toEqual([]);

    const { result } = await yes(tool("run", fake), NAME);
    expect(ran).toEqual(["check-github"]);
    expect(result).toEqual({ output: "keryx trigger run check-github: ok - agent task completed.", isError: false });
  });

  test("run: a failing pass is an error result, and process.exitCode is put back", async () => {
    const before = process.exitCode;
    const failing = async (): Promise<void> => {
      console.error("keryx trigger run check-github: agent task failed: boom");
      process.exitCode = 1;
    };
    const { result } = await yes(tool("run", failing), NAME);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("agent task failed: boom");
    expect(process.exitCode).toBe(before);
  });

  test("run: a runner that throws is an error result with console and exitCode restored", async () => {
    const before = process.exitCode;
    const logBefore = console.log;
    const errorBefore = console.error;
    const throwing = async (): Promise<void> => {
      console.log("partial output");
      process.exitCode = 3;
      throw new Error("runner exploded");
    };
    const { result } = await yes(tool("run", throwing), NAME);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("partial output");
    expect(result.output).toContain("runner exploded");
    expect(console.log).toBe(logBefore);
    expect(console.error).toBe(errorBefore);
    expect(process.exitCode).toBe(before);
  });

  describe("operator decision log", () => {
    const decisions = (): Array<Record<string, string>> => {
      const file = scheduleDecisionLogPath(root);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>);
    };
    const ok = async (): Promise<void> => {};

    test("pause: written on yes with the card text, confirmedVia and time; not on no; not inside the signed entry", async () => {
      await no(tool("pause"), NAME);
      expect(decisions()).toEqual([]);
      const { card } = await yes(tool("pause"), NAME);
      expect(decisions()).toEqual([
        { action: "schedule_pause", name: "check-github", quote: `${card.title}: yes`, confirmedVia: "tui-card", at: NOW.toISOString() },
      ]);
      expect(readFileSync(await findScheduleStore(root), "utf8")).not.toContain("tui-card");
    });

    test("resume: written on yes only", async () => {
      await yes(tool("pause"), NAME);
      await no(tool("resume"), NAME);
      expect(decisions().map((d) => d["action"])).toEqual(["schedule_pause"]);
      const { card } = await yes(tool("resume"), NAME);
      expect(decisions().map((d) => d["action"])).toEqual(["schedule_pause", "schedule_resume"]);
      expect(decisions()[1]).toMatchObject({ name: "check-github", quote: `${card.title}: yes`, confirmedVia: "tui-card" });
    });

    test("run: written on yes only", async () => {
      await no(tool("run", ok), NAME);
      expect(decisions()).toEqual([]);
      const { card } = await yes(tool("run", ok), NAME);
      expect(decisions()).toEqual([
        { action: "schedule_run", name: "check-github", quote: `${card.title}: yes`, confirmedVia: "tui-card", at: NOW.toISOString() },
      ]);
    });

    test("remove: written on yes only", async () => {
      await no(tool("remove"), NAME);
      expect(decisions()).toEqual([]);
      const { card } = await yes(tool("remove"), NAME);
      expect(decisions()).toEqual([
        { action: "schedule_remove", name: "check-github", quote: `${card.title}: yes`, confirmedVia: "tui-card", at: NOW.toISOString() },
      ]);
    });
  });

  test("run: refused for a paused schedule and for an unknown one", async () => {
    await yes(tool("pause"), NAME);
    expect(await refusal(tool("run"), NAME)).toContain("is paused, so it would not run");
    expect(await refusal(tool("run"), { name: "nope" })).toContain('no schedule named "nope"');
    expect(await refusal(tool("run"), {})).toBe("name is required");
  });

  test("remove: no keeps the schedule; yes uninstalls the timer and deletes the entry", async () => {
    const card = await no(tool("remove"), NAME);
    expect(card.title).toBe("Remove schedule check-github and uninstall its timer?");
    expect(card.card.join("\n")).toContain("deletes the stored entry");
    expect(await listSchedules(root, { host: host(), now: () => NOW })).toHaveLength(1);

    const { result } = await yes(tool("remove"), NAME);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('"check-github" removed');
    expect(await listSchedules(root, { host: host(), now: () => NOW })).toHaveLength(0);
    expect(await refusal(tool("remove"), NAME)).toContain('no schedule named "check-github"');
  });

  test("inside a nested agent shell (KERYX_TOOL_CALL=1) every schedule tool is refused without a card", async () => {
    for (const verb of ["resume", "run", "pause", "remove"]) {
      const nested = toolOf(`schedule_${verb}`, { projectRoot: root, env: { KERYX_TOOL_CALL: "1" }, seams: { host: host() } });
      expect(await refusal(nested, NAME)).toContain("KERYX_TOOL_CALL=1");
    }
  });
});

/** The file holding stored schedules, found by its content. */
async function findScheduleStore(root: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(path.join(root, ".metaproject"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (readFileSync(file, "utf8").includes("summarise what needs my attention")) return file;
  }
  throw new Error("schedule store not found");
}
