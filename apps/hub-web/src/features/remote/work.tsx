import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Control } from "../../api/remote";
import type { HubFlow } from "../../api/types";
import type { CommandOutcomeListener } from "./session-timeline";
import {ApiError,getClientScope, getJson } from "../../api/client";
import {NativeAttemptPicker,useNativeWorkSelection} from "../managed-work/native-selection";
import { remoteProject } from "../../api/remote";
import {
  sessionPath,
  useRemoteAction,
  useRemoteQuery,
} from "../../api/remote-hooks";
import { useQuery } from "@tanstack/react-query";
import { useHub } from "../../app/hub-context";
import { useDraft, useDraftStore } from "../../state/drafts";
import { pendingScope, usePending } from "../../state/pending";
import { validNativeSubmission, type NativeSubmission } from "./work-pending";
import {
  Button,
  EmptyState,
  Field,
  Notice,
  Panel,
  Select,
  Textarea,
} from "../../components/ui";
import { Commands } from "./settings";
import { AssociationPicker } from "./association";
import {
  ActionFeedback,
  Definition,
  digestCriteria,
  Feedback,
  type Controller,
} from "./shared";
const chatCommandShortcuts = ["/connect", "/model", "/routing"] as const;
type ChatCommandShortcut = typeof chatCommandShortcuts[number];

export type MessageDraft = {
  text: string; prepared: boolean; mode: string; flowId: string; flowVersion: number; specDigest: string;
  criteriaDigest: string; consent: boolean; consentVersion: number | null; busyPolicy: "reject" | "enqueue";
  sessionVersion: number; configVersion: number;
};
/** The one key the composer reads its draft from; launch code writes through the same helper. */
export function messageDraftKey(scopeKey: number, projectId: string | null, sessionId: string) {
  return `remote-message:${scopeKey}:${projectId}:${sessionId}`;
}
/** A first message prepared for an exact Flow, seeded by session creation. */
export function prepareFlowMessageDraft(flow: HubFlow, criteriaDigest: string, text: string): MessageDraft {
  return {
    text, prepared: true, mode: "flow", flowId: flow.id, flowVersion: flow.version,
    specDigest: flow.specContentDigest, criteriaDigest, consent: false, consentVersion: null,
    busyPolicy: "reject", sessionVersion: 0, configVersion: 0,
  };
}
export function MessageComposer({
  record,
  control,
  onCommandOutcome,
}: {
  record: Control["SessionRecord"];
  control: Controller;
  onCommandOutcome?: CommandOutcomeListener;
}) {
  const [commands, setCommands] = useState<"unopened" | "open" | "closed">("unopened");
  const [focusToken, setFocusToken] = useState(0);
  const [commandShortcut, setCommandShortcut] = useState<ChatCommandShortcut>();
  const commandsId = useId();
  const commandTrigger = useRef<HTMLButtonElement>(null);
  const commandOpener = useRef<HTMLButtonElement | null>(null);
  // Set while the catalogue was opened by '/' and nothing has been done in it yet (no key other than Escape, no
  // pointer press, no change inside it): Escape then hands the slash back.
  const slashOpened = useRef<HTMLTextAreaElement | null>(null);
  function closeCommands() {
    const opener = commandOpener.current ?? commandTrigger.current;
    slashOpened.current = null;
    commandOpener.current = null;
    setCommands("closed");
    opener?.focus();
  }
  const hub = useHub();
  const { t } = useTranslation("remote");
  const {t:workT}=useTranslation("work");
  const action = useRemoteAction<Control["TurnReceipt"]>();
  const consent = useRemoteQuery<{ profileConsentVersion: number | null }>(
    ["chat-consent",record.sessionId,record.config.policyDigest],
    sessionPath(record.projectId,record.sessionId)+"/chat-consent",
  );
  const profileConsentVersion = consent.data?.profileConsentVersion;
  const hasProfileConsent = typeof profileConsentVersion === "number" && Number.isSafeInteger(profileConsentVersion) && profileConsentVersion > 0;
  const draftKey = messageDraftKey(hub.scopeKey, record.projectId, record.sessionId);
  const [draft, setDraft, clearDraft] = useDraft<MessageDraft>(
    draftKey,
    {
      text: "",
      prepared: false,
      mode: "",
      flowId: hub.location.flowId ?? "",
      flowVersion: 0,
      specDigest: "",
      criteriaDigest: "",
      consent: false,
      consentVersion: null,
      busyPolicy: "reject",
      sessionVersion: record.version,
      configVersion: record.config.configVersion,
    },
  );
  const mode = draft.mode || (hasProfileConsent ? "ad-hoc" : "flow");
  const managed=useNativeWorkSelection(record,mode,control.active);
  const nativeScope=pendingScope("native",hub.principal.id,record.projectId,record.sessionId);
  const nativeScopeRef=useRef(nativeScope);nativeScopeRef.current=nativeScope;
  const nativePending=usePending<NativeSubmission>(nativeScope,(value):value is NativeSubmission=>validNativeSubmission(value,nativeScope,sessionPath(record.projectId,record.sessionId)+"/messages"),(value)=>({...value,phase:"unknown"}));
  const nativeOperation=nativePending.value;
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
  // A draft prepared at session creation carries no versions yet. Pin it to the versions the human first
  // sees once the machine has opened the session, so later drift raises the same stale notice as any draft.
  useEffect(() => {
    if (!draft.prepared || record.state === "opening") return;
    setDraft(old => old.prepared
      ? { ...old, prepared: false, sessionVersion: record.version, configVersion: record.config.configVersion }
      : old);
  }, [draft.prepared, record.state, record.version, record.config.configVersion, setDraft]);
  const stale = !!draft.text && !draft.prepared && (
    control.advanceVersion(draft.sessionVersion) !== record.version ||
    draft.configVersion !== record.config.configVersion);
  const selected = eligible.find((f) => f.id === draft.flowId);
  function editText(text: string) {
    setDraft({ ...draft, ...(!draft.text||draft.prepared?{prepared:false,sessionVersion:record.version,configVersion:record.config.configVersion}:{}), text });
  }
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
      (mode === "ad-hoc" || mode === "managed") &&
      draft.consent &&
      hasProfileConsent &&
      draft.consentVersion === profileConsentVersion
    )
      return {
        mode: "ad-hoc",
        profileConsentVersion,
      };
    if (
      mode === "flow" &&
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
  function sendNative(original:NativeSubmission, submittedDraft?:typeof draft, previouslyUncertain=false){
    const generation=getClientScope();
    if(!nativePending.put({...original,phase:'sending'}))return;
    action.mutate({path:original.path,body:original.body,operationId:original.operationId,workHint:original.hint},{
      onSuccess:(receipt)=>{
        if(generation!==getClientScope())return;
        if(typeof receipt.operationId!=='string'||!receipt.operationId||receipt.sessionId!==record.sessionId||!['queued','admitted','rejected'].includes(receipt.status)){nativePending.put({...original,phase:'unknown'});return;}
        if(!nativePending.put(null))return;
        if(receipt.status!=='rejected'&&submittedDraft){const preserved=!clearDraft(submittedDraft);if(nativeScopeRef.current===original.scope)setPreserved(preserved);}
      },
      onError:(error)=>{
        if(generation!==getClientScope())return;
        const ambiguous=previouslyUncertain||!(error instanceof ApiError)||error.status===0||error.status>=500||/unknown|pending|uncertain/.test(error.code);
        nativePending.put(ambiguous?{...original,phase:'unknown'}:null);
      }
    });
  }
  function openCommands(search?: ChatCommandShortcut, opener?: HTMLButtonElement | null) {
    setCommandShortcut(search);
    commandOpener.current = opener ?? null;
    setCommands("open");
    setFocusToken(token => token + 1);
  }

  function openCommandShortcut(shortcut: ChatCommandShortcut, opener?: HTMLButtonElement | null) {
    slashOpened.current = null;
    openCommands(shortcut, opener);
  }

  function openDraftCommand(): boolean {
    const shortcut = chatCommandShortcuts.find(command => command === draft.text.trim());
    if (shortcut === undefined || draft.prepared || nativeOperation || nativePending.error) return false;
    editText("");
    openCommandShortcut(shortcut);
    return true;
  }

  function submit() {
    if (openDraftCommand()) return;
    const assoc=association();
    if(nativeOperation||nativePending.error)return;
    if(draft.prepared)return;
    if(!control.binding||!control.active||stale||!assoc||!draft.text.trim()) {setValidation(t('required'));return;}
    if(mode==='managed'&&!managed.hint){setValidation(workT('staleAttempt'));return;}
    const submitted=draft;
    const body={expectedSessionVersion:control.advanceVersion(submitted.sessionVersion),controller:control.binding,expectedConfigVersion:submitted.configVersion,text:submitted.text,interpretation:'literal-message',association:assoc,busyPolicy:submitted.busyPolicy} satisfies Control['MessageSubmit'];
    if(mode==='managed'&&managed.hint){
      if(assoc.mode!=='ad-hoc'){setValidation(workT('nativeConsentRequired'));return;}
      const original:NativeSubmission={scope:nativeScope,operationId:crypto.randomUUID(),path:sessionPath(record.projectId,record.sessionId)+'/messages',body:structuredClone(body),hint:Object.freeze({...managed.hint}),phase:'sending'};
      sendNative(original,submitted);
    }else action.mutate({path:sessionPath(record.projectId,record.sessionId)+'/messages',body},{onSuccess:receipt=>{if(receipt.status==='rejected')return;const store=useDraftStore.getState();const current=store.drafts[draftKey];if(current===submitted)store.put(draftKey,{...submitted,text:"",prepared:false});setPreserved(current!==undefined&&current!==submitted);}});
  }

  return (
    <Panel title={t("message")}>
      {record.state === "opening" || record.state === "recovery-required" ? (
        <Notice>{t(record.state === "opening" ? "sessionNotOpen" : "sessionNeedsRecovery")}</Notice>
      ) : control.claimPending ? <Notice>{t("controlApplying")}</Notice> : !control.active && !record.controller && (
        <Notice>{t("observer")} {control.operator && <a href="#session-controller" className="underline">{t("goToController")}</a>}</Notice>
      )}
      <Field label={t("message")} hint={t("commandsHint")}>
        <Textarea
          value={draft.text}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && openDraftCommand()) {
              event.preventDefault();
              return;
            }
            if (event.key !== "/" || draft.text || event.nativeEvent.isComposing ||
                event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
            event.preventDefault();
            slashOpened.current = event.currentTarget;
            openCommands();
          }}
          maxLength={32768}
          onChange={(e) => editText(e.target.value)}
        />
      </Field>
      <div className="composer-command-actions">
        <Button
          ref={commandTrigger}
          variant="secondary"
          aria-label={t("commands")}
          aria-expanded={commands === "open"}
          aria-controls={commands === "unopened" ? undefined : commandsId}
          onClick={(event) => commands === "open" ? closeCommands() : openCommands(undefined, event.currentTarget)}
        >
          <span aria-hidden="true">/</span> {t("commands")}
        </Button>
        {chatCommandShortcuts.map(shortcut => (
          <Button key={shortcut} variant="secondary" onClick={(event) => openCommandShortcut(shortcut, event.currentTarget)}>
            {shortcut}
          </Button>
        ))}
      </div>
      {commands !== "unopened" && (
        <div id={commandsId} hidden={commands !== "open"}
          onPointerDownCapture={() => { slashOpened.current = null; }}
          onChangeCapture={() => { slashOpened.current = null; }}
          onKeyDown={(event) => {
          if (event.key !== "Escape") { slashOpened.current = null; return; }
          if (event.defaultPrevented) return;
          const field = slashOpened.current;
          closeCommands();
          if (field && !draft.text) { editText("/"); field.focus(); }
        }}>
          <Commands record={record} control={control} onOutcome={onCommandOutcome}
            visible={commands === "open"} focusToken={focusToken} initialSearch={commandShortcut} />
        </div>
      )}
      <p className="composer-hint">{t("secretWarning")}</p>
      <details open={!association()} className="composer-work-context">
        <summary>{mode === "flow" && selected ? selected.title : t("workMode")}</summary>
      <div className="composer-controls">
        <Field label={t("workMode")}>
          <Select
            value={mode}
            disabled={!!nativeOperation}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value,consent:false })}
          >
            <option value="flow">{t("flow")}</option>
            <option value="ad-hoc" disabled={!hasProfileConsent}>{t("adHoc")}</option>
            {(managed.available||mode==='managed')&&<option value="managed" disabled={!managed.available||!managed.operator}>{workT("managedAttempt")}</option>}
          </Select>
        </Field>
        {mode === "flow" ? (
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
        ) : null}
      </div>
      </details>
      {mode === "flow" ? (
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
      ) : hasProfileConsent ? (
        <label className="flex gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.consent && draft.consentVersion === profileConsentVersion}
            onChange={(e) => setDraft({ ...draft, consent: e.target.checked, consentVersion: profileConsentVersion })}
          />
          {t("chatConsent")}
        </label>
      ) : <Notice>{t("adHocUnavailable")}</Notice>}
      {mode==='managed' && <><NativeAttemptPicker value={managed} locked={!!nativeOperation}/>{!association()&&<p className="composer-hint">{workT("nativeConsentRequired")}</p>}</>}
      {nativePending.error&&<Notice tone="error">{workT("pendingStorageError")}</Notice>}
      {nativeOperation && <Notice>{workT(nativeOperation.phase==='sending'?"pending":"nativeOutcomeUnknown")}<p>{workT("operation")}: <code>{nativeOperation.operationId}</code></p><p>{workT("managedAttempt")}: <code>{nativeOperation.hint.attemptId}</code> · v{nativeOperation.hint.attemptVersion}</p>{nativeOperation.phase==='unknown'&&<Button variant="secondary" disabled={!managed.operator||!control.active||action.isPending} onClick={()=>sendNative(nativeOperation,undefined,true)}>{workT("retryOriginalMessage")}</Button>}</Notice>}
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
      {mode === "flow" && <Feedback query={flows} />}
      <Feedback query={consent} />
      <ActionFeedback action={action} />
      <div className="composer-footer">
        <details>
          <summary>{t("chatOptions")}</summary>
          <Field label={t("busyPolicy")} hint={t("busyPolicyHelp")}>
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
        </details>
        <Button
          disabled={
            record.state === "opening" || record.state === "recovery-required" || record.state === "closed" ||
            !control.active ||
            stale ||
            action.isPending ||
            !!nativeOperation ||
            nativePending.error ||
            (mode==='managed'&&!managed.valid) ||
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
