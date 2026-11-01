import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getJson, errorMessage } from "../api/client";
import type { HubFlow, Project } from "../api/types";
import { useHub } from "../app/hub-context";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeading,
  Select,
  StatusBadge,
} from "../components/ui";
import { formatDate } from "../i18n/format";
import "./global-flows.css";

const statuses: HubFlow["status"][] = [
  "initializing",
  "ready",
  "in-progress",
  "implemented",
  "completing",
  "done",
];

export function GlobalFlowsView() {
  const hub = useHub();
  const { t } = useTranslation("workflow");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const projects = useQuery({
    queryKey: [hub.scopeKey, "projects"],
    queryFn: ({ signal }) =>
      getJson<{ projects: Project[] }>("/projects", signal),
  });
  const flowQueries = useQueries({
    queries: (projects.data?.projects ?? []).map((project) => ({
      queryKey: [hub.scopeKey, project.id, "flows"],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getJson<{ flows: HubFlow[] }>(
          `/projects/${encodeURIComponent(project.id)}/flows`,
          signal,
        ),
    })),
  });
  const rows = (projects.data?.projects ?? []).flatMap((project, index) =>
    (flowQueries[index].data?.flows ?? []).map((flow) => ({ project, flow })),
  );
  const normalized = search.trim().toLocaleLowerCase();
  const filtered = rows.filter(
    ({ project, flow }) =>
      (!status || flow.status === status) &&
      `${project.name} ${flow.title}`.toLocaleLowerCase().includes(normalized),
  );
  return (
    <div className="hub-flow-overview">
      <PageHeading
        title={t("allFlows")}
        description={t("allFlowsDescription")}
      />
      <div className="hub-flow-toolbar">
        <Field label={t("searchFlows")}>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("globalSearchPlaceholder")}
          />
        </Field>
        <Field label={t("flowState")}>
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">{t("allStates")}</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {t("common:status." + value, { defaultValue: value })}
              </option>
            ))}
          </Select>
        </Field>
        <span className="hub-flow-count">
          {t("visibleFlows", { visible: filtered.length, total: rows.length })}
        </span>
      </div>
      {projects.isPending && <EmptyState>{t("loading")}</EmptyState>}
      {projects.error && (
        <Notice tone="error">
          {errorMessage(projects.error, t)}{" "}
          <Button variant="secondary" onClick={() => void projects.refetch()}>
            {t("retry")}
          </Button>
        </Notice>
      )}
      {projects.data?.projects.map((project, index) => {
        const query = flowQueries[index];
        if (query.isPending)
          return (
            <p key={project.id} role="status">
              {t("projectFlowsLoading", { project: project.name })}
            </p>
          );
        if (query.error)
          return (
            <Notice key={project.id} tone="error">
              <strong>{project.name}</strong> · {errorMessage(query.error, t)}{" "}
              <Button variant="secondary" onClick={() => void query.refetch()}>
                {t("retry")}
              </Button>
            </Notice>
          );
        return null;
      })}
      {rows.length > 0 && <FlowRows rows={filtered} showProject />}
      {projects.data &&
        flowQueries.every((query) => !query.isPending && !query.error) &&
        filtered.length === 0 && (
          <EmptyState>{t("noMatchingFlows")}</EmptyState>
        )}
    </div>
  );
}

export function FlowRows({
  rows,
  showProject = false,
}: {
  rows: { flow: HubFlow; project?: Project }[];
  showProject?: boolean;
}) {
  const hub = useHub();
  const { t, i18n } = useTranslation("workflow");
  return (
    <div
      className="hub-flow-table"
      role="table"
      aria-label={t(showProject ? "allFlows" : "boardTitle")}
    >
      <div className="hub-flow-table-heading" role="row">
        <span role="columnheader">
          {t(showProject ? "flowAndProject" : "boardTitle")}
        </span>
        <span role="columnheader">{t("flowState")}</span>
        <span role="columnheader">{t("acceptanceCriteria")}</span>
        <span role="columnheader">{t("humanAcceptance")}</span>
      </div>
      {rows.map(({ flow, project }) => (
        <div
          key={`${flow.projectId}:${flow.id}`}
          className="hub-flow-table-row"
          role="row"
        >
          <div role="cell">
            <button
              type="button"
              className="hub-flow-link"
              onClick={() =>
                hub.navigate({
                  projectId: flow.projectId,
                  tab: "flows",
                  flowId: flow.id,
                  documentId: undefined,
                  revisionId: undefined,
                  sessionId: undefined,
                  runId: undefined,
                  machineId: undefined,
                })
              }
            >
              {flow.title}
            </button>
            {showProject && (
              <span className="hub-flow-meta">
                {project?.name ?? flow.projectId}
              </span>
            )}
            <span className="hub-flow-meta">
              {t("version")} {flow.version} ·{" "}
              {flow.specContentDigest.slice(0, 12)}
            </span>
          </div>
          <div role="cell">
            <StatusBadge status={flow.status} />
          </div>
          <div role="cell">
            <span>{t("criteriaCount", { count: flow.criteria.length })}</span>
            <span className="hub-flow-meta">{t("coverageNotReported")}</span>
          </div>
          <div role="cell">
            {flow.acceptedBy ? (
              <>
                <span>
                  {t("acceptedBy")}: {flow.acceptedBy}
                </span>
                {flow.acceptedAt && (
                  <span className="hub-flow-meta">
                    {formatDate(flow.acceptedAt, i18n.language)}
                  </span>
                )}
              </>
            ) : (
              <span className="hub-flow-meta">{t("notAccepted")}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
