import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { remoteGet } from "../../api/remote";
import { formatDate } from "../../i18n/format";
import { Markdown } from "../../components/Markdown";
import { SessionWorkspace, useWorkspaceCopy } from "./session-workspace";
import { useTranslation } from "react-i18next";
import type { MachineSummary } from "../../../../../src/remote-control/protocol";
import type { Control } from "../../api/remote";
import { remoteProject } from "../../api/remote";
import {
  sessionPath,
  useRemoteAction,
  useRemoteQuery,
} from "../../api/remote-hooks";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeading,
  Panel,
  Select,
} from "../../components/ui";
import {
  ActionFeedback,
  Definition,
  Feedback,
  useController,
  useOperator,
} from "./shared";
import { MessageComposer, QueueControls } from "./work";
import { ForkSession } from "./fork";
import { Settings, Commands } from "./settings";
export function SessionsView() {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const [create, setCreate] = useState(false);
  const sessions = useRemoteQuery<Control["SessionPage"]>(
    ["sessions"],
    remoteProject(hub.projectId ?? "") + "/sessions",
  );
  if (hub.location.sessionId)
    return (
      <SessionDetail
        key={hub.projectId + ":" + hub.location.sessionId}
        sessionId={hub.location.sessionId}
      />
    );
  return (
    <div className="space-y-5">
      <PageHeading
        title={t("sessions")}
        description={t("description")}
        action={
          <Button onClick={() => setCreate(!create)}>{t("newSession")}</Button>
        }
      />
      {create && <CreateSession />}
      <Feedback query={sessions} />
      {sessions.data?.sessions.length === 0 && (
        <EmptyState>{t("empty")}</EmptyState>
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {sessions.data?.sessions.map((s) => (
          <Panel
            key={s.sessionId}
            title={s.title}
            description={t("states." + s.state, { defaultValue: s.state })}
          >
            <dl className="space-y-3">
              <Definition label={t("machine")}>{s.machineId}</Definition>
              <Definition label={t("checkout")}>{s.checkoutId}</Definition>
              <Definition label={t("controller")}>
                {s.controller?.actorId ?? "—"}
              </Definition>
            </dl>
            <Button
              variant="secondary"
              onClick={() =>
                hub.navigate({ tab: "sessions", sessionId: s.sessionId })
              }
            >
              {t("details")}
            </Button>
          </Panel>
        ))}
      </div>
    </div>
  );
}
function CreateSession() {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const operator = useOperator();
  const machines = useRemoteQuery<{ machines: MachineSummary[] }>(
    ["machines"],
    "/machines?projectId=" + encodeURIComponent(hub.projectId ?? ""),
  );
  const action = useRemoteAction<Control["SessionOperationReceipt"]>();
  const [draft, setDraft] = useDraft(
    `remote-create:${hub.scopeKey}:${hub.projectId}`,
    { machineId: "", checkoutId: "", profileId: "", title: "" },
  );
  const m = machines.data?.machines.find(
    (m) => m.machineId === draft.machineId,
  );
  const c = m?.inventory?.checkouts.find(
    (c) => c.projectId === hub.projectId && c.checkoutId === draft.checkoutId,
  );
  const profile = c?.agentProfiles.find((p) => p.profileId === draft.profileId);
  const ready =
    operator &&
    m?.connected &&
    !m.revoked &&
    !m.recoveryRequired &&
    c?.available &&
    c.clean &&
    !c.busy &&
    profile?.adapter === "keryx-native-v1" &&
    profile.readiness === "ready" &&
    !!draft.title.trim();
  function submit() {
    if (!ready || !m?.inventory || !c || !profile || !hub.projectId) return;
    action.mutate(
      {
        path: remoteProject(hub.projectId) + "/sessions",
        body: {
          machineId: m.machineId,
          checkoutId: c.checkoutId,
          agentProfileId: profile.profileId,
          expectedInventoryVersion: m.inventory.inventoryVersion,
          expectedHeadSha: c.headSha,
          capabilityDigest: profile.capabilityDigest,
          policyDigest: profile.policyDigest,
          title: draft.title.trim(),
        } satisfies Control["SessionCreate"],
      },
      {
        onSuccess: (receipt) =>
          hub.navigate({ tab: "sessions", sessionId: receipt.sessionId }),
      },
    );
  }
  return (
    <Panel title={t("newSession")}>
      <Field label={t("machine")}>
        <Select
          value={draft.machineId}
          onChange={(e) =>
            setDraft({
              ...draft,
              machineId: e.target.value,
              checkoutId: "",
              profileId: "",
            })
          }
        >
          <option value="">{t("choose")}</option>
          {machines.data?.machines.map((m) => (
            <option
              key={m.machineId}
              value={m.machineId}
              disabled={!m.connected || m.revoked || m.recoveryRequired}
            >
              {m.displayName} · {t(m.connected ? "online" : "offline")}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("checkout")}>
        <Select
          value={draft.checkoutId}
          onChange={(e) =>
            setDraft({ ...draft, checkoutId: e.target.value, profileId: "" })
          }
        >
          <option value="">{t("choose")}</option>
          {m?.inventory?.checkouts
            .filter((c) => c.projectId === hub.projectId)
            .map((c) => (
              <option
                key={c.checkoutId}
                value={c.checkoutId}
                disabled={!c.available || !c.clean || c.busy}
              >
                {c.label} · {c.clean ? "" : t("dirty")}{" "}
                {c.busy ? t("busy") : ""}
              </option>
            ))}
        </Select>
      </Field>
      <Field label={t("profile")}>
        <Select
          value={draft.profileId}
          onChange={(e) => setDraft({ ...draft, profileId: e.target.value })}
        >
          <option value="">{t("choose")}</option>
          {c?.agentProfiles.map((p) => (
            <option
              key={p.profileId}
              value={p.profileId}
              disabled={
                p.adapter !== "keryx-native-v1" || p.readiness !== "ready"
              }
            >
              {p.profileId} · {p.readiness} · {p.reason}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("title")}>
        <Input
          value={draft.title}
          maxLength={200}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </Field>
      {c && (
        <dl className="space-y-2">
          <Definition label={t("head")}>{c.headSha}</Definition>
          <Definition label={t("policy")}>
            {profile?.policyDigest ?? "—"}
          </Definition>
          <Definition label={t("capability")}>
            {profile?.capabilityDigest ?? "—"}
          </Definition>
        </dl>
      )}
      <Feedback query={machines} />
      <ActionFeedback action={action} />
      <Button disabled={!ready || action.isPending} onClick={submit}>
        {t("createSession")}
      </Button>
    </Panel>
  );
}
export function SessionDetail({ sessionId }: { sessionId: string }) {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const query = useRemoteQuery<Control["SessionRecord"]>(
    ["session", sessionId],
    sessionPath(hub.projectId ?? "", sessionId),
  );
  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        onClick={() => hub.navigate({ sessionId: undefined })}
      >
        ← {t("back")}
      </Button>
      <Feedback query={query} />
      {query.data && <SessionSurface record={query.data} />}
    </div>
  );
}
export function SessionSurface({
  record,
}: {
  record: Control["SessionRecord"];
}) {
  const { t } = useTranslation("remote");
  const control = useController(record);
  const action = useRemoteAction();
  const path = sessionPath(record.projectId, record.sessionId);
  return (
    <SessionWorkspace
      record={record}
      control={control}
      history={<History record={record} />}
      composer={<MessageComposer record={record} control={control} />}
      queue={<QueueControls record={record} control={control} />}
      settings={
        <>
          <Settings record={record} control={control} />
          <Commands record={record} control={control} />
        </>
      }
      operations={
        <>
          {" "}
          <Panel title={t("versions")}>
            <dl className="grid grid-cols-2 gap-3">
              <Definition label={t("sessionVersion")}>
                {record.version}
              </Definition>
              <Definition label={t("configVersion")}>
                {record.config.configVersion}
              </Definition>
              <Definition label={t("historyVersion")}>
                {record.historyVersion}
              </Definition>
              <Definition label={t("queueVersion")}>
                {record.queueVersion}
              </Definition>
            </dl>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={
                  !control.active || action.isPending || record.state === "busy"
                }
                onClick={() =>
                  control.binding &&
                  action.mutate({
                    path: path + "/resume",
                    body: {
                      expectedSessionVersion: record.version,
                      controller: control.binding,
                      expectedHistoryVersion: record.historyVersion,
                      expectedWorkspaceBaseline: record.workspaceBaseline,
                    } satisfies Control["SessionResume"],
                  })
                }
              >
                {t("resume")}
              </Button>
              <Button
                variant="secondary"
                disabled={!control.active || action.isPending}
                onClick={() =>
                  control.binding &&
                  action.mutate({
                    path: path + "/close",
                    body: {
                      expectedSessionVersion: record.version,
                      controller: control.binding,
                      mode: "when-idle",
                    } satisfies Control["SessionClose"],
                  })
                }
              >
                {t("close")}
              </Button>
            </div>
            <ActionFeedback action={action} />
          </Panel>
          <ForkSession record={record} control={control} />
        </>
      }
    />
  );
}

function History({ record }: { record: Control["SessionRecord"] }) {
  const { t, i18n } = useTranslation("remote");
  const hub = useHub();
  const words = useWorkspaceCopy();
  const query = useInfiniteQuery({
    queryKey: [
      hub.scopeKey,
      record.projectId,
      "remote",
      "history",
      record.sessionId,
      "workspace",
    ],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      remoteGet<Control["HistoryPage"]>(
        sessionPath(record.projectId, record.sessionId) +
          "/history?after=" +
          pageParam,
        signal,
      ),
    getNextPageParam: (page) => (page.hasMore ? page.cursor : undefined),
  });
  const messages = new Map<string, Control["SessionMessage"]>();
  query.data?.pages.forEach((page) =>
    page.messages.forEach((message) =>
      messages.set(message.messageId, message),
    ),
  );
  const ordered = [...messages.values()].sort(
    (a, b) => a.historyCursor - b.historyCursor,
  );
  return (
    <section className="session-transcript" aria-label={t("history")}>
      <header className="session-transcript-header">
        <h2>{t("history")}</h2>
        <span>{record.agentProfileId}</span>
      </header>
      <div className="session-transcript-body">
        <Feedback query={query} />
        {query.data?.pages.some((page) => page.gap) && (
          <Notice>{t("gap")}</Notice>
        )}
        <ol>
          {ordered.map((message) => (
            <li
              key={message.messageId}
              className={"session-message " + message.role}
            >
              <span className="session-avatar" aria-hidden="true">
                {message.role === "human"
                  ? "H"
                  : message.role === "assistant"
                    ? "K"
                    : "↳"}
              </span>
              <div>
                <div className="session-message-header">
                  <strong>{words.role[message.role]}</strong>
                  <time dateTime={message.createdAt}>
                    {formatDate(message.createdAt, i18n.language)}
                  </time>
                </div>
                <div className="session-message-content">
                  {message.role === "assistant" ? (
                    <Markdown content={message.text} />
                  ) : (
                    <pre>{message.text}</pre>
                  )}
                </div>
                {message.role === "assistant" && message.runId && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      hub.navigate({
                        tab: "runs",
                        runId: message.runId ?? undefined,
                        sessionId: undefined,
                      })
                    }
                  >
                    {i18n.language.startsWith("ru")
                      ? "Открыть запуск"
                      : "Open run"}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
        {query.data && !ordered.length && <EmptyState>{t("empty")}</EmptyState>}
      </div>
      {query.hasNextPage && (
        <footer className="session-history-pages">
          <Button
            variant="secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t("more")}
          </Button>
        </footer>
      )}
    </section>
  );
}
