// The review-shaped view commands of `keryx acp --profile shell` (T10b): `/ci`, `/conform`,
// bare `/review`, `/product`, `/ac`, `/workspace` and `/decisions`.
//
// Each reads what the TUI modal reads and answers a view; the modal's keys become command
// lines (`/ci triage`, `/conform run`, `/review accept`, `/ac recheck`, `/decisions reason`).
// The ones that send data out of the machine (`/ci triage`, `/conform run`) or decide a
// proposal (`/review accept`) carry a `confirm`.

import { armsText, decisionsFollowup, parseDecisionsCommand } from "../tui/decisions-surface";
import { reportText } from "../decisions/service";
import { loadCiTriageList } from "../tui/ci-triage-source";
import { loadConformSetup } from "../tui/conform-source";
import { loadInspectorCatchUp, catchUpItems, loadInspectorFlows, loadInspectorSlates, loadInspectorWorkspace } from "../tui/inspector-sources";
import { loadOpenReport } from "../product/service";
import { formatProductHeaderLines, formatProductRowLines } from "../tui/product-open-surface";
import { formatSlateDetailLines, formatWorkspaceOverviewLines } from "../tui/workspace-inspector";
import { readSlate } from "../session/slate";
import { acRecheck, ciTriage, conformRun, reviewDecide, REVIEW_DECIDE_USAGE } from "../commands/shell-subcommands";
import type { ShellCommandHost, ShellCommandOutcome } from "./shell-command-runners";
import { action, viewRow, type ShellView, type ShellViewRow } from "./shell-views";
import { actionOutcome, refusal, viewOutcome } from "./shell-views-outcome";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// /ci
// ---------------------------------------------------------------------------

const CI_CONFIRM = "Triage sends a redacted, bounded excerpt of this job's failed log to the configured Jev/OpenRouter model. Continue?";

async function ciView(host: ShellCommandHost): Promise<ShellView> {
  let listed;
  try {
    listed = await loadCiTriageList(host.cwd);
  } catch (error) {
    return { title: "CI triage", rows: [], body: `ci: ${errorText(error)}` };
  }
  const rows = listed.items.map((item) =>
    viewRow(`${item.runId}:${item.jobName}`, item.jobName, {
      status: item.conclusion ?? "unknown",
      detail: `run ${item.runId} · ${item.workflowName}/${item.headBranch}${item.createdAt !== undefined && item.createdAt !== null ? ` · ${item.createdAt}` : ""}`,
      actions: [action("Triage", `/ci triage ${item.runId} ${item.jobName}`, CI_CONFIRM)],
    }),
  );
  return {
    title: "CI triage",
    rows,
    body: rows.length === 0 ? (listed.note ?? "No failed CI runs found for the current branch's pull request.") : "Failed jobs of the current branch's pull request. The verdict is advisory.",
  };
}

export async function runCi(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (args.trim().length === 0) return viewOutcome(await ciView(host));
  if (sub === "triage") return actionOutcome(await ciTriage(host.cwd, rest.join(" ")), []);
  return refusal(`Unknown /ci argument '${sub}'. Usage: /ci [triage <run id> [job name]]`);
}

// ---------------------------------------------------------------------------
// /conform
// ---------------------------------------------------------------------------

const CONFORM_CONFIRM = "Conformance sends the reference clauses and the diff's hunks to the configured Jev/OpenRouter model. Continue?";

async function conformView(host: ShellCommandHost): Promise<ShellView> {
  let setup;
  try {
    setup = await loadConformSetup(host.cwd);
  } catch (error) {
    return { title: "Conformance", rows: [], body: `conform: ${errorText(error)}` };
  }
  const rows = setup.recents.map((doc) =>
    viewRow(doc, doc, {
      status: "recent document",
      actions: setup.targets.map((target) => action(`Check ${target.label}`, `/conform run ${target.id} ${doc}`, CONFORM_CONFIRM)),
    }),
  );
  return {
    title: "Conformance",
    rows,
    body: setup.targets.length === 0 ? (setup.note ?? "No conformance target is available.") : `Targets: ${setup.targets.map((target) => `${target.id} (${target.label})`).join(", ")}`,
    ...(setup.targets.length > 0
      ? {
          form: {
            fields: [
              { id: "doc", label: "Reference document", kind: "text" as const, required: true, placeholder: "path to a document, e.g. docs/spec.md" },
              { id: "target", label: "Target", kind: "choice" as const, required: true, options: setup.targets.map((target) => target.id) },
            ],
            submit: "/conform run {target} {doc}",
          },
        }
      : {}),
  };
}

export async function runConform(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (args.trim().length === 0) return viewOutcome(await conformView(host));
  if (sub === "run") return actionOutcome(await conformRun(host.cwd, rest.join(" ")), []);
  return refusal(`Unknown /conform argument '${sub}'. Usage: /conform [run <target id> <reference document>]`);
}

// ---------------------------------------------------------------------------
// /review (bare): the catch-up list
// ---------------------------------------------------------------------------

async function reviewView(host: ShellCommandHost): Promise<ShellView> {
  let items;
  try {
    items = catchUpItems(await loadInspectorCatchUp(host.cwd));
  } catch (error) {
    return { title: "Review", rows: [], body: `review: ${errorText(error)}` };
  }
  const rows = items.map((item, index): ShellViewRow => {
    switch (item.type) {
      case "proposal": {
        const ref = `${item.workspaceId} ${item.proposalId}`;
        return viewRow(`proposal-${item.proposalId}`, `${item.kind} ${item.proposalId}`, {
          status: item.fresh ? "proposal" : "proposal (stale)",
          detail: `workspace ${item.workspaceId} · ${item.author} · ${item.createdAt}${item.fresh ? "" : "\nevidence has drifted: re-run wrap-up before deciding"}${item.note !== undefined ? `\n${item.note}` : ""}`,
          actions: [
            action("Accept", `/review accept ${ref}`, `Accept proposal ${item.proposalId} in ${item.workspaceId}? This writes to the owning wiki, memory or skill.`),
            action("Accept, acknowledging security findings", `/review accept-ack ${ref}`, `Accept ${item.proposalId} and state that you read the evidence's security findings?`),
            action("Decline", `/review decline ${ref}`, `Decline proposal ${item.proposalId}?`),
          ],
        });
      }
      case "blocked":
        return viewRow(`blocked-${index}`, item.sessionId, { status: "blocked", detail: `${item.terminalState.reason}\nResume: keryx shell -r ${item.sessionId}` });
      case "unbound-candidate":
        return viewRow(`unbound-${index}`, item.sessionId ?? `unbound-${index}`, { status: "unbound", detail: `${item.summary}\nEvidence: ${item.evidencePath}` });
      case "unknown":
        return viewRow(`unknown-${index}`, item.sessionId, { status: "unknown", detail: `last seen ${item.lastSeenAt}\nInvestigate: keryx sessions list` });
    }
  });
  return { title: "Review", rows, body: rows.length === 0 ? "Nothing needs review right now." : "Proposals wait for a decision; the other rows name the next step." };
}

export async function runReview(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (args.trim().length === 0) return viewOutcome(await reviewView(host));
  if (sub === "accept" || sub === "accept-ack" || sub === "decline") return actionOutcome(await reviewDecide(host.cwd, sub, rest.join(" ")), []);
  return refusal(`Unknown /review argument '${sub}'. ${REVIEW_DECIDE_USAGE} | /review layers | parity | readiness`);
}

// ---------------------------------------------------------------------------
// /product, /ac, /workspace
// ---------------------------------------------------------------------------

async function productView(host: ShellCommandHost): Promise<ShellView> {
  let load;
  try {
    load = await loadOpenReport(host.cwd);
  } catch {
    return { title: "Product", rows: [], body: "The product index could not be used. Run `keryx product index`." };
  }
  if (!load.ok) return { title: "Product", rows: [], body: load.message };
  const header = formatProductHeaderLines(load).join("\n");
  const blocks = formatProductRowLines(load).join("\n").split(/\n\n/).map((block) => block.trim()).filter((block) => block.length > 0);
  const rows = load.report.entries.length === 0 ? [] : blocks.map((block, index) => {
    const [first = "", ...rest] = block.split("\n");
    return viewRow(`open-${index}`, first.trim(), { detail: rest.join("\n") });
  });
  return { title: "Product: never checked", rows, body: load.report.entries.length === 0 ? `${header}\nNothing closed in code is waiting for a look back.` : header };
}

async function acView(host: ShellCommandHost): Promise<ShellView> {
  let flows;
  try {
    flows = await loadInspectorFlows(host.cwd);
  } catch (error) {
    return { title: "Acceptance criteria", rows: [], body: `ac: ${errorText(error)}` };
  }
  const rows = flows
    .filter((flow) => flow.status !== "done" || flow.acMarkers !== undefined)
    .map((flow) => {
      const frozen = flow.acFrozen !== false;
      const markers = flow.acMarkers;
      const stale = flow.acCheckStale === true ? " (stale)" : flow.acCheckStale === "unknown" ? " (freshness unknown)" : "";
      return viewRow(flow.id, `${flow.id} ${flow.title}`, {
        status: !frozen ? "not frozen" : markers === undefined ? "not run" : `checked${stale}`,
        detail: markers === undefined ? "" : `${flow.acCheckedAt !== undefined ? `checked ${flow.acCheckedAt}\n` : ""}${markers.map((marker) => `${marker.id}  ${marker.status}  ${marker.label}`).join("\n")}`,
        actions: frozen ? [action("Re-check", `/ac recheck ${flow.id}`, `Re-check flow ${flow.id}'s frozen criteria against its diff? This may ask the configured Jev model.`)] : [],
      });
    });
  return { title: "Acceptance criteria", rows, body: rows.length === 0 ? "No open flows with frozen acceptance criteria." : "The check is advisory: it never confirms a criterion." };
}

export async function runAc(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (args.trim().length === 0) return viewOutcome(await acView(host));
  if (sub === "recheck") return actionOutcome(await acRecheck(host.cwd, rest.join(" ")), []);
  return refusal(`Unknown /ac argument '${sub}'. Usage: /ac [recheck <flow id>]`);
}

async function workspaceView(host: ShellCommandHost): Promise<ShellView> {
  const dir = host.sessionDir();
  const workspaceId = dir === undefined ? undefined : (await readSlate(dir).catch(() => undefined))?.workspaceId;
  if (workspaceId === undefined) {
    return { title: "Workspace", rows: [], body: "No workspace bound to this session yet — the agent binds one automatically on its first real task." };
  }
  const [workspace, slates] = await Promise.all([loadInspectorWorkspace(host.cwd, workspaceId), loadInspectorSlates(host.cwd, workspaceId)]);
  if (workspace === undefined) return { title: "Workspace", rows: [], body: `Workspace ${workspaceId} could not be loaded.` };
  return {
    title: `Workspace ${workspace.id}`,
    body: formatWorkspaceOverviewLines(workspace, slates.length).join("\n"),
    rows: slates.map((slate) =>
      viewRow(slate.sessionId, slate.sessionTitle, {
        status: slate.courseStatus,
        detail: formatSlateDetailLines(slate).slice(2).join("\n"),
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// /decisions
// ---------------------------------------------------------------------------

async function decisionsView(host: ShellCommandHost): Promise<ShellView> {
  const report = await reportText(host.cwd).catch(() => "The recommendation journal could not be read.");
  return {
    title: "Decisions",
    body: report,
    rows: [viewRow("arms", "Arm summary", { detail: "How often the recommendation was followed in each arm.", actions: [action("Show", "/decisions arms")] })],
    form: { fields: [{ id: "reason", label: "Reason for the latest answer", kind: "text", required: true, placeholder: "why you answered this way" }], submit: "/decisions reason {reason}" },
  };
}

export async function runDecisions(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const command = parseDecisionsCommand(`/decisions ${args}`);
  if (command.kind === "show") return viewOutcome(await decisionsView(host));
  if (command.kind === "arms") return { text: `${await armsText(host.cwd)}`.replace(/\n?$/, "\n") };
  const session = host.session.handle().summary.id;
  const done = await decisionsFollowup(command, { cwd: host.cwd, session });
  return done.ok ? { text: `${done.text}\n` } : refusal(done.text);
}

// The views with no subcommands: opened bare, or refused when given arguments.
export async function runReadOnlyView(host: ShellCommandHost, name: "product" | "workspace", args: string): Promise<ShellCommandOutcome> {
  if (args.trim().length > 0) return refusal(`/${name} takes no arguments here.`);
  return viewOutcome(name === "product" ? await productView(host) : await workspaceView(host));
}
