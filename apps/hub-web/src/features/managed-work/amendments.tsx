import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import {
  Button,
  Field,
  Input,
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
  Criterion,
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
  can: (c: string) => boolean;
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
  const intents = recordsOf(records, "intent").filter(
    (i) => i.flowId === flow.id,
  );
  const pending = pendingAmendments(records, flow.id);
  const history = recordsOf(records, "amendment").filter(
    (m) => m.flowId === flow.id,
  );
  const terminal = ["accepted", "cancelled"].includes(flow.state);
  const fr = recordOf(records, "flow-revision", flow.currentRevisionId);
  const replacements: AmendmentManifest["replacements"] = [];
  if (flow.approvedRevisionId && fr && fr.id !== flow.approvedRevisionId)
    replacements.push({
      targetType: "flow",
      targetId: flow.id,
      revisionId: fr.id,
      contentDigest: fr.contentDigest,
    });
  for (const intent of intents) {
    const ir = recordOf(records, "intent-revision", intent.currentRevisionId);
    if (ir && ir.id !== intent.approvedRevisionId)
      replacements.push({
        targetType: "intent",
        targetId: intent.id,
        revisionId: ir.id,
        contentDigest: ir.contentDigest,
      });
  }
  const affected = replacements
    .filter((r) => r.targetType === "intent")
    .map((r) => r.targetId);
  const flowChange = replacements.some((r) => r.targetType === "flow");
  const complete =
    affected.length > 0 &&
    intents
      .filter((i) => i.required && affected.includes(i.id))
      .every((i) =>
        (flowChange
          ? fr
          : recordOf(records, "flow-revision", flow.approvedRevisionId)
        )?.requiredIntentIds.includes(i.id),
      ) &&
    (!flowChange ||
      intents
        .filter((i) => i.approvedRevisionId)
        .every((i) => affected.includes(i.id))) &&
    affected.every(
      (id) =>
        recordOf(
          records,
          "intent-revision",
          intents.find((i) => i.id === id)?.currentRevisionId,
        )?.flowRevisionId === (flowChange ? fr?.id : flow.approvedRevisionId),
    );
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
                  {intents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title}
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
                  intents.find((i) => i.id === target)?.currentRevisionId
                }
                adapter={adapter}
                flow={flow}
                intent={intents.find((i) => i.id === target)}
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
                  expectedVersions: {
                    ...aggregateVersions(flow),
                    ...Object.fromEntries(
                      intents
                        .filter((i) => affected.includes(i.id))
                        .map((i) => [i.id, i.version]),
                    ),
                  },
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
            : intents.find((i) => i.id === replacement.targetId);
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
            .filter((i) => manifest.affectedIntentIds.includes(i.id))
            .map((i) => [i.id, i.version]),
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
        manifest.replacements.map((r) => (
          <p key={r.targetId}>
            {r.targetType} ·{" "}
            <code>
              {r.targetId} → {r.revisionId}
            </code>
          </p>
        ))
      )}
      {manifest.replacements.map((replacement) => {
        const r = records.find((r) => r.id === replacement.revisionId);
        return r &&
          (r.kind === "flow-revision" || r.kind === "intent-revision") ? (
          <RevisionReview
            key={r.id}
            adapter={adapter}
            revision={r}
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

function RevisionEditor({
  adapter,
  flow,
  intent,
  records,
  onDone,
}: {
  adapter: WorkAdapter;
  flow: WorkFlow;
  intent?: WorkIntent;
  records: WorkRecord[];
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const fr = recordOf(records, "flow-revision", flow.currentRevisionId);
  const ir = recordOf(records, "intent-revision", intent?.currentRevisionId);
  const target = intent ?? flow;
  const revision = intent ? ir : fr;
  const [draft, setDraft] = useDraft(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      target.id,
      revision?.id,
      "revision-editor",
    ].join(":"),
    {
      problem: fr?.problem ?? "",
      expectedOutcome: fr?.expectedOutcome ?? "",
      scope: fr?.scope ?? "",
      deliverable: ir?.deliverable ?? "",
      approach: ir?.approach ?? "",
      outOfScope: revision?.outOfScope ?? "",
      requiredIntentIds: [...(fr?.requiredIntentIds ?? [])],
      criteria: structuredClone(revision?.criteria ?? []),
      mappings: structuredClone(ir?.criterionMappings ?? []),
    },
  );
  const { run, blocked } = useWorkOperation(adapter, onDone);
  if (!revision || !fr) return null;
  const changeCriterion = (id: string, patch: Partial<Criterion>) =>
    setDraft({
      ...draft,
      criteria: draft.criteria.map((c) =>
        c.criterionId === id ? { ...c, ...patch } : c,
      ),
    });
  const mappedIds = [...new Set(draft.mappings.map((m) => m.flowCriterionId))];
  const validMappings =
    !intent ||
    (draft.criteria.length > 0 &&
      draft.criteria.every((c) =>
        draft.mappings.some((m) => m.intentCriterionId === c.criterionId),
      ) &&
      draft.mappings.every((m) =>
        fr.criteria.some((c) => c.criterionId === m.flowCriterionId),
      ));
  return (
    <form
      className="work-contribution-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          command: "revision.propose",
          expectedVersions: aggregateVersions(flow, intent),
          payload: intent
            ? {
                targetType: "intent",
                intentId: intent.id,
                flowRevisionId: fr.id,
                deliverable: draft.deliverable,
                approach: draft.approach,
                outOfScope: draft.outOfScope,
                criteria: draft.criteria,
                flowCriterionIds: mappedIds,
                criterionMappings: draft.mappings,
              }
            : {
                targetType: "flow",
                flowId: flow.id,
                problem: draft.problem,
                expectedOutcome: draft.expectedOutcome,
                scope: draft.scope,
                outOfScope: draft.outOfScope,
                specification: fr.specification,
                criteria: draft.criteria,
                requiredIntentIds: draft.requiredIntentIds,
              },
        });
      }}
    >
      <div className="work-pin">
        <span>{t("oldPins")}</span>
        <code>{target.approvedRevisionId}</code>
        <span>{t("proposalBase")}</span>
        <code>{revision.id}</code>
      </div>
      {(intent
        ? (["deliverable", "approach", "outOfScope"] as const)
        : (["problem", "expectedOutcome", "scope", "outOfScope"] as const)
      ).map((key) => (
        <Field key={key} label={t(key === "expectedOutcome" ? "outcome" : key)}>
          <Textarea
            required
            maxLength={10000}
            value={draft[key]}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        </Field>
      ))}
      {!intent && (
        <fieldset>
          <legend>{t("requiredIntents")}</legend>
          {recordsOf(records, "intent")
            .filter((i) => i.flowId === flow.id && i.required)
            .map((i) => (
              <label className="work-checkbox" key={i.id}>
                <input
                  type="checkbox"
                  checked={draft.requiredIntentIds.includes(i.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      requiredIntentIds: e.target.checked
                        ? [...draft.requiredIntentIds, i.id]
                        : draft.requiredIntentIds.filter((id) => id !== i.id),
                    })
                  }
                />
                {i.title}
              </label>
            ))}
        </fieldset>
      )}
      <fieldset>
        <legend>{t("criteria")}</legend>
        {draft.criteria.map((criterion) => (
          <div className="work-edit-criterion" key={criterion.criterionId}>
            <code>{criterion.criterionId}</code>
            <Field label={t("criterionText")}>
              <Input
                required
                maxLength={4000}
                value={criterion.text}
                onChange={(e) =>
                  changeCriterion(criterion.criterionId, {
                    text: e.target.value,
                  })
                }
              />
            </Field>
            <label className="work-checkbox">
              <input
                type="checkbox"
                checked={criterion.waivable}
                onChange={(e) =>
                  changeCriterion(criterion.criterionId, {
                    waivable: e.target.checked,
                  })
                }
              />
              {t("allowWaivers")}
            </label>
            {intent && (
              <fieldset>
                <legend>{t("criterionMapping")}</legend>
                {fr.criteria.map((fc) => (
                  <label key={fc.criterionId} className="work-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.mappings.some(
                        (m) =>
                          m.intentCriterionId === criterion.criterionId &&
                          m.flowCriterionId === fc.criterionId,
                      )}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          mappings: e.target.checked
                            ? [
                                ...draft.mappings,
                                {
                                  intentCriterionId: criterion.criterionId,
                                  flowCriterionId: fc.criterionId,
                                },
                              ]
                            : draft.mappings.filter(
                                (m) =>
                                  !(
                                    m.intentCriterionId ===
                                      criterion.criterionId &&
                                    m.flowCriterionId === fc.criterionId
                                  ),
                              ),
                        })
                      }
                    />
                    {fc.text}
                  </label>
                ))}
              </fieldset>
            )}
            <Button
              variant="ghost"
              onClick={() =>
                setDraft({
                  ...draft,
                  criteria: draft.criteria.filter(
                    (c) => c.criterionId !== criterion.criterionId,
                  ),
                  mappings: draft.mappings.filter(
                    (m) => m.intentCriterionId !== criterion.criterionId,
                  ),
                })
              }
            >
              {t("removeCriterion")}
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          onClick={() =>
            setDraft({
              ...draft,
              criteria: [
                ...draft.criteria,
                { criterionId: crypto.randomUUID(), text: "", waivable: false },
              ],
            })
          }
        >
          {t("newCriterion")}
        </Button>
      </fieldset>
      <Button
        type="submit"
        disabled={blocked || !draft.criteria.length || !validMappings}
      >
        {t("propose")}
      </Button>
    </form>
  );
}
