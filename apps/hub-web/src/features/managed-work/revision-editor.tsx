import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import {
  Button,
  Field,
  Input,
  Textarea,
} from "../../components/ui";
import {
  aggregateVersions,
  recordOf,
  recordsOf,
} from "./model";
import { useWorkOperation } from "./operation";
import type { WorkAdapter } from "./adapter";
import type {
  Criterion,
  WorkFlow,
  WorkIntent,
  WorkRecord,
} from "./types";

export function RevisionEditor({
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
  const flowRevision = recordOf(records, "flow-revision", flow.currentRevisionId);
  const intentRevision = recordOf(records, "intent-revision", intent?.currentRevisionId);
  const target = intent ?? flow;
  const revision = intent ? intentRevision : flowRevision;
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
      problem: flowRevision?.problem ?? "",
      expectedOutcome: flowRevision?.expectedOutcome ?? "",
      scope: flowRevision?.scope ?? "",
      deliverable: intentRevision?.deliverable ?? "",
      approach: intentRevision?.approach ?? "",
      outOfScope: revision?.outOfScope ?? "",
      requiredIntentIds: [...(flowRevision?.requiredIntentIds ?? [])],
      criteria: structuredClone(revision?.criteria ?? []),
      mappings: structuredClone(intentRevision?.criterionMappings ?? []),
    },
  );
  const { run, blocked } = useWorkOperation(adapter, onDone);
  if (!revision || !flowRevision) return null;
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
        flowRevision.criteria.some((c) => c.criterionId === m.flowCriterionId),
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
                flowRevisionId: flowRevision.id,
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
                specification: flowRevision.specification,
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
                {flowRevision.criteria.map((fc) => (
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
