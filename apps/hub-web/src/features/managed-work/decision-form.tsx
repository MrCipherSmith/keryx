import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import {
  Button,
  Field,
  Textarea} from "../../components/ui";
import { useDraft } from "../../state/drafts";
import { type WorkAdapter } from "./adapter";
import { useWorkOperation} from "./operation";

import type { PreparedAction } from "./work-types";

export function DecisionForm({
  adapter,
  action,
  onCancel,
  onDone,
}: {
  adapter: WorkAdapter;
  action: PreparedAction;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [reason, setReason] = useDraft(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      action.command,
      JSON.stringify(action.payload),
      "work-reason",
    ].join(":"),
    "",
  );
  const [waivers, setWaivers] = useDraft<Record<string, string>>(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      action.command,
      JSON.stringify(action.payload),
      "work-waivers",
    ].join(":"),
    {},
  );
  const waiverCriteria = action.waiverCriteria ?? [];
  const completeWaivers = waiverCriteria.every(
    (c) =>
      typeof waivers[c.criterionId] === "string" &&
      waivers[c.criterionId].trim().length > 0,
  );
  const { blocked, run } = useWorkOperation(adapter, onDone);
  return (
    <form
      className="work-decision-form"
      aria-label={action.title}
      onSubmit={(e) => {
        e.preventDefault();
        if (action.scopeFlowId !== hub.location.flowId) return;
        void run({
          command: action.command,
          expectedVersions: action.expectedVersions,
          payload: {
            ...action.payload,
            ...(action.command === "review.decide" &&
            action.payload.decision === "accept"
              ? {
                  waivers: waiverCriteria.map((c) => ({
                    criterionId: c.criterionId,
                    reason: waivers[c.criterionId]?.trim() ?? "",
                  })),
                }
              : {}),
            ...(action.command === "flow.start"
              ? {}
              : { reason: reason.trim() }),
          },
        });
      }}
    >
      <h2>{action.title}</h2>
      <p>{action.help}</p>
      {typeof action.payload.submissionDigest === "string" && (
        <code>{action.payload.submissionDigest}</code>
      )}
      {typeof action.payload.revisionDigest === "string" && (
        <code>{action.payload.revisionDigest}</code>
      )}
      {action.command !== "flow.start" && (
        <Field label={t("reason")}>
          <Textarea
            autoFocus
            value={reason}
            maxLength={4000}
            required
            disabled={blocked}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
      {waiverCriteria.length > 0 && (
        <fieldset className="work-waivers">
          <legend>{t("waiver")}</legend>
          <p>{t("waiverHelp")}</p>
          {waiverCriteria.map((criterion) => (
            <div key={criterion.criterionId}>
              <label>
                <input
                  type="checkbox"
                  checked={criterion.criterionId in waivers}
                  disabled={blocked}
                  onChange={(e) => {
                    const next = { ...waivers };
                    if (e.target.checked) next[criterion.criterionId] = "";
                    else delete next[criterion.criterionId];
                    setWaivers(next);
                  }}
                />{" "}
                {criterion.text}
              </label>
              {criterion.criterionId in waivers && (
                <Field label={t("waiverReason") + " · " + criterion.text}>
                  <Textarea
                    required
                    maxLength={4000}
                    disabled={blocked}
                    value={waivers[criterion.criterionId]}
                    onChange={(e) =>
                      setWaivers({
                        ...waivers,
                        [criterion.criterionId]: e.target.value,
                      })
                    }
                  />
                </Field>
              )}
            </div>
          ))}
        </fieldset>
      )}
      <div className="work-actions">
        <Button
          type="submit"
          disabled={
            blocked ||
            !completeWaivers ||
            (action.command !== "flow.start" && !reason.trim())
          }
        >
          {t("confirm")}
        </Button>
        <Button variant="secondary" disabled={blocked} onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
