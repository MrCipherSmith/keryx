import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import { Button, Field, Input, Select, Textarea } from "../../components/ui";
import type { WorkAdapter } from "./adapter";
import type { Attempt, WorkFlow, WorkIntent, WorkRecord } from "./types";
import { aggregateVersions, recordOf, recordsOf } from "./model";
import { useWorkOperation } from "./operation";

type FormKind =
  | "intent"
  | "context"
  | "attempt"
  | "result"
  | "evidence"
  | "progress";
export function ContributionPanel({
  adapter,
  records,
  flow,
  intent,
  attempt,
  can,
  onDone,
}: {
  adapter: WorkAdapter;
  records: WorkRecord[];
  flow: WorkFlow;
  intent?: WorkIntent;
  attempt?: Attempt;
  can: (c: string) => boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const [form, setForm] = useState<FormKind | null>(null);
  const { run, blocked } = useWorkOperation(adapter, onDone);
  const fr = recordOf(records, "flow-revision", flow.currentRevisionId);
  const ir = recordOf(records, "intent-revision", intent?.currentRevisionId);
  const children = recordsOf(records, "intent").filter(
    (i) => i.flowId === flow.id,
  );
  const required = children.filter((i) => i.required).map((i) => i.id);
  const requiredSetMatches =
    fr &&
    required.length === fr.requiredIntentIds.length &&
    required.every((id) => fr.requiredIntentIds.includes(id));
  const context = recordOf(records, "context", attempt?.contextSnapshotId);
  const editable =
    attempt && ["draft", "running", "blocked"].includes(attempt.state);
  const current =
    !["accepted", "cancelled"].includes(flow.state) &&
    !["accepted", "cancelled"].includes(intent?.state ?? "") &&
    intent?.approvedRevisionId === ir?.id &&
    flow.approvedRevisionId === fr?.id &&
    !!ir &&
    ir.flowRevisionId === fr?.id;
  if (
    !(
      (flow.state === "draft" &&
        (can("intent.create") || can("revision.propose"))) ||
      (ir &&
        !intent?.approvedRevisionId &&
        ir.flowRevisionId !== fr?.id &&
        can("revision.propose")) ||
      (current && (can("context.create") || can("attempt.create"))) ||
      (editable &&
        [
          "subject.create",
          "evidence.record",
          "attempt.report",
          "attempt.start",
        ].some(can))
    )
  )
    return null;
  return (
    <section className="work-contribution">
      <h2>{t("contribute")}</h2>
      {flow.state === "draft" && <p>{t("planHelp")}</p>}
      <div className="work-actions">
        {flow.state === "draft" && can("intent.create") && (
          <Button
            variant="secondary"
            disabled={blocked}
            onClick={() => setForm("intent")}
          >
            {t("addIntent")}
          </Button>
        )}
        {flow.state === "draft" &&
          !requiredSetMatches &&
          fr &&
          can("revision.propose") && (
            <Button
              variant="secondary"
              disabled={blocked}
              onClick={() =>
                void run({
                  command: "revision.propose",
                  expectedVersions: aggregateVersions(flow),
                  payload: {
                    targetType: "flow",
                    flowId: flow.id,
                    problem: fr.problem,
                    expectedOutcome: fr.expectedOutcome,
                    scope: fr.scope,
                    outOfScope: fr.outOfScope,
                    specification: fr.specification,
                    criteria: fr.criteria,
                    requiredIntentIds: required,
                  },
                })
              }
            >
              {t("freeze")}
            </Button>
          )}
        {ir &&
          intent &&
          ir.flowRevisionId !== fr?.id &&
          can("revision.propose") &&
          !intent.approvedRevisionId && (
            <Button
              variant="secondary"
              disabled={blocked}
              onClick={() =>
                void run({
                  command: "revision.propose",
                  expectedVersions: aggregateVersions(flow, intent),
                  payload: {
                    targetType: "intent",
                    intentId: intent.id,
                    flowRevisionId: fr!.id,
                    deliverable: ir.deliverable,
                    approach: ir.approach,
                    outOfScope: ir.outOfScope,
                    criteria: ir.criteria,
                    flowCriterionIds: ir.flowCriterionIds,
                    criterionMappings: ir.criterionMappings,
                  },
                })
              }
            >
              {t("align")}
            </Button>
          )}
        {current && can("context.create") && (
          <Button
            variant="secondary"
            disabled={blocked}
            onClick={() => setForm("context")}
          >
            {t("createContext")}
          </Button>
        )}
        {current && can("attempt.create") && (
          <Button
            variant="secondary"
            disabled={blocked}
            onClick={() => setForm("attempt")}
          >
            {t("newAttempt")}
          </Button>
        )}
        {editable && can("subject.create") && (
          <Button
            variant="secondary"
            disabled={blocked}
            onClick={() => setForm("result")}
          >
            {t("addResult")}
          </Button>
        )}
        {editable && can("evidence.record") && (
          <Button
            variant="secondary"
            disabled={blocked}
            onClick={() => setForm("evidence")}
          >
            {t("addEvidence")}
          </Button>
        )}
        {editable && can("attempt.report") && (
          <Button
            variant="secondary"
            disabled={blocked}
            onClick={() => setForm("progress")}
          >
            {t("reportProgress")}
          </Button>
        )}
        {attempt?.state === "draft" &&
          context &&
          fr &&
          ir &&
          can("attempt.start") && (
            <Button
              variant="secondary"
              disabled={blocked || !current}
              onClick={() =>
                void run({
                  command: "attempt.start",
                  expectedVersions: aggregateVersions(flow, intent, attempt),
                  payload: {
                    attemptId: attempt.id,
                    flowRevisionDigest: fr.contentDigest,
                    intentRevisionDigest: ir.contentDigest,
                    contextDigest: context.contentDigest,
                  },
                })
              }
            >
              {t("startAttempt")}
            </Button>
          )}
      </div>
      {form && (
        <ContributionForm
          key={form + ":" + flow.id + ":" + intent?.id + ":" + attempt?.id}
          kind={form}
          adapter={adapter}
          records={records}
          flow={flow}
          intent={intent}
          attempt={attempt}
          onDone={() => {
            setForm(null);
            onDone();
          }}
          onCancel={() => setForm(null)}
        />
      )}
    </section>
  );
}
function ContributionForm({
  kind,
  adapter,
  records,
  flow,
  intent,
  attempt,
  onDone,
  onCancel,
}: {
  kind: FormKind;
  adapter: WorkAdapter;
  records: WorkRecord[];
  flow: WorkFlow;
  intent?: WorkIntent;
  attempt?: Attempt;
  onDone: () => void;
  onCancel: () => void;
}) {
  const hub = useHub();
  const { t } = useTranslation("work");
  const [draft, setDraft] = useDraft<Record<string, string>>(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      flow.id,
      intent?.id,
      attempt?.id,
      kind,
    ].join(":"),
    {},
  );
  const { run, blocked } = useWorkOperation(adapter, onDone);
  const fr = recordOf(records, "flow-revision", flow.currentRevisionId);
  const ir = recordOf(records, "intent-revision", intent?.currentRevisionId);
  const contexts = recordsOf(records, "context").filter(
    (c) => c.intentRevisionId === ir?.id && c.flowRevisionId === fr?.id,
  );
  const subjects = recordsOf(records, "subject").filter(
    (s) => s.attemptId === attempt?.id,
  );
  const field = (
    name: string,
    label: string,
    multiline = false,
    pattern?: string,
  ) => (
    <Field key={name} label={t(label)}>
      {multiline ? (
        <Textarea
          required
          maxLength={8000}
          value={draft[name] ?? ""}
          onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
        />
      ) : (
        <Input
          required
          maxLength={
            name === "commit" ? 64 : name === "documentDigest" ? 64 : 500
          }
          pattern={pattern}
          value={draft[name] ?? ""}
          onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
        />
      )}
    </Field>
  );
  const choice = (
    name: string,
    label: string,
    values: { id: string; label: string }[],
  ) => (
    <Field key={name} label={t(label)}>
      <Select
        required
        value={draft[name] ?? values[0]?.id ?? ""}
        onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
      >
        {values.map((v) => (
          <option value={v.id} key={v.id}>
            {v.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  const send = async () => {
    const expectedVersions = aggregateVersions(flow, intent, attempt);
    if (kind === "intent" && fr) {
      const flowCriterionId = draft.criterion ?? fr.criteria[0]?.criterionId;
      if (!flowCriterionId) return;
      const criteria = (draft.criteria ?? "")
        .split("\n")
        .filter((s) => s.trim())
        .map((text) => ({
          criterionId: crypto.randomUUID(),
          text: text.trim(),
          waivable: false,
        }));
      await run({
        command: "intent.create",
        expectedVersions,
        payload: {
          flowId: flow.id,
          title: draft.title,
          deliverable: draft.deliverable,
          approach: draft.approach,
          outOfScope: draft.outOfScope,
          ownerId: hub.principal.id,
          required: draft.required !== "false",
          criteria,
          flowCriterionIds: [flowCriterionId],
          criterionMappings: criteria.map((c) => ({
            intentCriterionId: c.criterionId,
            flowCriterionId,
          })),
        },
      });
    } else if (kind === "context" && ir && fr) {
      await run({
        command: "context.create",
        expectedVersions,
        payload: {
          flowRevisionId: fr.id,
          intentRevisionId: ir.id,
          entries:
            draft.contextMode !== "exact-document"
              ? []
              : [
                  {
                    entryId: crypto.randomUUID(),
                    role: "spec",
                    reference: {
                      documentId: draft.documentId,
                      version: Number(draft.documentVersion),
                      contentDigest: draft.documentDigest,
                    },
                    required: true,
                    contentDigest: draft.documentDigest,
                  },
                ],
          gitBases: [],
        },
      });
    } else if (kind === "attempt" && intent && ir) {
      await run({
        command: "attempt.create",
        expectedVersions,
        payload: {
          intentRevisionId: ir.id,
          contextSnapshotId: draft.context ?? contexts[0]?.id,
          participantId: hub.principal.id,
          method: draft.method ?? "human",
          summary: draft.summary,
          supersedesAttemptId:
            attempt &&
            [
              "changes-requested",
              "rejected",
              "withdrawn",
              "failed",
              "cancelled",
            ].includes(attempt.state)
              ? attempt.id
              : null,
        },
      });
    } else if (kind === "result" && attempt) {
      let artifact: Record<string, unknown>;
      if (draft.resultKind === "document")
        artifact = {
          kind: "document",
          reference: {
            documentId: draft.documentId,
            version: Number(draft.documentVersion),
            contentDigest: draft.documentDigest,
          },
          proposalId: null,
        };
      else if (draft.resultKind === "report") {
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(draft.report ?? ""),
        );
        artifact = {
          kind: "report",
          text: draft.report,
          contentDigest: Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        };
      } else
        artifact = {
          kind: "git",
          repositoryId: draft.repository,
          commitOid: draft.commit,
          treeOid: null,
          pullRequestNumber: null,
        };
      await run({
        command: "subject.create",
        expectedVersions,
        payload: {
          attemptId: attempt.id,
          artifacts: [artifact],
          report: draft.report,
        },
      });
    } else if (kind === "evidence" && attempt && ir) {
      const subject = subjects.find(
        (s) => s.id === (draft.subject ?? subjects[0]?.id),
      );
      if (!subject) return;
      const report = draft.report ?? "";
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(report),
      );
      const outputDigest = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      await run({
        command: "evidence.record",
        expectedVersions,
        payload: {
          attemptId: attempt.id,
          subjectId: subject.id,
          subjectDigest: subject.contentDigest,
          criterionIds: [draft.criterion ?? ir.criteria[0]?.criterionId],
          result: draft.result ?? "inconclusive",
          method: draft.method,
          report,
          outputDigest,
          sourceRunId: null,
          sourceObservationId: null,
        },
      });
    } else if (kind === "progress" && attempt) {
      await run({
        command: "attempt.report",
        expectedVersions,
        payload: {
          attemptId: attempt.id,
          event: draft.event ?? "progress",
          report: draft.report,
        },
      });
    }
  };
  return (
    <form
      className="work-contribution-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {kind === "intent" && (
        <>
          {field("title", "flowTitle")}
          {field("deliverable", "deliverable", true)}
          {field("approach", "approach", true)}
          {field("outOfScope", "outOfScope", true)}
          {field("criteria", "criteriaInput", true)}
          {choice(
            "criterion",
            "mapping",
            fr?.criteria.map((c) => ({ id: c.criterionId, label: c.text })) ??
              [],
          )}
          {choice("required", "required", [
            { id: "true", label: t("required") },
            { id: "false", label: t("optional") },
          ])}
        </>
      )}
      {kind === "context" && (
        <>
          <p>{t("contextHelp")}</p>
          {choice("contextMode", "contextMode", [
            { id: "requirements-only", label: t("requirementsOnly") },
            { id: "exact-document", label: t("exactDocument") },
          ])}
          {draft.contextMode === "exact-document" && (
            <>
              {field("documentId", "documentId")}
              {field(
                "documentVersion",
                "documentVersion",
                false,
                "[1-9][0-9]*",
              )}
              {field("documentDigest", "documentDigest", false, "[a-f0-9]{64}")}
            </>
          )}
        </>
      )}
      {kind === "attempt" && (
        <>
          {choice(
            "context",
            "contextSnapshot",
            contexts.map((c) => ({ id: c.id, label: c.id })),
          )}
          {choice(
            "method",
            "method",
            ["human", "native-agent", "external-agent"].map((id) => ({
              id,
              label: t("states." + id),
            })),
          )}
          {field("summary", "summary", true)}
          <p>{t("startHelp")}</p>
        </>
      )}
      {kind === "result" && (
        <>
          {choice("resultKind", "resultKind", [
            { id: "git", label: t("gitResult") },
            { id: "document", label: t("documentResult") },
            { id: "report", label: t("reportResult") },
          ])}
          {(!draft.resultKind || draft.resultKind === "git") && (
            <>
              {field("repository", "repository")}
              {field("commit", "commit", false, "[a-f0-9]{40}|[a-f0-9]{64}")}
            </>
          )}
          {draft.resultKind === "document" && (
            <>
              {field("documentId", "documentId")}
              {field(
                "documentVersion",
                "documentVersion",
                false,
                "[1-9][0-9]*",
              )}
              {field("documentDigest", "documentDigest", false, "[a-f0-9]{64}")}
            </>
          )}
          {field("report", "report", true)}
        </>
      )}
      {kind === "evidence" && (
        <>
          {choice(
            "subject",
            "result",
            subjects.map((s) => ({ id: s.id, label: s.id })),
          )}
          {choice(
            "criterion",
            "criterion",
            ir?.criteria.map((c) => ({ id: c.criterionId, label: c.text })) ??
              [],
          )}
          {choice(
            "result",
            "evidenceResult",
            ["inconclusive", "pass", "fail"].map((id) => ({
              id,
              label: t("states." + id),
            })),
          )}
          {field("method", "evidenceMethod")}
          {field("report", "report", true)}
          <p>{t("selfReport")}</p>
        </>
      )}
      {kind === "progress" && (
        <>
          {choice(
            "event",
            "event",
            ["progress", "blocked", "failed"].map((id) => ({
              id,
              label: t(
                id === "progress"
                  ? "progressEvent"
                  : id === "failed"
                    ? "failedState"
                    : "blocked",
              ),
            })),
          )}
          {field("report", "report", true)}
        </>
      )}
      <div className="work-actions">
        <Button
          type="submit"
          disabled={
            blocked ||
            (kind === "attempt" && !contexts.length) ||
            (kind === "evidence" && !subjects.length)
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

export function SubmissionForm({
  adapter,
  records,
  flow,
  intent,
  attempt,
  onDone,
}: {
  adapter: WorkAdapter;
  records: WorkRecord[];
  flow: WorkFlow;
  intent: WorkIntent;
  attempt: Attempt;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [draft, setDraft] = useDraft(
    [hub.scopeKey, hub.projectId, adapter.mode, attempt.id, "submission"].join(
      ":",
    ),
    { subjectId: "", reason: "" },
  );
  const { run, blocked } = useWorkOperation(adapter, onDone);
  const subjects = recordsOf(records, "subject").filter(
    (s) => s.attemptId === attempt.id,
  );
  const subject =
    subjects.find((s) => s.id === draft.subjectId) ?? subjects.at(-1);
  const revision = recordOf(
    records,
    "intent-revision",
    attempt.intentRevisionId,
  );
  const evidence = recordsOf(records, "evidence").filter(
    (e) =>
      e.attemptId === attempt.id &&
      e.subjectId === subject?.id &&
      e.subjectDigest === subject?.contentDigest,
  );
  if (!subject || !revision) return null;
  const coverage = revision.criteria.map((c) => {
    const matches = evidence.filter((e) =>
      e.criterionIds.includes(c.criterionId),
    );
    const result: "missing" | "fail" | "inconclusive" | "pass" = !matches.length
      ? "missing"
      : matches.some((e) => e.result === "fail")
        ? "fail"
        : matches.some((e) => e.result === "inconclusive")
          ? "inconclusive"
          : "pass";
    return {
      criterionId: c.criterionId,
      result,
      evidenceIds: matches.map((e) => e.id),
    };
  });
  return (
    <form
      className="work-contribution-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          command: "attempt.submit",
          expectedVersions: aggregateVersions(flow, intent, attempt),
          payload: {
            attemptId: attempt.id,
            subjectId: subject.id,
            subjectDigest: subject.contentDigest,
            evidenceIds: evidence.map((e) => e.id),
            coverage,
            knowledgeFollowup: {
              proposalIds: [],
              noUpdateReason: draft.reason.trim(),
            },
          },
        });
      }}
    >
      <h3>{t("seal")}</h3>
      <p>{t("sealHelp")}</p>
      <Field label={t("result")}>
        <Select
          value={subject.id}
          onChange={(e) => setDraft({ ...draft, subjectId: e.target.value })}
        >
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </Select>
      </Field>
      <code>{subject.contentDigest}</code>
      {coverage.map((c) => (
        <p key={c.criterionId}>
          {revision.criteria.find((r) => r.criterionId === c.criterionId)?.text}{" "}
          · {t("states." + c.result)}
        </p>
      ))}
      <Field label={t("noUpdateReason")}>
        <Textarea
          required
          maxLength={4000}
          value={draft.reason}
          onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
        />
      </Field>
      <Button type="submit" disabled={blocked}>
        {t("seal")}
      </Button>
    </form>
  );
}
