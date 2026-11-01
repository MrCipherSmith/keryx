import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Control } from "../../api/remote";
import type { HubFlow } from "../../api/types";
import {ApiError,getClientScope, getJson, type NativeWorkHint } from "../../api/client";
import {NativeAttemptPicker,useNativeWorkSelection} from "../managed-work/native-selection";
import { remoteProject } from "../../api/remote";
import {
  sessionPath,
  useRemoteAction,
  useRemoteQuery,
} from "../../api/remote-hooks";
import { useQuery } from "@tanstack/react-query";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  Panel,
  Select,
  Textarea,
} from "../../components/ui";
import { AssociationPicker } from "./association";
import {
  ActionFeedback,
  Definition,
  digestCriteria,
  Feedback,
  type Controller,
} from "./shared";
export function MessageComposer({
  record,
  control,
}: {
  record: Control["SessionRecord"];
  control: Controller;
}) {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const {t:workT}=useTranslation("work");
  const action = useRemoteAction<Control["TurnReceipt"]>();
  const [draft, setDraft, clearDraft] = useDraft(
    `remote-message:${hub.scopeKey}:${record.projectId}:${record.sessionId}`,
    {
      text: "",
      mode: "flow",
      flowId: hub.location.flowId ?? "",
      flowVersion: 0,
      specDigest: "",
      criteriaDigest: "",
      consent: false,
      consentVersion: "1",
      busyPolicy: "reject" as "reject" | "enqueue",
      sessionVersion: record.version,
      configVersion: record.config.configVersion,
    },
  );
  const managed=useNativeWorkSelection(record,draft.mode,control.active);
  type NativeSubmission={scope:string;operationId:string;path:string;body:Control['MessageSubmit'];hint:NativeWorkHint;draft:typeof draft;phase:'sending'|'unknown'};
  const nativeScope=[hub.scopeKey,hub.principal.id,record.projectId,record.sessionId].join(':');
  const nativeScopeRef=useRef(nativeScope);nativeScopeRef.current=nativeScope;
  const [nativeOperation,setNativeOperation]=useDraft<NativeSubmission|null>('native-work-message:'+nativeScope,null);
  const flows = useQuery({
    queryKey: [hub.scopeKey, record.projectId, "flows"],
    queryFn: ({ signal }) =>
      getJson<{ flows: HubFlow[] }>(
        remoteProject(record.projectId) + "/flows",
        signal,
      ),
  });
  const eligible =
    flows.data?.flows.filter((f) => f.status === "in-progress") ?? [];
  const [validation, setValidation] = useState("");
  const [preserved, setPreserved] = useState(false);
  const stale =
    control.advanceVersion(draft.sessionVersion) !== record.version ||
    draft.configVersion !== record.config.configVersion;
  const selected = eligible.find((f) => f.id === draft.flowId);
  async function selectFlow(id: string) {
    const flow = eligible.find((f) => f.id === id);
    if (!flow) {
      setDraft({
        ...draft,
        flowId: "",
        flowVersion: 0,
        specDigest: "",
        criteriaDigest: "",
      });
      return;
    }
    const digest = await digestCriteria(flow.criteria);
    setDraft((old) => ({
      ...old,
      flowId: id,
      flowVersion: flow.version,
      specDigest: flow.specContentDigest,
      criteriaDigest: digest,
    }));
  }
  function association(): Control["FlowAssociation"] | null {
    if (
      (draft.mode === "ad-hoc" || draft.mode === "managed") &&
      draft.consent &&
      Number.isSafeInteger(Number(draft.consentVersion)) &&
      Number(draft.consentVersion) > 0
    )
      return {
        mode: "ad-hoc",
        profileConsentVersion: Number(draft.consentVersion),
      };
    if (
      draft.mode === "flow" &&
      selected &&
      draft.flowVersion === selected.version &&
      draft.specDigest === selected.specContentDigest &&
      draft.criteriaDigest
    )
      return {
        mode: "flow",
        flowId: draft.flowId,
        expectedFlowVersion: draft.flowVersion,
        specDigest: draft.specDigest,
        criteriaDigest: draft.criteriaDigest,
      };
    return null;
  }
  function sendNative(original:NativeSubmission){
    const generation=getClientScope();
    setNativeOperation({...original,phase:'sending'});
    action.mutate({path:original.path,body:original.body,operationId:original.operationId,workHint:original.hint},{
      onSuccess:(receipt)=>{
        if(generation!==getClientScope())return;
        if(typeof receipt.operationId!=='string'||!receipt.operationId||receipt.sessionId!==record.sessionId||!['queued','admitted','rejected'].includes(receipt.status)){setNativeOperation({...original,phase:'unknown'});return;}
        setNativeOperation(null);
        if(receipt.status!=='rejected'){const preserved=!clearDraft(original.draft);if(nativeScopeRef.current===original.scope)setPreserved(preserved);}
      },
      onError:(error)=>{
        if(generation!==getClientScope())return;
        const ambiguous=!(error instanceof ApiError)||error.status===0||error.status>=500||/unknown|pending|uncertain/.test(error.code);
        setNativeOperation(ambiguous?{...original,phase:'unknown'}:null);
      }
    });
  }
  function submit() {
    const assoc=association();
    if(nativeOperation)return;
    if(!control.binding||!control.active||stale||!assoc||!draft.text.trim()) {setValidation(t('required'));return;}
    if(draft.mode==='managed'&&!managed.hint){setValidation(workT('staleAttempt'));return;}
    const submitted=draft;
    const body={expectedSessionVersion:control.advanceVersion(submitted.sessionVersion),controller:control.binding,expectedConfigVersion:submitted.configVersion,text:submitted.text,interpretation:'literal-message',association:assoc,busyPolicy:submitted.busyPolicy} satisfies Control['MessageSubmit'];
    if(draft.mode==='managed'&&managed.hint){
      if(assoc.mode!=='ad-hoc'){setValidation(workT('nativeConsentRequired'));return;}
      const original:NativeSubmission={scope:nativeScope,operationId:crypto.randomUUID(),path:sessionPath(record.projectId,record.sessionId)+'/messages',body:structuredClone(body),hint:Object.freeze({...managed.hint}),draft:submitted,phase:'sending'};
      sendNative(original);
    }else action.mutate({path:sessionPath(record.projectId,record.sessionId)+'/messages',body},{onSuccess:()=>setPreserved(!clearDraft(submitted))});
  }

  return (
    <Panel title={t("message")}>
      <Field label={t("message")}>
        <Textarea
          value={draft.text}
          rows={3}
          maxLength={32768}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        />
      </Field>
      <p className="composer-hint">{t("secretWarning")}</p>
      <div className="composer-controls">
        <Field label={t("workMode")}>
          <Select
            value={draft.mode}
            disabled={!!nativeOperation}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value,consent:false })}
          >
            <option value="flow">{t("flow")}</option>
            <option value="ad-hoc">{t("adHoc")}</option>
            {(managed.available||draft.mode==='managed')&&<option value="managed" disabled={!managed.available||!managed.operator}>{workT("managedAttempt")}</option>}
          </Select>
        </Field>
        {draft.mode === "flow" ? (
          <Field label={t("chooseFlow")}>
            <Select
              value={draft.flowId}
              onChange={(e) => void selectFlow(e.target.value)}
            >
              <option value="">{t("choose")}</option>
              {eligible.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title} · v{f.version}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={t("consentVersion")}>
            <Input
              type="number"
              min="1"
              step="1"
              value={draft.consentVersion}
              onChange={(e) =>
                setDraft({ ...draft, consentVersion: e.target.value })
              }
            />
          </Field>
        )}
      </div>
      {draft.mode === "flow" ? (
        <>
          {selected && !draft.criteriaDigest && (
            <Button
              variant="secondary"
              onClick={() => void selectFlow(selected.id)}
            >
              {t("pins")}
            </Button>
          )}
          <details className="composer-pins">
            <summary>{t("pins")}</summary>
            <Definition label={t("pins")}>
              {draft.specDigest || "—"}
              <br />
              {draft.criteriaDigest || "—"}
            </Definition>
          </details>
        </>
      ) : (
        <label className="flex gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.consent}
            onChange={(e) => setDraft({ ...draft, consent: e.target.checked })}
          />
          {t("adHocConsent")}
        </label>
      )}
      {draft.mode==='managed' && <><NativeAttemptPicker value={managed} locked={!!nativeOperation}/>{!association()&&<p className="composer-hint">{workT("nativeConsentRequired")}</p>}</>}
      {nativeOperation && <Notice>{workT(nativeOperation.phase==='sending'?"pending":"nativeOutcomeUnknown")}<p>{workT("operation")}: <code>{nativeOperation.operationId}</code></p><p>{workT("managedAttempt")}: <code>{nativeOperation.hint.attemptId}</code> · v{nativeOperation.hint.attemptVersion}</p>{nativeOperation.phase==='unknown'&&<Button variant="secondary" disabled={!managed.operator||!control.active||action.isPending} onClick={()=>sendNative(nativeOperation)}>{workT("retryOriginalMessage")}</Button>}</Notice>}
      {stale && (
        <Notice>
          {t("stale")}
          <Button
            variant="secondary"
            onClick={() =>
              setDraft({
                ...draft,
                sessionVersion: record.version,
                configVersion: record.config.configVersion,
              })
            }
          >
            {t("rebase")}
          </Button>
        </Notice>
      )}
      {preserved && <Notice>{t("common:draftPreserved")}</Notice>}
      {validation && <Notice tone="error">{validation}</Notice>}
      <Feedback query={flows} />
      <ActionFeedback action={action} />
      <div className="composer-footer">
        <Field label={t("busyPolicy")}>
          <Select
            value={draft.busyPolicy}
            onChange={(e) =>
              setDraft({
                ...draft,
                busyPolicy: e.target.value === "enqueue" ? "enqueue" : "reject",
              })
            }
          >
            <option value="reject">{t("reject")}</option>
            <option value="enqueue">{t("enqueue")}</option>
          </Select>
        </Field>
        <Button
          disabled={
            !control.active ||
            stale ||
            action.isPending ||
            !!nativeOperation ||
            (draft.mode==='managed'&&!managed.valid) ||
            !draft.text.trim() ||
            !association()
          }
          onClick={submit}
        >
          {t("send")}
        </Button>
      </div>
    </Panel>
  );
}
export function QueueControls({
  record,
  control,
}: {
  record: Control["SessionRecord"];
  control: Controller;
}) {
  const { t } = useTranslation("remote");
  const path = sessionPath(record.projectId, record.sessionId);
  const query = useRemoteQuery<Control["QueuePage"]>(
    ["queue", record.sessionId],
    path + "/queue",
  );
  return (
    <Panel title={t("queue")}>
      <Feedback query={query} />
      {query.data?.items.length === 0 && <EmptyState>{t("empty")}</EmptyState>}
      {query.data?.items.map((item) => (
        <QueueRow
          key={item.queueItemId}
          item={item}
          record={record}
          control={control}
          queueVersion={query.data!.queueVersion}
        />
      ))}
    </Panel>
  );
}
function QueueRow({
  item,
  record,
  control,
  queueVersion,
}: {
  item: Control["QueueItem"];
  record: Control["SessionRecord"];
  control: Controller;
  queueVersion: number;
}) {
  const { t } = useTranslation("remote");
  const hub = useHub();
  const [draft, setDraft] = useDraft(
    `remote-queue:${hub.scopeKey}:${record.projectId}:${record.sessionId}:${item.queueItemId}`,
    {
      text: item.text ?? "",
      itemVersion: item.version,
      sessionVersion: record.version,
      queueVersion,
    },
  );
  const action = useRemoteAction();
  const [association, setAssociation] = useState<
    Control["FlowAssociation"] | null
  >(null);
  const stale =
    draft.itemVersion !== item.version ||
    control.advanceVersion(draft.sessionVersion) !== record.version ||
    draft.queueVersion !== queueVersion;
  const path =
    sessionPath(record.projectId, record.sessionId) +
    "/queue/" +
    encodeURIComponent(item.queueItemId);
  const allowed =
    control.active && item.state === "queued" && !stale && !action.isPending;
  const base = () =>
    control.binding
      ? {
          expectedSessionVersion: control.advanceVersion(draft.sessionVersion),
          controller: control.binding,
          expectedQueueVersion: draft.queueVersion,
          expectedItemVersion: draft.itemVersion,
          queueItemId: item.queueItemId,
        }
      : null;
  return (
    <article className="min-w-0 space-y-3 rounded-xl border border-slate-200 p-3">
      <p className="break-all text-sm">
        {item.kind} · {t("states." + item.state, { defaultValue: item.state })}{" "}
        · #{item.position} · {item.operationId}
      </p>
      {item.kind === "message" && (
        <Field label={t("edit")}>
          <Textarea
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        {item.kind === "message" && (
          <Button
            disabled={!allowed}
            onClick={() => {
              const b = base();
              if (b)
                action.mutate({
                  method: "PATCH",
                  path,
                  body: {
                    ...b,
                    text: draft.text,
                  } satisfies Control["QueueEdit"],
                });
            }}
          >
            {t("save")}
          </Button>
        )}
        <Button
          variant="danger"
          disabled={!allowed}
          onClick={() => {
            const b = base();
            if (b)
              action.mutate({
                method: "DELETE",
                path,
                body: b satisfies Control["QueueRemove"],
              });
          }}
        >
          {t("remove")}
        </Button>
      </div>
      {stale && (
        <Notice>
          {t("stale")}
          <Button
            variant="secondary"
            onClick={() =>
              setDraft({
                ...draft,
                itemVersion: item.version,
                sessionVersion: record.version,
                queueVersion,
              })
            }
          >
            {t("rebase")}
          </Button>
        </Notice>
      )}
      {item.state === "suspended" && (
        <fieldset
          aria-label={t("reauthorize")}
          className="space-y-3 border-t border-slate-200 pt-3"
        >
          <AssociationPicker
            projectId={record.projectId}
            onChange={setAssociation}
          />
          <Button
            disabled={
              !control.active || stale || !association || action.isPending
            }
            onClick={() => {
              const b = base();
              if (b && association)
                action.mutate({
                  path: path + "/reauthorize",
                  body: {
                    ...b,
                    originalOperationId: item.operationId,
                    expectedConfigVersion: record.config.configVersion,
                    association,
                  } satisfies Control["QueueReauthorize"],
                });
            }}
          >
            {t("reauthorize")}
          </Button>
        </fieldset>
      )}
      <ActionFeedback action={action} />
    </article>
  );
}
