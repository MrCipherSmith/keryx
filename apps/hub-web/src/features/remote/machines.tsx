import { useState, useEffect } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Monitor,
  MessageSquare,
  ChevronRight,
  GitBranch,
  FolderOpen,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  MachineSummary,
  RunRecord,
} from "../../../../../src/remote-control/protocol";
import type { Project } from "../../api/types";
import type { Control } from "../../api/remote";
import { useHub } from "../../app/hub-context";
import { remoteGet, remoteMutate, remoteProject } from "../../api/remote";
import { useRemoteAction } from "../../api/remote-hooks";
import { ApiError, errorMessage, getJson } from "../../api/client";
import { formatDate } from "../../i18n/format";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeading,
  Panel,
} from "../../components/ui";
import { ActionFeedback, Feedback, useOperator } from "./shared";
import "./machine-cards.css";

type SessionPageRequest = { projectId: string; cursor: number };

function hasRequestedSessionPage(
  requests: SessionPageRequest[], projectId: string, cursor: number,
): boolean {
  return requests.some((request) => request.projectId === projectId && request.cursor === cursor);
}

function machineSessionPagesComplete(
  machineProjects: string[], authorizedProjects: string[],
  requests: SessionPageRequest[], pages: (Control["SessionPage"] | undefined)[],
): boolean {
  return authorizedProjects.length > 0 && requests.every((request, index) => {
    if (!machineProjects.includes(request.projectId)) return true;
    const page = pages[index];
    return !!page && (!page.hasMore || hasRequestedSessionPage(requests, request.projectId, page.cursor));
  });
}

export function MachinesView() {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const operator = useOperator();
  const machines = useQuery({
    queryKey: [hub.scopeKey, hub.projectId, "remote", "machines"],
    queryFn: ({ signal }) =>
      remoteGet<{ machines: MachineSummary[] }>(
        "/machines" +
          (hub.projectId
            ? "?projectId=" + encodeURIComponent(hub.projectId)
            : ""),
        signal,
      ),
  });
  useEffect(() => {
    if (hub.location.machineId && machines.data) {
      document.getElementById("machine-" + hub.location.machineId)?.focus();
    }
  }, [hub.location.machineId, machines.data]);
  const projects = useQuery({
    queryKey: [hub.scopeKey, "projects"],
    queryFn: ({ signal }) =>
      getJson<{ projects: Project[] }>("/projects", signal),
  });
  const projectIds = hub.projectId
    ? [hub.projectId]
    : (projects.data?.projects.map((p) => p.id) ?? []);
  const [pages, setPages] = useState<Record<string, number[]>>({});
  const specifications = projectIds.flatMap((projectId) =>
    (pages[projectId] ?? [0]).map((cursor) => ({ projectId, cursor })),
  );
  const sessionQueries = useQueries({
    queries: specifications.map(({ projectId, cursor }) => ({
      queryKey: [
        hub.scopeKey,
        projectId,
        "remote",
        "sessions",
        "machine-cards",
        cursor,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        remoteGet<Control["SessionPage"]>(
          remoteProject(projectId) + "/sessions?after=" + cursor,
          signal,
        ),
    })),
  });
  const sessionMap = new Map<string, Control["SessionRecord"]>();
  sessionQueries.forEach((query) =>
    query.data?.sessions.forEach((session) => {
      const key = session.projectId + ":" + session.sessionId;
      const prior = sessionMap.get(key);
      if (!prior || session.version >= prior.version)
        sessionMap.set(key, session);
    }),
  );
  const sessions = [...sessionMap.values()];
  const [name, setName] = useState("");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const action = useRemoteAction();
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(
      () => setCode(null),
      Math.max(0, Date.parse(code.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [code]);
  async function pair() {
    if (!operator || !hub.projectId || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      const result = await remoteMutate<{ code?: string; expiresAt: string }>(
        "POST",
        "/machines/pairings",
        { displayName: name.trim(), projectIds: [hub.projectId] },
      );
      if (!result.code)
        throw new ApiError(
          409,
          "pairing-secret-already-displayed",
          "Create a new one-use enrollment operation",
        );
      setCode({ code: result.code, expiresAt: result.expiresAt });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  function projectName(id: string) {
    return projects.data?.projects.find((p) => p.id === id)?.name ?? id;
  }
  return (
    <div className="machine-page">
      <PageHeading title={t("machines")} description={t("machineOverview")} />
      <Feedback query={machines} />
      {!hub.projectId && <Feedback query={projects} />}
      {operator && hub.projectId && (
        <details className="machine-setup">
          <summary>{t("newPairing")}</summary>
          <Panel title={t("newPairing")}>
            <Notice>{t("localSetup")}</Notice>
            <Field label={t("machineName")}>
              <Input
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Button
              disabled={!name.trim() || pending}
              onClick={() => void pair()}
            >
              {t("newPairing")}
            </Button>
            <p className="text-sm text-slate-500">{t("pairingHelp")}</p>
            {error != null && (
              <Notice tone="error">{errorMessage(error)}</Notice>
            )}
            {code && (
              <Notice>
                <strong>{t("pairingCode")}</strong>
                <code className="my-3 block break-all select-all">
                  {code.code}
                </code>
                <p>{code.expiresAt}</p>
                <Button variant="secondary" onClick={() => setCode(null)}>
                  {t("dismissCode")}
                </Button>
              </Notice>
            )}
          </Panel>
        </details>
      )}
      {sessionQueries.some((q) => q.isPending) && (
        <p role="status" className="machine-muted">
          {t("loadingSessions")}
        </p>
      )}
      {sessionQueries.map((query, index) =>
        query.error ? (
          <div
            key={
              specifications[index].projectId +
              ":" +
              specifications[index].cursor
            }
          >
            <p className="machine-muted">
              {projectName(specifications[index].projectId)}
            </p>
            <Feedback query={query} />
          </div>
        ) : null,
      )}
      {machines.data?.machines.length === 0 && (
        <EmptyState>{t("empty")}</EmptyState>
      )}
      <div className="machine-grid">
        {machines.data?.machines.map((machine) => (
          <MachineCard
            key={machine.machineId}
            machine={machine}
            sessions={sessions.filter((s) => s.machineId === machine.machineId)}
            projectName={projectName}
            sessionsComplete={machineSessionPagesComplete(
              machine.projectIds, projectIds, specifications,
              sessionQueries.map((query) => query.data),
            )}
            onRevoke={() =>
              action.mutate({
                path:
                  "/machines/" +
                  encodeURIComponent(machine.machineId) +
                  "/revoke",
                body: { expectedVersion: machine.version },
              })
            }
          />
        ))}
      </div>
      <div className="machine-pagination">
        {sessionQueries.map((query, index) => {
          const spec = specifications[index];
          const next = query.data?.cursor;
          return query.data?.hasMore &&
            next !== undefined &&
            !hasRequestedSessionPage(specifications, spec.projectId, next) ? (
            <Button
              key={spec.projectId + ":" + next}
              variant="secondary"
              onClick={() =>
                setPages((previous) => ({
                  ...previous,
                  [spec.projectId]: [
                    ...(previous[spec.projectId] ?? [0]),
                    next,
                  ],
                }))
              }
            >
              {t("more")} · {projectName(spec.projectId)}
            </Button>
          ) : null;
        })}
      </div>
      <ActionFeedback action={action} />
    </div>
  );
}
function MachineCard({
  machine,
  sessions,
  projectName,
  sessionsComplete,
  onRevoke,
}: {
  machine: MachineSummary;
  sessions: Control["SessionRecord"][];
  projectName: (id: string) => string;
  sessionsComplete: boolean;
  onRevoke: () => void;
}) {
  const hub = useHub();
  const { t, i18n } = useTranslation("remote");
  const operator = useOperator();
  const checkouts =
    machine.inventory?.checkouts.filter(
      (c) => !hub.projectId || c.projectId === hub.projectId,
    ) ?? [];
  const busy = sessions.filter((s) => s.state === "busy").length;
  const recovery = sessions.filter(
    (s) => s.state === "recovery-required",
  ).length;
  return (
    <article
      className={
        "machine-card " +
        (hub.location.machineId === machine.machineId ? "is-selected" : "")
      }
      aria-labelledby={"machine-" + machine.machineId}
    >
      <header className="machine-card-header">
        <span className="machine-icon">
          <Monitor size={21} />
        </span>
        <div>
          <h2 tabIndex={-1} id={"machine-" + machine.machineId}>
            {machine.displayName}
          </h2>
          <p className="machine-muted">
            {machine.lastSeenAt
              ? t("lastSeen") +
                ": " +
                formatDate(machine.lastSeenAt, i18n.language)
              : t("notObserved")}
          </p>
        </div>
        <span
          className={
            "machine-status " +
            (machine.connected && !machine.revoked ? "is-online" : "")
          }
        >
          {t(
            machine.revoked
              ? "revoked"
              : machine.connected
                ? "online"
                : "offline",
          )}
        </span>
      </header>
      <div className="machine-projects">
        <FolderOpen size={13} />
        {machine.projectIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => hub.navigate({ projectId: id, tab: "machines" })}
          >
            {projectName(id)}
          </button>
        ))}
      </div>
      {machine.recoveryRequired && <Notice tone="error">{t("unknown")}</Notice>}
      <dl className="machine-metrics">
        <div>
          <dd>
            {sessions.length}
            {!sessionsComplete ? " +" : ""}
          </dd>
          <dt>{t("loadedSessions")}</dt>
        </div>
        <div>
          <dd>{busy}</dd>
          <dt>{t("states.busy")}</dt>
        </div>
        <div>
          <dd>{recovery}</dd>
          <dt>{t("states.recovery-required")}</dt>
        </div>
        <div>
          <dd>{checkouts.length}</dd>
          <dt>{t("checkouts")}</dt>
        </div>
      </dl>
      <ul
        className="machine-session-list"
        aria-label={t("sessions") + " " + machine.displayName}
      >
        {sessions.map((session) => (
          <MachineSessionRow
            key={session.projectId + ":" + session.sessionId}
            session={session}
            machine={machine}
            projectName={projectName(session.projectId)}
          />
        ))}
      </ul>
      {!sessions.length && (
        <p className="machine-empty">
          {t(sessionsComplete ? "noMachineSessions" : "sessionsIncomplete")}
        </p>
      )}
      {checkouts.length > 0 && (
        <details className="machine-checkouts">
          <summary>
            {t("checkouts")} · {checkouts.length}
          </summary>
          {checkouts.map((checkout) => (
            <div
              key={checkout.projectId + ":" + checkout.checkoutId}
              className="machine-checkout"
            >
              <strong>{checkout.label}</strong>
              <span>{projectName(checkout.projectId)}</span>
              <code>{checkout.headSha.slice(0, 12)}</code>
              <span>
                {checkout.clean ? "" : t("dirty")}{" "}
                {checkout.busy ? t("busy") : ""}
              </span>
              {checkout.agentProfiles.map((profile) => (
                <p key={profile.profileId}>
                  {profile.profileId} ·{" "}
                  {t(profile.readiness === "ready" ? "ready" : "setup")}{" "}
                  {profile.reason !== "none" && "· " + profile.reason}
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
      {operator && !machine.revoked && (
        <details className="machine-management">
          <summary>{t("machineAccess")}</summary>
          <Revoke machine={machine} onRevoke={onRevoke} />
        </details>
      )}
    </article>
  );
}
function MachineSessionRow({
  session,
  machine,
  projectName,
}: {
  session: Control["SessionRecord"];
  machine: MachineSummary;
  projectName: string;
}) {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const run = useQuery({
    queryKey: [
      hub.scopeKey,
      session.projectId,
      "remote",
      "run",
      session.activeRunId,
    ],
    queryFn: ({ signal }) =>
      remoteGet<RunRecord>(
        remoteProject(session.projectId) +
          "/runs/" +
          encodeURIComponent(session.activeRunId ?? ""),
        signal,
      ),
    enabled: detailsOpen && !!session.activeRunId,
  });
  const routing = useQuery({
    enabled: detailsOpen,
    queryKey: [
      hub.scopeKey,
      session.projectId,
      "remote",
      "routing",
      session.sessionId,
    ],
    queryFn: ({ signal }) =>
      remoteGet<Control["RoutingAvailability"]>(
        remoteProject(session.projectId) +
          "/sessions/" +
          encodeURIComponent(session.sessionId) +
          "/routing",
        signal,
      ),
  });
  const candidateId = session.config.baselineCandidateId;
  const candidate = routing.data?.candidates.find(
    (item) => item.candidateId === candidateId,
  );
  const modelLabel = candidate
    ? candidate.providerId + " / " + candidate.modelId
    : t("baseline") +
      ": " +
      (candidateId.length > 20 ? candidateId.slice(0, 10) + "…" : candidateId);
  const record = run.data;
  const checkout = machine.inventory?.checkouts.find(
    (c) =>
      c.checkoutId === session.checkoutId && c.projectId === session.projectId,
  );
  const attention =
    record?.state === "waiting-approval" ||
    session.state === "recovery-required";
  return (
    <li className="machine-session">
      <div className="machine-session-title">
        <MessageSquare size={15} />
        <button
          type="button"
          onClick={() =>
            hub.navigate({
              projectId: session.projectId,
              tab: "sessions",
              sessionId: session.sessionId,
              machineId: undefined,
              runId: undefined,
            })
          }
        >
          {session.title}
        </button>
        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-label={t("sessionDetails") + ": " + session.title}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="machine-session-meta">
        <span
          className={
            "machine-session-state " + (attention ? "needs-action" : "")
          }
        >
          {t("states." + (record?.state ?? session.state))}
        </span>
        <span>{session.agentProfileId}</span>
        <span title={t("baseline") + ": " + candidateId}>{modelLabel}</span>
      </div>
      <div className="machine-session-context">
        <button
          type="button"
          onClick={() =>
            hub.navigate({ projectId: session.projectId, tab: "overview" })
          }
        >
          {projectName}
        </button>
        {record?.association.mode === "flow" ? (
          <>
            <span>→</span>
            <button
              type="button"
              title={t("activeRunFlow")}
              onClick={() =>
                hub.navigate({
                  projectId: session.projectId,
                  tab: "flows",
                  flowId:
                    record.association.mode === "flow"
                      ? record.association.flowId
                      : undefined,
                })
              }
            >
              {t("activeRunFlow")}: {record.association.flowId}
            </button>
          </>
        ) : record?.association.mode === "ad-hoc" ? (
          <span>· {t("adHoc")}</span>
        ) : null}
      </div>
      <div className="machine-session-meta">
        <GitBranch size={12} />
        <span>{checkout?.label ?? session.checkoutId}</span>
        <span>
          {session.controller?.state === "held"
            ? t("controller") + ": " + session.controller.actorId
            : t("noController")}
        </span>
      </div>
      {!machine.connected && (
        <p className="machine-stale">{t("lastObservedSession")}</p>
      )}
      {session.activeRunId && run.error && (
        <p className="machine-stale">{t("runDetailsUnavailable")}</p>
      )}
    </li>
  );
}
function Revoke({
  machine,
  onRevoke,
}: {
  machine: MachineSummary;
  onRevoke: () => void;
}) {
  const { t } = useTranslation("remote");
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="space-y-2">
      <label className="flex gap-3 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          aria-label={t("revokeConfirm") + " " + machine.displayName}
        />
        {t("revokeConfirm")}
      </label>
      <Button variant="danger" disabled={!confirmed} onClick={onRevoke}>
        {t("revoke")}
      </Button>
    </div>
  );
}
