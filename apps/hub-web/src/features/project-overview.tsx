import { ManagedAttentionOverview } from "./managed-work/overview-attention";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  CheckCircle2,
  GitBranch,
  GitPullRequest,
  Layers,
  Monitor,
} from "lucide-react";
import type { MachineSummary } from "../../../../src/remote-control/protocol";
import { getJson } from "../api/client";
import { remoteGet } from "../api/remote";
import type {
  CodeRevisionSummary,
  HubDocument,
  HubFlow,
  Project,
  Proposal,
} from "../api/types";
import { useHub } from "../app/hub-context";
import { Button, EmptyState, Notice, PageHeading } from "../components/ui";
import { FlowRows } from "./global-flows";
import "./project-overview.css";

type QueryFeedbackProps = {
  query: { isPending: boolean; error: unknown; refetch: () => unknown };
  label: string;
};
function QueryFeedback({ query, label }: QueryFeedbackProps) {
  const { t } = useTranslation("workflow");
  if (query.isPending)
    return (
      <p role="status" className="project-loading">
        {t("projectLoadingSection", { section: label })}
      </p>
    );
  if (query.error)
    return (
      <Notice tone="error">
        {t("projectSectionUnavailable", { section: label })}{" "}
        <Button variant="secondary" onClick={() => void query.refetch()}>
          {t("retry")}
        </Button>
      </Notice>
    );
  return null;
}
export function ProjectOverview() {
  const hub = useHub();
  const { t } = useTranslation("workflow");
  const projectId = hub.projectId ?? "";
  const prefix = `/projects/${encodeURIComponent(projectId)}`;
  const enabled = !!hub.projectId;
  const project = useQuery({
    queryKey: [hub.scopeKey, projectId, "project"],
    enabled,
    queryFn: ({ signal }) => getJson<Project>(prefix, signal),
  });
  const flows = useQuery({
    queryKey: [hub.scopeKey, projectId, "flows"],
    enabled,
    queryFn: ({ signal }) =>
      getJson<{ flows: HubFlow[] }>(`${prefix}/flows`, signal),
  });
  const proposals = useQuery({
    queryKey: [hub.scopeKey, projectId, "proposals"],
    enabled,
    queryFn: ({ signal }) =>
      getJson<{ proposals: Proposal[] }>(`${prefix}/proposals`, signal),
  });
  const documents = useQuery({
    queryKey: [hub.scopeKey, projectId, "documents"],
    enabled,
    queryFn: ({ signal }) =>
      getJson<{ documents: HubDocument[] }>(`${prefix}/documents`, signal),
  });
  const revisions = useQuery({
    queryKey: [hub.scopeKey, projectId, "revisions"],
    enabled,
    queryFn: ({ signal }) =>
      getJson<{ revisions: CodeRevisionSummary[] }>(
        `${prefix}/revisions?summary=1`,
        signal,
      ),
  });
  const machines = useQuery({
    queryKey: [hub.scopeKey, projectId, "remote", "machines"],
    enabled,
    queryFn: ({ signal }) =>
      remoteGet<{ machines: MachineSummary[] }>(
        `/machines?projectId=${encodeURIComponent(projectId)}`,
        signal,
      ),
  });
  const allFlows = flows.data?.flows ?? [];
  const pendingFlows = allFlows.filter((flow) => flow.status === "implemented");
  const pendingProposals =
    proposals.data?.proposals.filter(
      (proposal) => proposal.status === "pending",
    ) ?? [];
  const working = allFlows.filter((flow) => flow.status !== "done");
  const orderedFlows = [...allFlows].sort(
    (a, b) =>
      (a.status === "implemented" ? -1 : 0) -
      (b.status === "implemented" ? -1 : 0),
  );
  const decisionCount = pendingFlows.length + pendingProposals.length;
  const decisionsReady = !!flows.data && !!proposals.data;
  const go = (
    tab: "flows" | "proposals" | "documents" | "machines" | "code" | "history",
    extra: { flowId?: string; documentId?: string; revisionId?: string } = {},
  ) =>
    hub.navigate({
      projectId,
      tab,
      flowId: undefined,
      documentId: undefined,
      revisionId: undefined,
      sessionId: undefined,
      runId: undefined,
      machineId: undefined,
      ...extra,
    });
  const metrics = [
    {
      label: t("activeFlows"),
      value: flows.data ? working.length : "—",
      icon: GitBranch,
      action: () => go("flows"),
    },
    {
      label: t("projectDecisions"),
      value: decisionsReady ? decisionCount : "—",
      icon: CheckCircle2,
      action: () => document.getElementById("project-decisions")?.focus(),
    },
    {
      label: t("projectMachines"),
      value: machines.data ? machines.data.machines.length : "—",
      icon: Monitor,
      action: () => go("machines"),
    },
    {
      label: t("projectContext"),
      value: documents.data ? documents.data.documents.length : "—",
      icon: BookOpen,
      action: () => go("documents"),
    },
  ];
  return (
    <div className="project-overview">
      <PageHeading
        title={project.data?.name ?? t("overviewTitle")}
        description={t("projectWorkspaceDescription")}
        action={
          <Button variant="secondary" onClick={() => go("flows")}>
            {t("viewAllFlows")}
          </Button>
        }
      />
      <QueryFeedback query={project} label={t("overviewTitle")} />
      {project.data && <ManagedAttentionOverview projects={[project.data]} />}
      <h2 className="legacy-overview-scope">{t("work:legacyOverviewScope")}</h2>
      <div className="project-signal-strip">
        {metrics.map(({ label, value, icon: Icon, action }) => (
          <button type="button" key={label} onClick={action}>
            <Icon size={17} aria-hidden="true" />
            <span>
              <strong>{value}</strong>
              <span>{label}</span>
            </span>
          </button>
        ))}
      </div>
      <section
        id="project-decisions"
        className="project-section"
        tabIndex={-1}
        aria-labelledby="project-decisions-title"
      >
        <header className="project-section-header">
          <h2 id="project-decisions-title">
            {t("projectDecisions")}
            {decisionsReady && (
              <span className="project-count">{decisionCount}</span>
            )}
          </h2>
          <span className="project-section-hint">
            {t("projectExplicitDecisions")}
          </span>
        </header>
        <QueryFeedback query={flows} label={t("projectFlows")} />
        <QueryFeedback query={proposals} label={t("pendingProposals")} />
        <div className="project-decisions-grid">
          {pendingFlows.slice(0, 3).map((flow) => (
            <article className="project-decision" key={"flow:" + flow.id}>
              <span className="project-decision-icon">
                <GitBranch size={18} aria-hidden="true" />
              </span>
              <div>
                <span className="project-meta">{t("projectResultReview")}</span>
                <h3>{flow.title}</h3>
                <p>
                  {t("criteriaCount", { count: flow.criteria.length })} ·{" "}
                  {t("version")} {flow.version}
                </p>
                <Button onClick={() => go("flows", { flowId: flow.id })}>
                  {t("projectReviewResult")}
                </Button>
              </div>
            </article>
          ))}
          {pendingProposals.slice(0, 3).map((proposal) => (
            <article
              className="project-decision"
              key={"proposal:" + proposal.id}
            >
              <span className="project-decision-icon">
                <GitPullRequest size={18} aria-hidden="true" />
              </span>
              <div>
                <span className="project-meta">
                  {t("projectContextProposal")}
                </span>
                <h3>
                  {documents.data?.documents.find(
                    (document) => document.id === proposal.documentId,
                  )?.path ?? proposal.documentId}
                </h3>
                <p>{proposal.reason}</p>
                <Button onClick={() => go("proposals")}>
                  {t("nextProposals")}
                </Button>
              </div>
            </article>
          ))}
        </div>
        {decisionsReady && decisionCount === 0 && (
          <p className="project-quiet-state">
            <CheckCircle2 size={16} aria-hidden="true" />
            {t("projectNoDecisions")}
          </p>
        )}
        {(pendingFlows.length > 3 || pendingProposals.length > 3) && (
          <div className="project-more-decisions">
            <Button variant="ghost" onClick={() => go("flows")}>
              {t("viewAllFlows")}
            </Button>
            <Button variant="ghost" onClick={() => go("proposals")}>
              {t("nextProposals")}
            </Button>
          </div>
        )}
      </section>
      <div className="project-work-grid">
        <section
          className="project-section project-flow-section"
          aria-labelledby="project-flow-title"
        >
          <header className="project-section-header">
            <h2 id="project-flow-title">{t("projectFlows")}</h2>
            <Button variant="ghost" onClick={() => go("flows")}>
              {t("viewAllFlows")}
            </Button>
          </header>
          {flows.data &&
            (allFlows.length ? (
              <FlowRows
                rows={orderedFlows.slice(0, 6).map((flow) => ({ flow }))}
              />
            ) : (
              <EmptyState>{t("noFlows")}</EmptyState>
            ))}
        </section>
        <aside className="project-side-column">
          <section
            className="project-section"
            aria-labelledby="project-machines-title"
          >
            <header className="project-section-header">
              <h2 id="project-machines-title">{t("projectMachines")}</h2>
              <Button variant="ghost" onClick={() => go("machines")}>
                {t("projectOpenMachines")}
              </Button>
            </header>
            <QueryFeedback query={machines} label={t("projectMachines")} />
            {machines.data?.machines.map((machine) => (
              <button
                type="button"
                key={machine.machineId}
                className="project-machine"
                onClick={() => go("machines")}
              >
                <Monitor size={18} aria-hidden="true" />
                <span>
                  <strong>{machine.displayName}</strong>
                  <span>
                    {t(
                      machine.revoked
                        ? "projectMachineRevoked"
                        : machine.connected
                          ? "projectMachineOnline"
                          : "projectMachineOffline",
                    )}
                    {machine.inventory &&
                      " · " +
                        t("projectCheckoutCount", {
                          count: machine.inventory.checkouts.filter(
                            (checkout) => checkout.projectId === projectId,
                          ).length,
                        })}
                  </span>
                  {machine.recoveryRequired && (
                    <span className="project-machine-warning">
                      {t("projectMachineRecovery")}
                    </span>
                  )}
                </span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
            {machines.data?.machines.length === 0 && (
              <p className="project-empty-copy">{t("projectNoMachines")}</p>
            )}
          </section>
          <section
            className="project-section"
            aria-labelledby="project-context-title"
          >
            <header className="project-section-header">
              <h2 id="project-context-title">{t("projectContext")}</h2>
              <Button variant="ghost" onClick={() => go("documents")}>
                {t("projectOpenContext")}
              </Button>
            </header>
            <QueryFeedback query={documents} label={t("documents")} />
            {documents.data?.documents.slice(0, 4).map((document) => (
              <button
                type="button"
                className="project-resource"
                key={document.id}
                onClick={() => go("documents", { documentId: document.id })}
              >
                <BookOpen size={14} aria-hidden="true" />
                <span>{document.path}</span>
                <span className="project-resource-version">
                  v{document.version}
                </span>
              </button>
            ))}
            {documents.data?.documents.length === 0 && (
              <p className="project-empty-copy">{t("projectNoContext")}</p>
            )}
          </section>
        </aside>
      </div>
      <section className="project-bottom-grid">
        <div className="project-section">
          <header className="project-section-header">
            <h2>
              <Layers size={15} aria-hidden="true" />
              {t("revisions")}
            </h2>
            <Button variant="ghost" onClick={() => go("code")}>
              {t("projectOpenRevisions")}
            </Button>
          </header>
          <QueryFeedback query={revisions} label={t("revisions")} />
          {revisions.data?.revisions.slice(0, 3).map((revision) => (
            <button
              type="button"
              key={revision.id}
              className="project-resource"
              onClick={() => go("code", { revisionId: revision.id })}
            >
              <span>{revision.message}</span>
              <span className="project-resource-version">
                {t(
                  revision.purpose === "review-bundle"
                    ? "reviewBundle"
                    : "projectSnapshot",
                )}
              </span>
            </button>
          ))}
          {revisions.data?.revisions.length === 0 && (
            <p className="project-empty-copy">{t("projectNoRevisions")}</p>
          )}
        </div>
        <details className="project-integration">
          <summary>{t("integrationTitle")}</summary>
          <p>{t("integrationDescription")}</p>
          <dl>
            <dt>{t("subjectRevision")}</dt>
            <dd>{project.data?.lineRevisionId ?? t("noSelectedRevision")}</dd>
            <dt>{t("lineVersion")}</dt>
            <dd>{project.data?.lineVersion ?? "—"}</dd>
          </dl>
          <Button
            variant="ghost"
            onClick={() => hub.navigate({ projectId, tab: "delivery" })}
          >
            {t("projectOpenDelivery")}
          </Button>
        </details>
      </section>
    </div>
  );
}
