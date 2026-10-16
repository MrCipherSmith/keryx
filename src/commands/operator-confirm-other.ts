// Operator-confirmed gate tools (other gates) — flow 456 (AC3, AC4). Each spec is registered through
// operatorConfirmSpecs() in ./operator-confirm-tools.
//
// Every tool here does IN PROCESS what its CLI verb does after the verb's terminal step:
//
//   flow_confirm      `keryx flow confirm <id> [--merged]`        mints the completion token (TM-03)
//   external_apply    `keryx agents external apply <run-id>`      lands a stored patch as external/<run-id>
//   learn_accept      `keryx learn accept <id>`                   candidate -> accepted
//   learn_promote     `keryx learn promote <id>`                  project accepted -> user candidate
//   learn_graduate    `keryx learn graduate apply <proposal-id>`  writes an agent candidate
//   schedule_resume / schedule_run / schedule_pause / schedule_remove   `keryx schedule <verb> <name>`
//
// The card is built from the REAL state (flow.json, the stored write run, the learned-pattern record,
// the schedule store), never from the model's input alone; the input only names the subject. The
// framework asks the operator, and only after the yes does `apply` call the same library function the
// CLI calls. The terminal proof each library function demands (`isTerminal`, the typed `confirm`
// callback, the typed hash) is satisfied by that card, and the decision is recorded with the card
// text, `confirmedVia` and the time.
//
// Schedules are HMAC-signed (src/trigger/schedule-key.ts). Nothing here signs: resume re-verifies the
// stored entry inside `resumeStoredSchedule`, exactly as the CLI does, and creation stays in
// ./schedule-tools.ts.

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { completionTarget } from "../flow/service";
import { triggerDataDir } from "../trigger/record";
import { listPendingWriteRuns, landWriteRun, viewWriteRun, writeRunLandBlock, type WriteLandDeps } from "../harness/external/write-land";
import type { FlowService } from "../flow/types";
import { confirmPreconditionError } from "../flow/service";
import {
  acceptPattern,
  applyGraduation,
  LearningAcceptError,
  LearningGraduateError,
  LearningPromoteError,
  promotePattern,
  readPattern,
  readProposal,
  type LearnedPattern,
  type GraduationProposalFile,
  type LearningScope,
} from "../learning/service";
import type { ScheduleHost } from "../trigger/install";
import { cardSafe } from "../lib/card-safe";
import {
  listSchedules,
  nestedAgentScheduleRefusal,
  pauseStoredSchedule,
  removeSchedule,
  resumeStoredSchedule,
  scheduleVerification,
  type ScheduleSummary,
} from "../trigger/schedules";
import type { OperatorApplyResult, OperatorCardResult, OperatorConfirmation, OperatorConfirmContext, OperatorConfirmSpec } from "./operator-confirm-tools";

/** Seams for tests. Production passes none. */
export interface OtherConfirmSeams {
  /** Default: a flow service built from the same deps `keryx flow` uses. */
  readonly flowService?: () => Promise<FlowService>;
  /** The session store and worktree location for external write runs. */
  readonly landDeps?: WriteLandDeps;
  /** The user-global learning store's home directory. */
  readonly homeDir?: string;
  /** The OS scheduler seam `keryx schedule` takes. */
  readonly host?: ScheduleHost;
  /** `keryx trigger run <name>` for `schedule_run`. Default: `runTriggerOnce` with `scheduleOnly`. */
  readonly runSchedule?: (projectRoot: string, name: string) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------------------------

const MAX_LISTED = 12;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `message [reason]`, the way `keryx learn` reports a library refusal. */
function learnErrorText(error: unknown): string {
  const reason =
    error instanceof LearningAcceptError || error instanceof LearningPromoteError || error instanceof LearningGraduateError
      ? ` [${error.reason}]`
      : "";
  return `${errorText(error)}${reason}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable digest of a value as it was SHOWN on a card, so `apply` can refuse content that changed after the yes was asked for. */
function contentDigest(value: unknown): string {
  return sha256(JSON.stringify(value ?? null));
}

function limited(lines: readonly string[]): string[] {
  if (lines.length <= MAX_LISTED) return [...lines];
  return [...lines.slice(0, MAX_LISTED), `  ... and ${lines.length - MAX_LISTED} more`];
}

function record(confirmation: OperatorConfirmation): { confirmedVia: string; quote: string } {
  return { confirmedVia: confirmation.confirmedVia, quote: confirmation.quote };
}

/** Run `fn` with console output captured, and `process.exitCode` put back. The CLI verbs print; a tool returns text. */
async function captureConsole(fn: () => Promise<void>): Promise<{ output: string; failed: boolean; error?: unknown }> {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const before = process.exitCode;
  const grab =
    () =>
    (...args: unknown[]): void => {
      lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
  console.log = grab();
  console.error = grab();
  console.warn = grab();
  console.info = grab();
  process.exitCode = 0;
  let thrown: unknown;
  let exitCode: typeof process.exitCode;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  } finally {
    exitCode = process.exitCode;
    console.log = saved.log;
    console.error = saved.error;
    console.warn = saved.warn;
    console.info = saved.info;
    process.exitCode = before;
  }
  const failed = (exitCode ?? 0) !== 0 || thrown !== undefined;
  return { output: lines.join("\n"), failed, ...(thrown !== undefined ? { error: thrown } : {}) };
}

// ---------------------------------------------------------------------------------------------
// flow_confirm
// ---------------------------------------------------------------------------------------------

interface FlowConfirmPrepared {
  readonly flowId: string;
  readonly merged: boolean;
  /** The criteria checksum and completion target printed on the card; `confirmMint` refuses if either moved. */
  readonly acChecksum: string;
  readonly target: string;
}

async function defaultFlowService(): Promise<FlowService> {
  // Lazy: `commands/flow.ts` is large, and only this tool needs it.
  const [{ flowServiceDeps }, { createFlowService }] = await Promise.all([import("./flow"), import("../flow/service")]);
  return createFlowService(flowServiceDeps());
}

function flowConfirmSpec(seams: OtherConfirmSeams): OperatorConfirmSpec<FlowConfirmPrepared> {
  const service = (): Promise<FlowService> => (seams.flowService ?? defaultFlowService)();
  return {
    name: "flow_confirm",
    description:
      "Mint the one-time completion confirmation token for a flow that was created with require-confirmation " +
      "(`keryx flow confirm <id> [--merged]`). The operator sees the flow, its criteria checksum and the completion " +
      "target. On yes the token is returned in the tool output: pass it to `keryx flow complete <id> --confirm-token <token>`.",
    inputSchema: {
      type: "object",
      properties: {
        flow_id: { type: "string", description: "the flow id, e.g. 456" },
        merged: { type: "boolean", description: "true for a direct-merge completion (--merged); default is a pull-request completion" },
      },
      required: ["flow_id"],
      additionalProperties: false,
    },
    buildCard: async (input, ctx): Promise<OperatorCardResult<FlowConfirmPrepared>> => {
      const id = text(input["flow_id"]);
      if (id === undefined) return { refusal: "flow_id is required" };
      const merged = input["merged"] === true;
      let flow;
      try {
        flow = await (await service()).get({ cwd: ctx.projectRoot, id });
      } catch (error) {
        return { refusal: errorText(error) };
      }
      const refusal = confirmPreconditionError(flow, merged);
      if (refusal !== undefined) return { refusal };
      const target = merged ? "direct merge (--merged); the commit is named at `flow complete`" : (flow.pr.url ?? "no PR recorded");
      return {
        title: `Confirm completion of flow ${flow.id}: ${cardSafe(flow.title)}?`,
        lines: [
          `flow: ${flow.id} - ${cardSafe(flow.title)}`,
          `criteria checksum: ${flow.acChecksum ?? "none"}`,
          `criteria confirmed: ${Object.keys(flow.acConfirmed).length}`,
          `completion target: ${cardSafe(target)}`,
          "effect: mints a single-use completion token, valid 10 minutes, bound to this checksum and target",
          "the token is handed to the agent, which can then run `flow complete` - this delegates the completion to it",
          "it proves a yes was pressed in this shell, not who pressed it",
        ],
        subject: `flow ${flow.id} @ criteria ${flow.acChecksum ?? "none"}`,
        prepared: {
          flowId: flow.id,
          merged,
          acChecksum: flow.acChecksum as string,
          target: completionTarget({ merged, prUrl: flow.pr.url }),
        },
      };
    },
    apply: async (_input, ctx, confirmation, prepared): Promise<OperatorApplyResult> => {
      if (prepared === undefined) return { output: "flow_confirm: nothing prepared - no token was minted", isError: true };
      let result;
      try {
        result = await (await service()).confirmMint({
          cwd: ctx.projectRoot,
          id: prepared.flowId,
          merged: prepared.merged,
          confirmation: record(confirmation),
          // Checked inside confirmMint's flow lock: a yes to one card never mints for changed criteria or target.
          expect: { acChecksum: prepared.acChecksum, target: prepared.target },
        });
      } catch (error) {
        return { output: `flow_confirm refused: ${errorText(error)}`, isError: true };
      }
      return {
        output: [
          `token: ${result.token}`,
          `expires ${result.expiresAt}; single use; bound to criteria ${result.acChecksum} (${result.confirmedCriteria}/${result.totalCriteria} confirmed)`,
          `next: keryx flow complete ${prepared.flowId} --confirm-token ${result.token}${prepared.merged ? " --merged <commit>" : ""}`,
        ].join("\n"),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// external_apply
// ---------------------------------------------------------------------------------------------

interface ExternalPrepared {
  readonly runId: string;
  readonly patchHash: string;
  readonly allowFlagged: boolean;
}

function externalApplySpec(seams: OtherConfirmSeams): OperatorConfirmSpec<ExternalPrepared> {
  const landDeps = seams.landDeps ?? {};
  return {
    name: "external_apply",
    description:
      "Land a stored external-agent write run as the new LOCAL branch `external/<run-id>` (`keryx agents external apply`). " +
      "The operator sees the run, the full patch hash, the changed files and any flagged paths. The current branch and " +
      "working tree are never touched. Pass allow_flagged only for a run that changes flagged paths (.git, CI, hooks, agent config).",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "the run id (or a unique prefix) from `keryx agents external review`" },
        allow_flagged: { type: "boolean", description: "also land a diff that touches flagged paths; the card lists them" },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
    buildCard: async (input, ctx): Promise<OperatorCardResult<ExternalPrepared>> => {
      const runId = text(input["run_id"]);
      if (runId === undefined) return { refusal: "run_id is required" };
      const view = viewWriteRun(ctx.projectRoot, runId, landDeps);
      if (view === undefined) return { refusal: `no external write run "${cardSafe(runId)}" in this checkout` };
      const { record: run } = view;
      const blocked = writeRunLandBlock(view);
      if (blocked === "capture-refused") return { refusal: `this run can only be discarded (keryx agents external discard ${cardSafe(run.runId)})` };
      if (blocked !== undefined) return { refusal: "the stored patch is missing or changed since capture; nothing can be landed" };
      if (!listPendingWriteRuns(ctx.projectRoot, landDeps).some((pending) => pending.runId === run.runId)) {
        return { refusal: "the run was already decided" };
      }
      const hash = run.patchHash as string;
      if (run.redacted) {
        return { refusal: "the stored patch was altered by redaction, so landing it would land content the agent did not write" };
      }
      const binary = run.files.filter((file) => file.binary === true).map((file) => file.path);
      if (binary.length > 0) return { refusal: `binary content is not carried by the patch: ${binary.map(cardSafe).join(", ")}` };
      const allowFlagged = input["allow_flagged"] === true;
      if (run.flaggedPaths.length > 0 && !allowFlagged) {
        return {
          refusal:
            `the run changes flagged paths (${run.flaggedPaths.map(cardSafe).join(", ")}); ` +
            "call again with allow_flagged: true so the operator is asked about them explicitly",
        };
      }
      const branch = `external/${run.runId}`;
      const files = run.files.map((file) => `  ${file.status.padEnd(12)} ${cardSafe(file.path)}`);
      return {
        title:
          run.flaggedPaths.length > 0
            ? `Land external run ${run.runId} as branch ${branch}, including ${run.flaggedPaths.length} flagged path(s)?`
            : `Land external run ${run.runId} as branch ${branch}?`,
        lines: [
          `run: ${run.runId}`,
          `agent: ${cardSafe(run.agentId)}`,
          `branch: ${branch} (new, local; cut from base commit ${cardSafe(run.baseCommit)})`,
          `patch hash (sha256): ${hash}`,
          `changed files: ${run.files.length}`,
          ...limited(files),
          ...(run.flaggedPaths.length > 0
            ? [`FLAGGED PATHS (${run.flaggedPaths.length}) - repo plumbing, CI, hooks or agent config:`, ...limited(run.flaggedPaths.map((p) => `  ! ${cardSafe(p)}`))]
            : []),
          "effect: your current branch, HEAD, index and working tree are never touched",
        ],
        subject: `${branch} @ sha256:${hash}`,
        prepared: { runId: run.runId, patchHash: hash, allowFlagged },
      };
    },
    apply: async (_input, ctx, confirmation, prepared): Promise<OperatorApplyResult> => {
      if (prepared === undefined) return { output: "external_apply: nothing prepared - nothing was landed", isError: true };
      const result = await landWriteRun(
        {
          cwd: ctx.projectRoot,
          runId: prepared.runId,
          confirmedPatchHash: prepared.patchHash,
          ...(prepared.allowFlagged ? { allowFlagged: true } : {}),
          confirmation: record(confirmation),
        },
        landDeps,
      );
      if (result.kind === "refused") {
        return { output: `refused (${cardSafe(result.reason)}): ${cardSafe(result.detail)}`, isError: true };
      }
      return {
        output: [
          `landed: branch ${cardSafe(result.branch)}`,
          `commit: ${cardSafe(result.commit)}`,
          "nothing was applied to your current branch or working tree",
        ].join("\n"),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// learn_accept / learn_promote / learn_graduate
// ---------------------------------------------------------------------------------------------

function storeOptions(ctx: OperatorConfirmContext, seams: OtherConfirmSeams): { env: NodeJS.ProcessEnv; homeDir?: string } {
  return { env: ctx.env as NodeJS.ProcessEnv, ...(seams.homeDir !== undefined ? { homeDir: seams.homeDir } : {}) };
}

function patternLines(pattern: LearnedPattern): string[] {
  return [
    `pattern: ${cardSafe(pattern.id)}`,
    `domain: ${pattern.domain}; scope: ${pattern.scope}; status: ${pattern.status}; confidence: ${pattern.confidence}`,
    `trigger: ${cardSafe(pattern.trigger)}`,
    `action: ${cardSafe(pattern.action)}`,
    `evidence: ${pattern.evidence.length} item(s)`,
  ];
}

const SCOPES: readonly LearningScope[] = ["project", "user"];

interface AcceptPrepared {
  readonly id: string;
  readonly scope: LearningScope;
  readonly refresh: boolean;
  /** Digest of the record as the card showed it. */
  readonly digest: string;
}

function learnAcceptSpec(seams: OtherConfirmSeams): OperatorConfirmSpec<AcceptPrepared> {
  return {
    name: "learn_accept",
    description:
      "Accept a learned-pattern candidate (`keryx learn accept <id> [--scope user] [--refresh]`): it becomes an accepted pattern " +
      "that shapes future work. The operator sees the pattern's trigger, action, domain, confidence and evidence count. " +
      "refresh re-reads an already accepted pattern's confidence into the cross-project index instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "the learned-pattern id from `keryx learn list`" },
        scope: { type: "string", enum: ["project", "user"], description: "default: project" },
        refresh: { type: "boolean", description: "refresh the index entry of an already accepted project pattern" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    buildCard: async (input, ctx): Promise<OperatorCardResult<AcceptPrepared>> => {
      const id = text(input["id"]);
      if (id === undefined) return { refusal: "id is required" };
      const scope = input["scope"] === undefined ? "project" : (input["scope"] as LearningScope);
      if (!SCOPES.includes(scope)) return { refusal: `scope must be one of ${SCOPES.join(", ")}` };
      const refresh = input["refresh"] === true;
      const pattern = await readPattern(ctx.projectRoot, id, refresh ? "project" : scope, storeOptions(ctx, seams));
      if (pattern === undefined) return { refusal: `no ${refresh ? "project" : scope}-scope learned-pattern record "${cardSafe(id)}"` };
      if (refresh) {
        if (pattern.status !== "accepted") {
          return { refusal: `record "${cardSafe(id)}" (project) is status "${pattern.status}", not "accepted"; only an accepted record can be refreshed` };
        }
        return {
          title: `Refresh the cross-project index entry for learned pattern ${cardSafe(id)}?`,
          lines: [...patternLines(pattern), "effect: overwrites this project's entry in ~/.keryx/learning/index.json with the live confidence; status unchanged"],
          subject: `learned pattern ${id} (project, refresh)`,
          prepared: { id, scope: "project", refresh: true, digest: contentDigest(pattern) },
        };
      }
      if (pattern.status !== "candidate") {
        return { refusal: `record "${cardSafe(id)}" (${scope}) is status "${pattern.status}", not "candidate"; only a candidate can be accepted` };
      }
      return {
        title: `Accept learned pattern ${cardSafe(id)} (${scope} scope)?`,
        lines: [
          ...patternLines(pattern),
          `effect: status candidate -> accepted${scope === "project" ? "; writes this project's entry in ~/.keryx/learning/index.json" : ""}`,
          "the text is security-scanned again before anything is written",
        ],
        subject: `learned pattern ${id} (${scope})`,
        prepared: { id, scope, refresh: false, digest: contentDigest(pattern) },
      };
    },
    apply: async (_input, ctx, confirmation, prepared): Promise<OperatorApplyResult> => {
      if (prepared === undefined) return { output: "learn_accept: nothing prepared - nothing was accepted", isError: true };
      const now = await readPattern(ctx.projectRoot, prepared.id, prepared.scope, storeOptions(ctx, seams));
      if (now === undefined || contentDigest(now) !== prepared.digest) {
        return { output: "learn_accept refused: the pattern changed after the card was shown; nothing was accepted. Ask for a new card.", isError: true };
      }
      try {
        const result = await acceptPattern(ctx.projectRoot, prepared.id, {
          scope: prepared.scope,
          refresh: prepared.refresh,
          // The card is the operator's answer; the library's terminal proof is satisfied by it.
          isTerminal: true,
          now: ctx.now,
          confirmation: record(confirmation),
          ...storeOptions(ctx, seams),
        });
        return {
          output: `"${result.id}" (${result.scope}) is now accepted.${result.indexUpdated ? " Index entry written/refreshed." : ""}`,
        };
      } catch (error) {
        return { output: `learn_accept refused: ${learnErrorText(error)}`, isError: true };
      }
    },
  };
}

interface PromotePrepared {
  readonly id: string;
  readonly digest: string;
}

function learnPromoteSpec(seams: OtherConfirmSeams): OperatorConfirmSpec<PromotePrepared> {
  return {
    name: "learn_promote",
    description:
      "Promote an accepted project learned pattern into the cross-project user store as a candidate (`keryx learn promote <id>`). " +
      "The operator sees the pattern and that it leaves this project. The library checks distinct-project evidence and the " +
      "security scan first; a refusal comes back without asking.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "the accepted project-scope pattern id" } },
      required: ["id"],
      additionalProperties: false,
    },
    buildCard: async (input, ctx): Promise<OperatorCardResult<PromotePrepared>> => {
      const id = text(input["id"]);
      if (id === undefined) return { refusal: "id is required" };
      const options = storeOptions(ctx, seams);
      const pattern = await readPattern(ctx.projectRoot, id, "project", options);
      if (pattern === undefined) return { refusal: `no project-scope learned-pattern record "${cardSafe(id)}"` };
      // Every library check runs before the library asks `confirm`; answering "no" proves they all pass
      // (promote-cancelled) or surfaces the first one that does not, with nothing written either way.
      try {
        await promotePattern(ctx.projectRoot, id, { isTerminal: true, confirm: async () => false, now: ctx.now(), ...options });
      } catch (error) {
        if (!(error instanceof LearningPromoteError && error.reason === "promote-cancelled")) {
          return { refusal: cardSafe(learnErrorText(error)) };
        }
      }
      return {
        title: `Promote learned pattern ${cardSafe(id)} to the cross-project user store?`,
        lines: [
          ...patternLines(pattern),
          "effect: copies it to ~/.keryx/learning as a user-scope candidate (30-day TTL); other projects can then see it",
        ],
        subject: `learned pattern ${id} (project -> user)`,
        prepared: { id, digest: contentDigest(pattern) },
      };
    },
    apply: async (_input, ctx, confirmation, prepared): Promise<OperatorApplyResult> => {
      if (prepared === undefined) return { output: "learn_promote: nothing prepared - nothing was promoted", isError: true };
      const now = await readPattern(ctx.projectRoot, prepared.id, "project", storeOptions(ctx, seams));
      if (now === undefined || contentDigest(now) !== prepared.digest) {
        return { output: "learn_promote refused: the pattern changed after the card was shown; nothing was promoted. Ask for a new card.", isError: true };
      }
      try {
        const result = await promotePattern(ctx.projectRoot, prepared.id, {
          isTerminal: true,
          confirm: async () => true,
          confirmation: record(confirmation),
          now: ctx.now(),
          ...storeOptions(ctx, seams),
        });
        return { output: `"${result.id}" promoted to scope "${result.scope}" as status "${result.status}".` };
      } catch (error) {
        return { output: `learn_promote refused: ${learnErrorText(error)}`, isError: true };
      }
    },
  };
}

interface GraduatePrepared {
  readonly proposalId: string;
  /** Digest of the proposal file and its member patterns as the card showed them. */
  readonly digest: string;
}

/** The proposal as shown plus the member patterns it would be built from (the written agent is recomputed from them). */
async function graduationDigest(ctx: OperatorConfirmContext, seams: OtherConfirmSeams, proposal: GraduationProposalFile): Promise<string> {
  const members = await Promise.all(proposal.members.map((id) => readPattern(ctx.projectRoot, id, "project", storeOptions(ctx, seams))));
  return contentDigest({ proposal, members });
}

function learnGraduateSpec(seams: OtherConfirmSeams): OperatorConfirmSpec<GraduatePrepared> {
  return {
    name: "learn_graduate",
    description:
      "Apply a learned-pattern graduation proposal that targets an agent (`keryx learn graduate apply <proposal-id>`): it writes " +
      "an agent candidate file under .metaproject/agents/. The operator sees the proposal, its member patterns and what is written. " +
      "Skill and rule proposals are not applied here.",
    inputSchema: {
      type: "object",
      properties: { proposal_id: { type: "string", description: "the proposal id from `keryx learn graduate`, e.g. grad-agent-0123456789ab" } },
      required: ["proposal_id"],
      additionalProperties: false,
    },
    buildCard: async (input, ctx): Promise<OperatorCardResult<GraduatePrepared>> => {
      const proposalId = text(input["proposal_id"]);
      if (proposalId === undefined) return { refusal: "proposal_id is required" };
      let proposal: GraduationProposalFile;
      try {
        proposal = await readProposal(ctx.projectRoot, proposalId);
      } catch (error) {
        return { refusal: cardSafe(learnErrorText(error)) };
      }
      const options = storeOptions(ctx, seams);
      // As learn_promote: the library runs every check before it asks `confirm`, so "no" only proves them.
      try {
        await applyGraduation(ctx.projectRoot, proposalId, { isTerminal: true, confirm: async () => false, now: ctx.now(), ...options });
      } catch (error) {
        if (!(error instanceof LearningGraduateError && error.reason === "graduate-apply-cancelled")) {
          return { refusal: cardSafe(learnErrorText(error)) };
        }
      }
      return {
        title: `Apply graduation proposal ${cardSafe(proposalId)} as an agent candidate?`,
        lines: [
          `proposal: ${cardSafe(proposalId)}`,
          `target: ${proposal.target}; domain: ${proposal.domain}`,
          `members: ${proposal.members.map(cardSafe).join(", ")}`,
          `summary: ${cardSafe(proposal.summary)}`,
          `effect: writes a new agent candidate .metaproject/agents/<name>.md (suggested name: ${cardSafe(proposal.suggestedName)}; ` +
            "the name is recomputed from the member patterns now); read-only tools only",
        ],
        subject: `graduation proposal ${proposalId}`,
        prepared: { proposalId, digest: await graduationDigest(ctx, seams, proposal) },
      };
    },
    apply: async (_input, ctx, confirmation, prepared): Promise<OperatorApplyResult> => {
      if (prepared === undefined) return { output: "learn_graduate: nothing prepared - nothing was written", isError: true };
      try {
        const proposal = await readProposal(ctx.projectRoot, prepared.proposalId);
        if ((await graduationDigest(ctx, seams, proposal)) !== prepared.digest) {
          return { output: "learn_graduate refused: the proposal or its member patterns changed after the card was shown; nothing was written. Ask for a new card.", isError: true };
        }
      } catch (error) {
        return { output: `learn_graduate refused: ${learnErrorText(error)}`, isError: true };
      }
      try {
        const result = await applyGraduation(ctx.projectRoot, prepared.proposalId, {
          isTerminal: true,
          confirm: async () => true,
          confirmation: record(confirmation),
          now: ctx.now(),
          ...storeOptions(ctx, seams),
        });
        return { output: `"${prepared.proposalId}" applied. Agent candidate written to ${result.path}.` };
      } catch (error) {
        return { output: `learn_graduate refused: ${learnErrorText(error)}`, isError: true };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// schedule_resume / schedule_run / schedule_pause / schedule_remove
// ---------------------------------------------------------------------------------------------

type ScheduleVerb = "resume" | "run" | "pause" | "remove";

interface SchedulePrepared {
  readonly name: string;
}

const SCHEDULE_DESCRIPTIONS: Readonly<Record<ScheduleVerb, string>> = {
  resume:
    "Re-enable a paused schedule and its OS timer (`keryx schedule resume <name>`). The stored entry is re-verified against its " +
    "signature first; a tampered entry is refused. ",
  run: "Run one pass of a schedule now (`keryx schedule run <name>`): one unattended agent turn that spends the schedule's budget. ",
  pause: "Pause a schedule: disable its timer and mark it disabled (`keryx schedule pause <name>`). ",
  remove: "Remove a schedule: uninstall its timer (only keryx-written files) and delete its entry (`keryx schedule remove <name>`). ",
};

/** Per-machine operator decisions on schedules. Under the trigger data dir the unattended floor protects; never inside the signed entry. */
export function scheduleDecisionLogPath(projectRoot: string): string {
  return path.join(triggerDataDir(projectRoot), "operator-decisions.jsonl");
}

async function recordScheduleDecision(
  projectRoot: string,
  line: { action: string; name: string; quote: string; confirmedVia: string; at: string },
): Promise<void> {
  const file = scheduleDecisionLogPath(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}

function scheduleLines(row: ScheduleSummary): string[] {
  const a = row.entry.action;
  const kind = a.digest !== undefined ? "digest (runs inside `keryx serve`)" : a.review !== undefined ? `autonomous review of ${cardSafe(a.review.ref)}` : "agent task";
  const last = row.last === undefined ? "never ran" : `${row.last.outcome} at ${row.last.at}${row.last.usd !== undefined ? `, $${row.last.usd.toFixed(4)}` : ""}`;
  return [
    `schedule: ${cardSafe(row.name)} [${row.enabled ? "enabled" : "paused"}] - ${kind}`,
    `cadence: cron "${cardSafe(row.cron)}"; next run: ${row.nextRun?.toISOString() ?? "none (paused)"}`,
    `action: ${a.digest !== undefined ? "GitHub and board digest" : cardSafe(a.prompt)}`,
    `runner: ${cardSafe(a.dispatch.provider)}/${cardSafe(a.dispatch.model)}, mode ${a.dispatch.permissionMode}, ceiling $${a.dispatch.ceilingUsd}, max ${a.dispatch.maxSeconds}s`,
    `network: ${a.grants.network}; granted tools: ${a.grants.tools.map(cardSafe).join(", ") || "none"}`,
    `last run: ${last}`,
  ];
}

function scheduleSpec(verb: ScheduleVerb, seams: OtherConfirmSeams): OperatorConfirmSpec<SchedulePrepared> {
  const host = seams.host ?? {};
  const titles: Record<ScheduleVerb, (name: string) => string> = {
    resume: (name) => `Resume schedule ${name} and re-enable its timer?`,
    run: (name) => `Run schedule ${name} once now?`,
    pause: (name) => `Pause schedule ${name} and disable its timer?`,
    remove: (name) => `Remove schedule ${name} and uninstall its timer?`,
  };
  const effects: Record<ScheduleVerb, string> = {
    resume: "effect: re-enables the OS timer; the entry runs unattended again from its next cron time",
    run: "effect: one unattended agent turn starts now with the runner, budget and granted tools above",
    pause: "effect: the timer is disabled and the entry marked disabled; a fire while paused records no-op",
    remove: "effect: uninstalls the timer (only keryx-written files) and deletes the stored entry; its past reports stay",
  };
  return {
    name: `schedule_${verb}`,
    description: `${SCHEDULE_DESCRIPTIONS[verb]}The operator sees the schedule's name, action, cadence, runner and budget. Create schedules with schedule_create.`,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "the schedule name from schedule_list" } },
      required: ["name"],
      additionalProperties: false,
    },
    buildCard: async (input, ctx): Promise<OperatorCardResult<SchedulePrepared>> => {
      const nested = nestedAgentScheduleRefusal(ctx.env);
      if (nested !== undefined) return { refusal: `schedule_${verb} ${nested}` };
      const name = text(input["name"]);
      if (name === undefined) return { refusal: "name is required" };
      const rows = await listSchedules(ctx.projectRoot, { host, now: ctx.now });
      const row = rows.find((r) => r.name === name);
      if (row === undefined) return { refusal: `no schedule named "${cardSafe(name)}" (schedule_list shows them)` };
      if (verb === "resume" && row.enabled) return { refusal: `schedule "${cardSafe(name)}" is not paused` };
      if ((verb === "pause" || verb === "run") && !row.enabled) {
        return { refusal: `schedule "${cardSafe(name)}" is paused, so ${verb === "pause" ? "there is nothing to pause" : "it would not run"}` };
      }
      if (verb === "resume" || verb === "run") {
        const verified = await scheduleVerification(ctx.projectRoot, name);
        if (!verified.ok) return { refusal: `${verb} refused: ${cardSafe(verified.reason)}` };
      }
      return {
        title: titles[verb](cardSafe(name)),
        lines: [...scheduleLines(row), effects[verb]],
        subject: `schedule ${name}`,
        prepared: { name },
      };
    },
    apply: async (_input, ctx, confirmation, prepared): Promise<OperatorApplyResult> => {
      if (prepared === undefined) return { output: `schedule_${verb}: nothing prepared - nothing was changed`, isError: true };
      const { name } = prepared;
      // The decision is recorded before the effect, so a verb that fails half way still leaves the yes on file.
      await recordScheduleDecision(ctx.projectRoot, { action: `schedule_${verb}`, name, ...record(confirmation), at: ctx.now().toISOString() });
      switch (verb) {
        case "pause":
          await pauseStoredSchedule(ctx.projectRoot, name, host);
          return { output: `"${name}" paused (timer disabled, entry disabled).` };
        case "resume":
          await resumeStoredSchedule(ctx.projectRoot, name, host);
          return { output: `"${name}" resumed (timer enabled).` };
        case "remove": {
          const result = await removeSchedule(ctx.projectRoot, name, host);
          return {
            output:
              `"${name}" removed${result.removed.length > 0 ? ` (${result.removed.join(", ")})` : ""}.` +
              (result.skipped.length > 0 ? `\nleft untouched (not written by keryx for this project): ${result.skipped.join(", ")}` : ""),
          };
        }
        case "run": {
          const run = seams.runSchedule ?? (async (root: string, scheduleName: string): Promise<void> => {
            const { runTriggerOnce } = await import("./trigger");
            await runTriggerOnce(root, scheduleName, {}, { scheduleOnly: true });
          });
          const captured = await captureConsole(() => run(ctx.projectRoot, name));
          const detail = captured.error !== undefined ? `${captured.output}\n${errorText(captured.error)}`.trim() : captured.output;
          return { output: detail.length > 0 ? detail : `"${name}" ran once.`, isError: captured.failed };
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------

/** The gates of this module, for `operatorConfirmSpecs()`. `seams` is for tests; the registry passes none. */
export function otherConfirmSpecs(seams: OtherConfirmSeams = {}): readonly OperatorConfirmSpec[] {
  return [
    flowConfirmSpec(seams),
    externalApplySpec(seams),
    learnAcceptSpec(seams),
    learnPromoteSpec(seams),
    learnGraduateSpec(seams),
    scheduleSpec("resume", seams),
    scheduleSpec("run", seams),
    scheduleSpec("pause", seams),
    scheduleSpec("remove", seams),
  ];
}
