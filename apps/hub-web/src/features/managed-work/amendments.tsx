import { RevisionEditor } from "./revision-editor";
import { amendmentDraft } from "./amendment-model";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import {
  Button,
  Field,
  Notice,
  Select,
  Textarea,
} from "../../components/ui";
import {
  aggregateVersions,
  pendingAmendments,
  recordOf,
  recordsOf,
} from "./model";
import { RevisionReview } from "./revision-review";
import { useWorkOperation } from "./operation";
import type { WorkAdapter } from "./adapter";
import type {
  AmendmentManifest,
  WorkFlow,
  WorkIntent,
  WorkRecord,
} from "./types";

export function AmendmentsPanel({
  adapter,
  flow,
  records,
  can,
  onDone,
}: {
  adapter: WorkAdapter;
  flow: WorkFlow;
  records: WorkRecord[];
  can: (command: string) => boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const human = hub.principal.kind === "human";
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState("flow");
  const { run, blocked } = useWorkOperation(adapter, onDone);
  const [reason, setReason] = useDraft(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      flow.id,
      "amend-authorize",
    ].join(":"),
    "",
  );
  const { intents, replacements, affected, complete, expectedVersions } = amendmentDraft(records, flow);
  const pending = pendingAmendments(records, flow.id);
  const history = recordsOf(records, "amendment").filter((manifest) => manifest.flowId === flow.id);
  const terminal = ["accepted", "cancelled"].includes(flow.state);
  if (!flow.approvedRevisionId && !history.length) return null;
  return (
    <section className="work-amendments">
      <h2>{t("amendments")}</h2>
      <p>{t("amendmentHelp")}</p>
      {!terminal && !pending.length && can("revision.propose") && (
        <>
          <div className="work-actions">
            <Button
              variant="secondary"
              disabled={blocked}
              onClick={() => setEditing(!editing)}
            >
              {t("proposeRevision")}
            </Button>
          </div>
          {editing && (
            <>
              <Field label={t("proposalTarget")}>
                <Select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="flow">{flow.title}</option>
                  {intents.map((intent) => (
                    <option key={intent.id} value={intent.id}>
                      {intent.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <RevisionEditor
                key={
                  target +
                  ":" +
                  flow.currentRevisionId +
                  ":" +
                  intents.find((intent) => intent.id === target)?.currentRevisionId
                }
                adapter={adapter}
                flow={flow}
                intent={intents.find((intent) => intent.id === target)}
                records={records}
                onDone={() => {
                  setEditing(false);
                  onDone();
                }}
              />
            </>
          )}
          {replacements.length > 0 && (
            <form
              className="work-contribution-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run({
                  command: "requirements.amend",
                  expectedVersions,
                  payload: {
                    flowId: flow.id,
                    sourceFlowRevisionId: flow.approvedRevisionId,
                    affectedIntentIds: affected,
                    replacements,
                    reason: reason.trim(),
                  },
                });
              }}
            >
              <h3>{t("authorizeAmendment")}</h3>
              <PinTable
                flow={flow}
                intents={intents}
                replacements={replacements}
                records={records}
              />
              {!complete && <Notice>{t("incompleteSet")}</Notice>}
              <Field label={t("amendReason")}>
                <Textarea
                  required
                  maxLength={4000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                disabled={
                  blocked ||
                  !human ||
                  !can("requirements.amend") ||
                  !complete ||
                  !reason.trim()
                }
              >
                {t("authorizeAmendment")}
              </Button>
            </form>
          )}
        </>
      )}
      {history.map((manifest) => (
        <AmendmentDecision
          key={manifest.id}
          adapter={adapter}
          flow={flow}
          intents={intents}
          records={records}
          manifest={manifest}
          pending={pending.some((p) => p.id === manifest.id)}
          canResolve={
            human && can("requirements.resolve-amendment") && !terminal
          }
          onDone={onDone}
        />
      ))}
    </section>
  );
}

function PinTable({
  flow,
  intents,
  replacements,
  records,
}: {
  flow: WorkFlow;
  intents: WorkIntent[];
  replacements: AmendmentManifest["replacements"];
  records: WorkRecord[];
}) {
  const { t } = useTranslation("work");
  return (
    <div className="work-pin-table">
      {replacements.map((replacement) => {
        const target =
          replacement.targetType === "flow"
            ? flow
            : intents.find((intent) => intent.id === replacement.targetId);
        const approved = target?.approvedRevisionId;
        return (
          <article key={replacement.targetId}>
            <strong>{target?.title ?? replacement.targetId}</strong>
            <div>
              <span>{t("oldPins")}</span>
              <code>{approved ?? "—"}</code>
            </div>
            <div>
              <span>{t("newPins")}</span>
              <code>{replacement.revisionId}</code>
              <code>{replacement.contentDigest}</code>
            </div>
            {replacement.targetType === "intent" && (
              <small>
                {t("revision")}:{" "}
                {
                  recordOf(records, "intent-revision", replacement.revisionId)
                    ?.flowRevisionId
                }
              </small>
            )}
          </article>
        );
      })}
    </div>
  );
}

function AmendmentDecision({
  adapter,
  flow,
  intents,
  records,
  manifest,
  pending,
  canResolve,
  onDone,
}: {
  adapter: WorkAdapter;
  flow: WorkFlow;
  intents: WorkIntent[];
  records: WorkRecord[];
  manifest: AmendmentManifest;
  pending: boolean;
  canResolve: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const { run, blocked } = useWorkOperation(adapter, onDone);
  const [reason, setReason] = useDraft(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      manifest.id,
      "amend-resolve",
    ].join(":"),
    "",
  );
  const decisions = recordsOf(records, "decision").filter(
    (d) => d.targetType === "amendment" && d.targetId === manifest.id,
  );
  const decide = (decision: "approve" | "withdraw") =>
    void run({
      command: "requirements.resolve-amendment",
      expectedVersions: {
        ...aggregateVersions(flow),
        ...Object.fromEntries(
          intents
            .filter((intent) => manifest.affectedIntentIds.includes(intent.id))
            .map((intent) => [intent.id, intent.version]),
        ),
      },
      payload: {
        amendmentId: manifest.id,
        manifestDigest: manifest.contentDigest,
        decision,
        reason: reason.trim(),
      },
    });
  return (
    <details className="work-amendment" open={pending}>
      <summary>
        <strong>{t(pending ? "pendingSet" : "resolvedSet")}</strong>
        <code>{manifest.id}</code>
      </summary>
      <p>{manifest.reason}</p>
      <div className="work-pin">
        <span>{t("oldPins")} Flow</span>
        <code>{manifest.sourceFlowRevisionId}</code>
      </div>
      <code>{manifest.contentDigest}</code>
      {pending ? (
        <PinTable
          flow={flow}
          intents={intents}
          replacements={manifest.replacements}
          records={records}
        />
      ) : (
        manifest.replacements.map((replacement) => (
          <p key={replacement.targetId}>
            {replacement.targetType} ·{" "}
            <code>
              {replacement.targetId} → {replacement.revisionId}
            </code>
          </p>
        ))
      )}
      {manifest.replacements.map((replacement) => {
        const revision = records.find((record) => record.id === replacement.revisionId);
        return revision &&
          (revision.kind === "flow-revision" || revision.kind === "intent-revision") ? (
          <RevisionReview
            key={revision.id}
            adapter={adapter}
            revision={revision}
            records={records}
            expanded={pending}
          />
        ) : null;
      })}
      {pending ? (
        <>
          <Notice>{t("pendingAmendment")}</Notice>
          <Field label={t("reason")}>
            <Textarea
              required
              maxLength={4000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="work-actions">
            <Button
              disabled={blocked || !canResolve || !reason.trim()}
              onClick={() => decide("approve")}
            >
              {t("approveSet")}
            </Button>
            <Button
              variant="secondary"
              disabled={blocked || !canResolve || !reason.trim()}
              onClick={() => decide("withdraw")}
            >
              {t("withdrawSet")}
            </Button>
          </div>
        </>
      ) : (
        decisions.map((d) => (
          <p key={d.id}>
            {t("states." + d.decision)} · {d.createdBy} · {d.reason}
          </p>
        ))
      )}
    </details>
  );
}
