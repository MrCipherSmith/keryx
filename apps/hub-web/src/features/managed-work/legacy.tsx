import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { getJson } from "../../api/client";
import { useDraft } from "../../state/drafts";
import { Button, Field, Input, Notice, Textarea } from "../../components/ui";
import { ExactDocument } from "./revision-review";
import { useWorkOperation } from "./operation";
import type { WorkAdapter } from "./adapter";
import type { WorkRecord, LegacyPreview } from "./types";

type LegacyFlow = {
  id: string;
  title: string;
  status: string;
  version: number;
};
export function LegacyConversion({
  adapter,
  records,
  onDone,
}: {
  adapter: WorkAdapter;
  records: WorkRecord[];
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: [
      hub.scopeKey,
      hub.projectId,
      "work",
      adapter.mode,
      "legacy-sources",
    ],
    queryFn: ({ signal }) =>
      getJson<{ flows: LegacyFlow[] }>(
        "/projects/" + encodeURIComponent(hub.projectId!) + "/flows",
        signal,
      ),
    retry: false,
  });
  const { operation, run, blocked } = useWorkOperation(adapter, onDone);
  const sources = (query.data?.flows ?? []).filter(
    (f) =>
      ["initializing", "ready"].includes(f.status) &&
      !records.some((r) => r.kind === "flow" && r.legacyFlowId === f.id),
  );
  const preview = operation.lastReceipt?.preview;
  return (
    <details className="work-legacy">
      <summary>{t("legacyConversion")}</summary>
      <p>{t("legacyHelp")}</p>
      {query.error ? (
        <Notice tone="error">{t("failed")}</Notice>
      ) : !sources.length ? (
        <p>{t("noLegacySources")}</p>
      ) : (
        sources.map((source) => (
          <div className="work-legacy-source" key={source.id}>
            <strong>{source.title}</strong>
            <span>v{source.version}</span>
            <Button
              variant="secondary"
              disabled={blocked}
              onClick={() => {
                setSelected(source.id);
                void run({
                  command: "legacy.preview",
                  expectedVersions: { [source.id]: source.version },
                  payload: {
                    legacyFlowId: source.id,
                    sourceVersion: source.version,
                  },
                });
              }}
            >
              {t("previewLegacy")}
            </Button>
          </div>
        ))
      )}
      {preview && preview.legacyFlowId === selected && (
        <ConvertPreview
          key={preview.receiptId}
          adapter={adapter}
          preview={preview}
          onDone={onDone}
        />
      )}
    </details>
  );
}
function ConvertPreview({
  adapter,
  preview,
  onDone,
}: {
  adapter: WorkAdapter;
  preview: LegacyPreview;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const { run, blocked } = useWorkOperation(adapter, onDone);
  const [draft, setDraft] = useDraft(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      preview.legacyFlowId,
      preview.sourceDigest,
      "legacy-convert",
    ].join(":"),
    { title: "", deliverable: "", approach: "", outOfScope: "", criterion: "" },
  );
  return (
    <form
      className="work-contribution-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          command: "legacy.convert",
          expectedVersions: { [preview.legacyFlowId]: preview.sourceVersion },
          payload: {
            legacyFlowId: preview.legacyFlowId,
            sourceVersion: preview.sourceVersion,
            dryRunReceiptId: preview.receiptId,
            dryRunDigest: preview.contentDigest,
            intent: {
              title: draft.title,
              deliverable: draft.deliverable,
              approach: draft.approach,
              outOfScope: draft.outOfScope,
              ownerId: hub.principal.id,
              required: true,
              criteria: [
                {
                  criterionId: crypto.randomUUID(),
                  text: draft.criterion,
                  waivable: false,
                },
              ],
              flowCriterionIds: preview.source.criteria.map(
                (_, index) => "legacy-" + (index + 1),
              ),
            },
          },
        });
      }}
    >
      <h3>
        {preview.source.title} · v{preview.sourceVersion}
      </h3>
      <code>{preview.sourceDigest}</code>
      <code>{preview.contentDigest}</code>
      <ExactDocument
        adapter={adapter}
        reference={preview.source.specification}
      />
      <ul>
        {preview.source.criteria.map((criterion, index) => (
          <li key={index}>{criterion}</li>
        ))}
      </ul>
      <Notice>{t("legacyNoAcceptance")}</Notice>
      {(
        ["title", "deliverable", "approach", "outOfScope", "criterion"] as const
      ).map((key) => (
        <Field
          key={key}
          label={t(
            key === "title"
              ? "flowTitle"
              : key === "criterion"
                ? "criterionText"
                : key,
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
              required
              maxLength={4000}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          )}
        </Field>
      ))}
      <p>
        {t("required")} · {t("legacyMapping")}
      </p>
      <Button
        type="submit"
        disabled={blocked || hub.principal.kind !== "human"}
      >
        {t("convertLegacy")}
      </Button>
    </form>
  );
}
