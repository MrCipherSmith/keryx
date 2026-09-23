// Flow 299, AC1-AC3: the completion confirmation token.
//
// - AC1: `flow confirm` mints only when every precondition holds: a terminal,
//   the right status, frozen and intact criteria, and the challenge typed back.
//   Only the token's hash reaches disk.
// - AC2: an opted-in flow's `flow complete` needs a valid token. Every kind of
//   invalid token fails with its own named reason.
// - AC3: a token is spent only on a passing completion. The signature gains a
//   `confirmation` field while `identity` stays as it was, and `flow status`,
//   the `flow complete` note and the governance report all show it.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { completionSignatureNotes, flowCommand, runConfirm } from "../commands/flow";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { buildGovernanceReport, renderGovernanceMarkdown } from "../governance/report";
import { CONFIRMATION_CAVEAT, CONFIRMATION_TOKEN_TTL_MS, confirmTokenPath } from "./confirm-token";
import { flowStateSchema } from "./schema";
import { createFlowService } from "./service";
import { writeCleanReviewPackage } from "./review-fixtures";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";
const HEAD = "1234abcd1234abcd1234abcd1234abcd1234abcd";
const PR = "https://github.com/acme/app/pull/1";
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
let clock = new Date("2026-09-23T10:00:00Z");

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
  };
}

function deps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => clock,
    ...over,
  };
}

async function fresh(over: Partial<FlowServiceDeps> = {}): Promise<FlowService> {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-confirm-token-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  clock = new Date("2026-09-23T10:00:00Z");
  return createFlowService(deps(over));
}

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

async function onDisk(dir: string): Promise<FlowState> {
  return JSON.parse(await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8")) as FlowState;
}

async function readyFlow(
  service: FlowService,
  opts: { requireConfirmation?: boolean; freeze?: boolean; implemented?: boolean; title?: string } = {},
): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({
    cwd: ROOT,
    title: opts.title ?? "Confirm me",
    owner: "Aleks",
    requireConfirmation: opts.requireConfirmation ?? true,
  });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  if (opts.freeze === false) return { id: flow.id, dir };
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  if (opts.implemented !== false) await service.implemented({ cwd: ROOT, id: flow.id, prUrl: PR });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR });
  for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  return { id: flow.id, dir };
}

/** Every file under the flow directory, as text, to prove the plaintext token is in none of them. */
async function everyFlowFile(dir: string): Promise<string> {
  const root = path.join(ROOT, ".metaproject", "flows", dir);
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(await readFile(path.join(entry.parentPath, entry.name), "utf8"));
  }
  return out.join("\n");
}

// --- AC1: minting -----------------------------------------------------------

test("AC1: confirmMint stores only the token's sha256, bound to the flow, the kind and the criteria checksum, with a TTL", async () => {
  const service = await fresh();
  const { id, dir } = await readyFlow(service);
  const minted = await service.confirmMint({ cwd: ROOT, id });

  expect(minted.token.startsWith(`${id}.`)).toBe(true);
  const stored = JSON.parse(await readFile(confirmTokenPath(ROOT, dir), "utf8")) as Record<string, unknown>;
  expect(stored["flowId"]).toBe(id);
  expect(stored["kind"]).toBe("complete");
  expect(stored["acChecksum"]).toBe(minted.acChecksum);
  expect(typeof stored["hash"]).toBe("string");
  expect(new Date(String(stored["expiresAt"])).getTime() - new Date(String(stored["mintedAt"])).getTime()).toBe(
    CONFIRMATION_TOKEN_TTL_MS,
  );
  expect(await everyFlowFile(dir)).not.toContain(minted.token);
  expect(await everyFlowFile(dir)).not.toContain(minted.token.slice(id.length + 1));
  expect((await onDisk(dir)).history.at(-1)?.event).toBe("confirmation-minted");
});

test("AC1: confirmMint refuses the wrong status, a flow that did not opt in, unfrozen criteria, and changed criteria", async () => {
  const service = await fresh();
  // Wrong status: in-progress without --merged.
  const inProgress = await readyFlow(service, { implemented: false, title: "In progress" });
  await expect(service.confirmMint({ cwd: ROOT, id: inProgress.id })).rejects.toThrow(/is "in-progress"/);
  // ...but in-progress WITH --merged is a direct-merge completion, and allowed.
  await expect(service.confirmMint({ cwd: ROOT, id: inProgress.id, merged: true })).resolves.toBeDefined();

  // Not opted in.
  const plain = await readyFlow(service, { requireConfirmation: false, title: "Plain" });
  await expect(service.confirmMint({ cwd: ROOT, id: plain.id })).rejects.toThrow(/does not require a confirmation token/);

  // Unfrozen criteria (the status check runs first, so bring it to a
  // confirmable status by reading the precondition directly).
  const unfrozen = await readyFlow(service, { freeze: false, title: "Unfrozen" });
  const { confirmPreconditionError } = await import("./service");
  const state = await service.get({ cwd: ROOT, id: unfrozen.id });
  expect(confirmPreconditionError({ ...state, status: "implemented" }, false)).toMatch(/not frozen/);

  // Changed criteria.
  const tampered = await readyFlow(service, { title: "Tampered" });
  await writeAc(tampered.dir, ["Only criterion (edited)"]);
  await expect(service.confirmMint({ cwd: ROOT, id: tampered.id })).rejects.toThrow(/do not match their recorded checksum/);
  await expect(readFile(confirmTokenPath(ROOT, tampered.dir), "utf8")).rejects.toThrow();
});

test("AC1: the CLI refuses without a terminal, and refuses a wrong challenge, minting nothing in either case", async () => {
  const service = await fresh();
  const { id, dir } = await readyFlow(service);
  process.chdir(ROOT);
  console.log = () => {};

  await expect(runConfirm([id], { isTerminal: false, readChallenge: async () => "abc123", challenge: () => "abc123" })).rejects.toThrow(
    /needs an interactive terminal/,
  );
  let asked = "";
  await expect(
    runConfirm([id], {
      isTerminal: true,
      challenge: () => "abc123",
      readChallenge: async (prompt) => {
        asked = prompt;
        return "abc124";
      },
    }),
  ).rejects.toThrow(/challenge was not typed back correctly/);
  expect(asked).toContain("abc123");
  await expect(readFile(confirmTokenPath(ROOT, dir), "utf8")).rejects.toThrow();
});

test("AC1: the CLI shows what is being confirmed, takes the typed challenge, and prints the token once", async () => {
  const service = await fresh();
  const { id, dir } = await readyFlow(service);
  process.chdir(ROOT);
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

  await runConfirm([id], { isTerminal: true, challenge: () => "k7m2p9", readChallenge: async () => " k7m2p9 " });
  const out = logs.join("\n");
  const flow = await onDisk(dir);
  expect(out).toContain(`${id} — Confirm me`);
  expect(out).toContain(String(flow.acChecksum));
  expect(out).toContain("confirmed: 1 criteria");
  expect(out).toContain(PR);
  expect(out).toContain(CONFIRMATION_CAVEAT);
  const token = /token: (?:\S*?)(\d{3}\.[A-Za-z0-9_-]+)/.exec(out)?.[1] ?? "";
  expect(token.startsWith(`${id}.`)).toBe(true);
  expect(await everyFlowFile(dir)).not.toContain(token);
});

// --- AC2: the gate ------------------------------------------------------------

test("AC2: flow init stamps gates.confirmation from --require-confirmation or the project default, and never otherwise", async () => {
  const service = await fresh();
  const flagged = await service.init({ cwd: ROOT, title: "Flagged", requireConfirmation: true });
  expect(flagged.flow.gates?.confirmation).toBe(true);
  const plain = await service.init({ cwd: ROOT, title: "Plain" });
  expect(plain.flow.gates?.confirmation).toBeUndefined();

  await writeFile(
    path.join(ROOT, ".metaproject", "tasks.config.json"),
    JSON.stringify({ completion: { require_confirmation: true } }),
    "utf8",
  );
  const byDefault = await service.init({ cwd: ROOT, title: "By default" });
  expect(byDefault.flow.gates?.confirmation).toBe(true);
  // Stamped at creation: turning the default off later leaves it set.
  await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ completion: {} }), "utf8");
  expect((await service.get({ cwd: ROOT, id: byDefault.flow.id })).gates?.confirmation).toBe(true);
  // ...and the earlier plain flow never gained it.
  expect((await service.get({ cwd: ROOT, id: plain.flow.id })).gates?.confirmation).toBeUndefined();
});

test("AC2: an opted-in flow fails the confirmation gate with no token, records the attempt, and returns to in-progress", async () => {
  const service = await fresh();
  const { id, dir } = await readyFlow(service);
  const result = await service.complete({ cwd: ROOT, id });
  expect(result.passed).toBe(false);
  const gate = result.gates.find((candidate) => candidate.name === "confirmation");
  expect(gate?.status).toBe("fail");
  expect(gate?.detail).toMatch(/^token_required: /);
  const flow = await onDisk(dir);
  expect(flow.status).toBe("in-progress");
  expect(flow.completionAttempts).toHaveLength(1);
});

async function attemptWith(service: FlowService, id: string, token: string): Promise<string | undefined> {
  const result = await service.complete({ cwd: ROOT, id, confirmToken: token });
  expect(result.passed).toBe(false);
  // A failed attempt leaves the flow in-progress; put it back where a real
  // operator would, for the next attempt.
  await service.implemented({ cwd: ROOT, id, prUrl: PR });
  return result.gates.find((gate) => gate.name === "confirmation")?.detail.split(":")[0];
}

test("AC2: expired, reused, other-flow, pre-criteria-change and mismatched tokens each fail with a named reason", async () => {
  const service = await fresh();
  const { id } = await readyFlow(service);
  const other = await readyFlow(service, { title: "Other flow" });

  // Expired.
  const expired = await service.confirmMint({ cwd: ROOT, id });
  clock = new Date(clock.getTime() + CONFIRMATION_TOKEN_TTL_MS + 1);
  expect(await attemptWith(service, id, expired.token)).toBe("token_expired");

  // Other flow.
  const otherToken = await service.confirmMint({ cwd: ROOT, id: other.id });
  expect(await attemptWith(service, id, otherToken.token)).toBe("token_other_flow");

  // Mismatch: a later mint replaces the earlier one.
  const first = await service.confirmMint({ cwd: ROOT, id });
  await service.confirmMint({ cwd: ROOT, id });
  expect(await attemptWith(service, id, first.token)).toBe("token_mismatch");

  // Minted before the criteria changed.
  const beforeChange = await service.confirmMint({ cwd: ROOT, id });
  await service.acUpdate({ cwd: ROOT, id, criterion: "AC1", text: "Only criterion, reworded", reason: "wording" });
  await service.acConfirm({ cwd: ROOT, id, criterion: "AC1" });
  expect(await attemptWith(service, id, beforeChange.token)).toBe("token_stale_criteria");

  // Reused: spend one on a passing completion, then present it again elsewhere.
  const good = await service.confirmMint({ cwd: ROOT, id: other.id });
  const passed = await service.complete({ cwd: ROOT, id: other.id, confirmToken: good.token });
  expect(passed.passed).toBe(true);
  const reused = await service.complete({ cwd: ROOT, id: other.id, confirmToken: good.token }).catch((error: Error) => error);
  // `done` is terminal, so a second completion is refused before any gate;
  // check the spent state through the token store directly as well.
  expect(reused).toBeInstanceOf(Error);
  const { checkConfirmationToken } = await import("./confirm-token");
  const state = await service.get({ cwd: ROOT, id: other.id });
  const check = await checkConfirmationToken(ROOT, other.dir, { flowId: other.id, acChecksum: state.acChecksum, target: `pr:${PR}` }, good.token, clock);
  expect(check).toEqual({ ok: false, reason: "token_used" });
});

test("AC2: a token is not spent by a FAILING attempt, so the operator can fix the failure and reuse it within the TTL", async () => {
  let health: "pass" | "fail" = "fail";
  const service = await fresh({ healthGate: async () => ({ status: health, reasons: ["P0"] }) });
  const { id } = await readyFlow(service);
  const minted = await service.confirmMint({ cwd: ROOT, id });
  const failed = await service.complete({ cwd: ROOT, id, confirmToken: minted.token });
  expect(failed.passed).toBe(false);
  expect(failed.gates.find((gate) => gate.name === "confirmation")?.status).toBe("pass");
  await service.implemented({ cwd: ROOT, id, prUrl: PR });
  health = "pass";
  const passed = await service.complete({ cwd: ROOT, id, confirmToken: minted.token });
  expect(passed.passed).toBe(true);
});

// --- AC3: what the signature records -------------------------------------------

test("AC3: a passing completion spends the token and records `confirmation` beside an unchanged identity", async () => {
  const service = await fresh();
  const { id, dir } = await readyFlow(service);
  const minted = await service.confirmMint({ cwd: ROOT, id });
  clock = new Date(clock.getTime() + 60_000);
  const result = await service.complete({ cwd: ROOT, id, confirmToken: minted.token, signedBy: "Aleks" });
  expect(result.passed).toBe(true);

  const flow = await onDisk(dir);
  const signature = flow.signatures?.find((candidate) => candidate.kind === "complete");
  expect(signature?.identity).toEqual({ value: "Aleks", basis: "stated", source: "`--signed-by` flag" });
  expect(signature?.confirmation).toEqual({
    mechanism: "terminal-token",
    tokenRef: minted.tokenRef,
    mintedAt: minted.mintedAt,
    consumedAt: clock.toISOString(),
    boundTo: { kind: "complete", acChecksum: String(flow.acChecksum), target: `pr:${PR}` },
  });
  expect(JSON.stringify(flow)).not.toContain(minted.token);
  const stored = JSON.parse(await readFile(confirmTokenPath(ROOT, dir), "utf8")) as { usedAt?: string };
  expect(stored.usedAt).toBe(clock.toISOString());
  expect(validateAgainstSchemaObject(flowStateSchema(), flow).valid).toBe(true);
  // The identity basis vocabulary is unchanged.
  const basis = (flowStateSchema() as { definitions: { identity: { properties: { basis: { enum: string[] } } } } })
    .definitions.identity.properties.basis.enum;
  expect(basis).toEqual(["stated", "derived", "unknown"]);
});

test("AC3: flow status, the flow complete note and the governance report show the confirmation", async () => {
  const service = await fresh();
  const { id } = await readyFlow(service);
  const minted = await service.confirmMint({ cwd: ROOT, id });
  process.chdir(ROOT);
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

  // `flow complete` through the CLI uses the real tracker and health gate, so
  // complete through the service and read the result through the CLI's
  // status view and the governance report.
  await service.complete({ cwd: ROOT, id, confirmToken: minted.token, signedBy: "Aleks" });
  await flowCommand(["status", id]);
  expect(logs.join("\n")).toContain(`+ terminal token ${minted.tokenRef}`);

  const signature = (await service.get({ cwd: ROOT, id })).signatures?.at(-1);
  if (signature === undefined) throw new Error("no signature");
  const notes = completionSignatureNotes(signature);
  expect(notes[0]).toContain("Signed by: Aleks [stated]");
  expect(notes[1]).toContain(`Confirmed with terminal token ${minted.tokenRef}`);
  expect(notes[1]).toContain(CONFIRMATION_CAVEAT);
  // A signature without a confirmation renders exactly as before (AC7).
  const { confirmation: _dropped, ...plain } = signature;
  expect(completionSignatureNotes(plain)).toHaveLength(1);

  const report = renderGovernanceMarkdown(
    await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() }),
  );
  expect(report).toContain(`+ terminal token ${minted.tokenRef}`);
  expect(report).toContain("not proof of who");
});

// --- security review of PR #661: the token binds to the completion target ------

test("review #661: a token minted on pull/1 cannot close the flow after `flow implemented --pr .../pull/999`", async () => {
  const service = await fresh();
  const { id } = await readyFlow(service);
  const minted = await service.confirmMint({ cwd: ROOT, id });
  // The probe from the review: fail once without a token, re-point the PR, retry.
  const without = await service.complete({ cwd: ROOT, id });
  expect(without.passed).toBe(false);
  await service.implemented({ cwd: ROOT, id, prUrl: "https://github.com/acme/app/pull/999" });
  const retargeted = await service.complete({ cwd: ROOT, id, confirmToken: minted.token });
  expect(retargeted.passed).toBe(false);
  expect(retargeted.gates.find((gate) => gate.name === "confirmation")?.detail).toMatch(/^token_target_mismatch: /);
});

test("review #661: a token minted for a PR completion cannot be spent on a --merged one", async () => {
  const service = await fresh({ mainMergeGate: async () => ({ status: "pass", detail: "contained" }) });
  const { id } = await readyFlow(service, { implemented: false });
  // Minted with --merged, spent on a --merged completion: the targets agree.
  const asMerged = await service.confirmMint({ cwd: ROOT, id, merged: true });
  const stored = JSON.parse(await readFile(confirmTokenPath(ROOT, (await onDiskDir(id)) ?? ""), "utf8")) as { target: string };
  expect(stored.target).toBe("merged");
  const merged = await service.complete({ cwd: ROOT, id, confirmToken: asMerged.token, mergedCommit: "7b78ff14" });
  expect(merged.gates.find((gate) => gate.name === "confirmation")?.status).toBe("pass");

  // Minted without --merged (a PR completion), spent on a --merged one: refused.
  const second = await readyFlow(service, { title: "PR shaped" });
  const asPr = await service.confirmMint({ cwd: ROOT, id: second.id });
  await service.complete({ cwd: ROOT, id: second.id }); // back to in-progress, token unspent
  const spentMerged = await service.complete({ cwd: ROOT, id: second.id, confirmToken: asPr.token, mergedCommit: "7b78ff14" });
  expect(spentMerged.passed).toBe(false);
  expect(spentMerged.gates.find((gate) => gate.name === "confirmation")?.detail).toMatch(/^token_target_mismatch: /);
});

async function onDiskDir(id: string): Promise<string | undefined> {
  return (await readdir(path.join(ROOT, ".metaproject", "flows"))).find((dir) => dir.startsWith(`${id}-`));
}

// --- security review of PR #661: a corrupt store is `token_unreadable` ---------

test("review #661: a corrupt or malformed store fails as token_unreadable, and a bad expiresAt never means 'never expires'", async () => {
  const service = await fresh();
  const { id, dir } = await readyFlow(service);
  const minted = await service.confirmMint({ cwd: ROOT, id });
  const good = JSON.parse(await readFile(confirmTokenPath(ROOT, dir), "utf8")) as Record<string, unknown>;
  const state = await service.get({ cwd: ROOT, id });
  const { checkConfirmationToken } = await import("./confirm-token");
  const binding = { flowId: id, acChecksum: state.acChecksum, target: `pr:${PR}` };
  const cases: Array<[string, string]> = [
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"hash"'],
    ["an array", "[]"],
    ["missing hash", JSON.stringify({ ...good, hash: undefined })],
    ["non-string hash", JSON.stringify({ ...good, hash: 7 })],
    ["missing expiresAt", JSON.stringify({ ...good, expiresAt: undefined })],
    ["unparsable expiresAt", JSON.stringify({ ...good, expiresAt: "tomorrow-ish" })],
    ["non-string expiresAt", JSON.stringify({ ...good, expiresAt: 99999999999999 })],
    ["not JSON", "{"],
  ];
  for (const [name, body] of cases) {
    await writeFile(confirmTokenPath(ROOT, dir), body, "utf8");
    const check = await checkConfirmationToken(ROOT, dir, binding, minted.token, clock);
    expect({ name, check }).toEqual({ name, check: { ok: false, reason: "token_unreadable" } });
  }
  // The intact store still verifies, so the cases above failed for their shape alone.
  await writeFile(confirmTokenPath(ROOT, dir), JSON.stringify(good), "utf8");
  expect((await checkConfirmationToken(ROOT, dir, binding, minted.token, clock)).ok).toBe(true);
});

test("review #661: token_other_flow accepts flow ids of any length, not just three digits", async () => {
  const service = await fresh();
  const { id, dir } = await readyFlow(service);
  const state = await service.get({ cwd: ROOT, id });
  const { checkConfirmationToken } = await import("./confirm-token");
  const check = await checkConfirmationToken(
    ROOT,
    dir,
    { flowId: id, acChecksum: state.acChecksum, target: `pr:${PR}` },
    "1234.someothertoken",
    clock,
  );
  expect(check).toEqual({ ok: false, reason: "token_other_flow" });
});
