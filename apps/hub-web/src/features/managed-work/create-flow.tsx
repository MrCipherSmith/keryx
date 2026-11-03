import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import {
  Button,
  Field,
  Input,
  Textarea} from "../../components/ui";
import { useDraft } from "../../state/drafts";
import { type WorkAdapter } from "./adapter";
import type { WorkReceipt } from "./types";
import { useWorkOperation} from "./operation";


export function CreateFlow({
  adapter,
  onDone,
  fast = false,
}: {
  adapter: WorkAdapter;
  onDone: (receipt: WorkReceipt) => void;
  fast?: boolean;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [draft, setDraft] = useDraft(
    hub.scopeKey + ":" + hub.projectId + ":work-create",
    {
      title: "",
      problem: "",
      expectedOutcome: "",
      scope: "",
      outOfScope: "",
      criteria: "",
      allowWaivers: false,
    },
  );
  const { blocked, run } = useWorkOperation(adapter, onDone);
  const primary = ["title", "expectedOutcome", "criteria"] as const;
  const advanced = ["problem", "scope", "outOfScope"] as const;
  const renderField = (key: (typeof primary)[number] | (typeof advanced)[number]) => (
    <Field
      key={key}
      label={t(
        {
          title: "flowTitle",
          problem: "problem",
          expectedOutcome: "outcome",
          scope: "scope",
          outOfScope: "outOfScope",
          criteria: "criteriaInput",
        }[key],
      )}
    >
      {key === "title" ? (
        <Input
          required
          maxLength={500}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        />
      ) : (
        <Textarea
          required={!fast || primary.some((field) => field === key)}
          maxLength={key === "criteria" ? 8000 : 10000}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        />
      )}
    </Field>
  );
  const waiverOption = (
    <label className="work-checkbox">
      <input
        type="checkbox"
        checked={draft.allowWaivers}
        onChange={(e) =>
          setDraft({ ...draft, allowWaivers: e.target.checked })
        }
      />{" "}
      {t("allowWaivers")}
    </label>
  );
  return (
    <form
      className="work-create"
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          expectedVersions: {},
          command: "flow.create",
          payload: {
            title: draft.title.trim(),
            problem: draft.problem.trim() || draft.expectedOutcome.trim(),
            expectedOutcome: draft.expectedOutcome.trim(),
            scope: draft.scope.trim() || draft.expectedOutcome.trim(),
            outOfScope: draft.outOfScope.trim() || t("defaultExclusions"),
            ownerId: hub.principal.id,
            specification: null,
            criteria: draft.criteria
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => ({
                criterionId: crypto.randomUUID(),
                text: line.trim(),
                waivable: draft.allowWaivers,
              })),
          },
        });
      }}
    >
      <h2>{t("newFlow")}</h2>
      <p>{t("createHelp")}</p>
      {fast ? (
        <>
          {primary.map(renderField)}
          <details>
            <summary>{t("advancedFlowFields")}</summary>
            {advanced.map(renderField)}
            {waiverOption}
          </details>
        </>
      ) : (
        <>
          {(["title", "problem", "expectedOutcome", "scope", "outOfScope", "criteria"] as const).map(renderField)}
          {waiverOption}
        </>
      )}
      <Button type="submit" disabled={blocked}>
        {t("create")}
      </Button>
    </form>
  );
}
