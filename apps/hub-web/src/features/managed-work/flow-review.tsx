import { ApiError } from "../../api/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import { Button, Field, Notice, Select, Textarea } from "../../components/ui";
import { aggregateVersions, recordOf, recordsOf } from "./model";
import { useWorkOperation } from "./operation";
import type { WorkAdapter } from "./adapter";
import type { WorkFlow, WorkRecord } from "./types";

export function FlowReview({
  adapter,
  flow,
  records,
  can,
  onDone,
}: {
  adapter: WorkAdapter;
  flow: WorkFlow;
  records: WorkRecord[];
  can: (c: string) => boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [reason, setReason] = useDraft(
    [hub.scopeKey, hub.projectId, adapter.mode, flow.id, "flow-review"].join(
      ":",
    ),
    "",
  );
  const { run, blocked } = useWorkOperation(adapter, onDone);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<WorkAdapter["acceptancePreview"]>
  > | null>(null);
  const [previewError, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState("accept");
  const [reading, setReading] = useState(false);
  const intents = recordsOf(records, "intent").filter(
    (i) => i.flowId === flow.id,
  );
  const approvedFlowRevision = recordOf(
    records,
    "flow-revision",
    flow.approvedRevisionId,
  );
  const required = intents.filter((i) =>
    approvedFlowRevision?.requiredIntentIds.includes(i.id),
  );
  const complete =
    required.length > 0 && required.every((i) => i.state === "accepted");
  const submission = recordsOf(records, "flow-submission")
    .filter(
      (s) =>
        s.flowId === flow.id && s.flowRevisionId === flow.approvedRevisionId,
    )
    .at(-1);
  const versions = {
    ...aggregateVersions(flow),
    ...Object.fromEntries(intents.map((i) => [i.id, i.version])),
  };
  if (flow.state === "accepted")
    return (
      <Notice tone="success">
        {t("states.accepted")} · {t("flowComplete")}
      </Notice>
    );
  return (
    <section className="work-flow-review">
      <h2>{t("flowReview")}</h2>
      <p>{t("flowComplete")}</p>
      {flow.state !== "in-review" && (
        <>
          <Button
            variant="secondary"
            disabled={blocked || reading || !complete || !can("flow.submit")}
            onClick={() => {
              setReading(true);
              setError(null);
              void adapter
                .acceptancePreview(flow.id)
                .then(setPreview)
                .catch((error:unknown) => {
                  setPreview(null);
                  setError(error instanceof ApiError?error.code:"unknown");
                })
                .finally(() => setReading(false));
            }}
          >
            {t("submitFlow")}
          </Button>
          {!complete && <p>{t("previewUnavailable")}</p>}
          {previewError && (
            <Notice tone="error">
              {t("previewBlocked")} ({previewError})
            </Notice>
          )}
          {preview && (
            <div className="work-review">
              <code>{preview.acceptanceManifestDigest}</code>
              <p>
                {t("progress", {
                  accepted: required.length,
                  total: required.length,
                })}
              </p>
              <Button
                disabled={
                  blocked || preview.flowRevisionId !== flow.approvedRevisionId
                }
                onClick={() =>
                  void run({
                    command: "flow.submit",
                    expectedVersions: versions,
                    payload: {
                      flowId: flow.id,
                      flowRevisionId: preview.flowRevisionId,
                      acceptedIntentDecisionIds:
                        preview.acceptedIntentDecisionIds,
                      acceptanceManifestDigest:
                        preview.acceptanceManifestDigest,
                    },
                  })
                }
              >
                {t("confirm")}
              </Button>
            </div>
          )}
        </>
      )}
      {flow.state === "in-review" && submission && (
        <form
          className="work-contribution-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run({
              command: "review.decide",
              expectedVersions: versions,
              payload: {
                targetType: "flow-review",
                targetId: flow.id,
                submissionId: submission.id,
                submissionDigest: submission.contentDigest,
                decision,
                reason: reason.trim(),
                waivers: [],
              },
            });
          }}
        >
          <code>{submission.contentDigest}</code>
          <ul>
            {submission.acceptedIntents.map((entry) => (
              <li key={entry.intentId}>
                {recordOf(records, "intent", entry.intentId)?.title ??
                  entry.intentId}{" "}
                · <code>{entry.subjectDigest}</code>
              </li>
            ))}
          </ul>
          <Field label={t("decision")}>
            <Select
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
            >
              {["accept", "request-changes", "reject"].map((d) => (
                <option key={d} value={d}>
                  {t(
                    d === "accept"
                      ? "accept"
                      : d === "request-changes"
                        ? "requestChanges"
                        : "reject",
                  )}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("reason")}>
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
              hub.principal.kind !== "human" ||
              !can("review.decide") ||
              !reason.trim()
            }
          >
            {t("confirm")}
          </Button>
        </form>
      )}
    </section>
  );
}
