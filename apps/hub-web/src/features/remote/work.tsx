import { useEffect, useId, useMemo, useRef, useState, useImperativeHandle, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ChatAction, ChatComposerFrame, ChatToolbar } from "./chat-composer";
import type { SessionComposerSlots } from "./session-workspace";
import type { Control } from "../../api/remote";
import type { HubFlow } from "../../api/types";
import { messageDeliveriesKey, type CommandOutcomeListener } from "./session-timeline";
import type { MessageDeliveries } from "../../../../../src/remote-control/message-delivery";
import { ApiError, errorMessage, getClientScope, getJson } from "../../api/client";
import {NativeAttemptPicker,useNativeWorkSelection} from "../managed-work/native-selection";
import { remoteGet, remoteProject } from "../../api/remote";
import {
  sessionPath,
  useRemoteAction,
  useRemoteQuery,
} from "../../api/remote-hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useHub } from "../../app/hub-context";
import { useDraft, useDraftStore } from "../../state/drafts";
import { pendingScope, readPending, usePending, writePending } from "../../state/pending";
import { validChatSubmission, validNativeSubmission, type ChatSubmission, type NativeSubmission } from "./work-pending";
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
import { chatTurnProofKey, isStaleChatSend, isUncertainChatSend, ownChatTurn, ownChatTurnCandidate, proveOwnChatTurn, type OwnChatTurn } from "./chat-send";
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
type ChatOperation = ChatSubmission & { before?: Control["SessionRecord"]; submitted: MessageDraft };
type ChatDelivery = { operation?: ChatOperation; lastTurn?: OwnChatTurn; storageError?: boolean };

function draftFromSubmission(body: ChatSubmission["body"]): MessageDraft {
  const association = body.association;
  return {
    text: body.text, prepared: false, mode: association.mode,
    flowId: association.mode === "flow" ? association.flowId : "",
    flowVersion: association.mode === "flow" ? association.expectedFlowVersion : 0,
    specDigest: association.mode === "flow" ? association.specDigest : "",
    criteriaDigest: association.mode === "flow" ? association.criteriaDigest : "",
    consent: association.mode === "ad-hoc",
    consentVersion: association.mode === "ad-hoc" ? association.profileConsentVersion : null,
    busyPolicy: body.busyPolicy, sessionVersion: body.expectedSessionVersion, configVersion: body.expectedConfigVersion,
  };
}

export function MessageComposer({
  record,
  control,
  onCommandOutcome,
  awaitingMachine = false,
  restoreDraftRef,
  slots,
}: {
  record: Control["SessionRecord"];
  control: Controller;
  onCommandOutcome?: CommandOutcomeListener;
  awaitingMachine?: boolean;
  restoreDraftRef?: Ref<(text: string) => boolean>;
  slots?: SessionComposerSlots;
}) {
  const [commands, setCommands] = useState<"unopened" | "open" | "closed">("unopened");
  const [focusToken, setFocusToken] = useState(0);
  const [commandShortcut, setCommandShortcut] = useState<ChatCommandShortcut>();
  const commandsId = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
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
  const queryClient = useQueryClient();
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
  const deliveryKey = draftKey + ":delivery";
  const sessionUrl = sessionPath(record.projectId, record.sessionId);
  const chatPath = sessionUrl + "/messages";
  const chatScope = pendingScope("chat", hub.principal.id, record.projectId, record.sessionId);
  const validatePending = (value: unknown): value is ChatSubmission => validChatSubmission(value, chatScope, chatPath);
  const recovered = useMemo<ChatDelivery>(() => {
    try {
      const original = readPending(chatScope, (value): value is ChatSubmission => validChatSubmission(value, chatScope, chatPath));
      return original ? { operation: { ...original, phase: "unknown", submitted: draftFromSubmission(original.body) } } : {};
    } catch { return { storageError: true }; }
  }, [chatScope, chatPath]);
  const [delivery] = useDraft<ChatDelivery>(deliveryKey, recovered);
  const sessionKey = [hub.scopeKey, hub.projectId, "remote", "session", record.sessionId];
  const [sendError, setSendError] = useState<unknown>(null);
  const [draft, setDraft, clearDraft] = useDraft<MessageDraft>(
    draftKey,
    recovered.operation?.submitted ?? {
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
  const verifiedVersion = control.advanceVersion(draft.sessionVersion);
  const lastTurn = delivery.lastTurn;
  const canProve = !!lastTurn && mode !== "managed" && !!draft.text && verifiedVersion !== record.version &&
    draft.configVersion === record.config.configVersion &&
    draft.sessionVersion >= lastTurn.before.version && draft.sessionVersion < record.version &&
    ownChatTurnCandidate(lastTurn, record);
  const turnProof = useQuery({
    queryKey: lastTurn ? chatTurnProofKey(hub.scopeKey, lastTurn, record) : [draftKey, "turn-proof"],
    queryFn: ({ signal }) => lastTurn ? proveOwnChatTurn(lastTurn, record, sessionUrl, signal) : false,
    enabled: canProve,
    retry: false,
    staleTime: Infinity,
  });
  const checkingTurn = canProve && turnProof.isPending;
  const sessionVersion = canProve && turnProof.data === true ? record.version : verifiedVersion;
  const stale = !!draft.text && !draft.prepared &&
    (sessionVersion !== record.version || draft.configVersion !== record.config.configVersion);
  useImperativeHandle(restoreDraftRef, () => (text: string) => {
    const current = useDraftStore.getState().drafts[draftKey] as MessageDraft | undefined;
    if ((current ?? draft).text.length) return false;
    editText(text);
    editor.current?.focus();
    return true;
  });
  const waitingForReply = mode !== "managed" && draft.busyPolicy === "reject" &&
    (record.activeRunId !== null || record.state === "busy" || record.state === "paused");
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
  const contextRequired = !association() || mode === "managed" && !managed.valid;
  const [contextOpen, setContextOpen] = useState(contextRequired);
  useEffect(() => {
    if (contextRequired) setContextOpen(true);
  }, [contextRequired]);

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

  async function sendChat(original: ChatOperation) {
    const generation = getClientScope();
    const store = useDraftStore.getState();
    const getDelivery = () => (useDraftStore.getState().drafts[deliveryKey] as ChatDelivery | undefined) ?? recovered;
    const initial = getDelivery();
    if (!control.operator || initial.storageError || (initial.operation && (initial.operation.phase !== "unknown" ||
        initial.operation.operationId !== original.operationId))) return;
    const saveAttempt = ({ scope, path, body, operationId, phase }: ChatSubmission) =>
      writePending(chatScope, { scope, path, body, operationId, phase }, validatePending);
    let attempt = { ...original, phase: "sending" as const };
    try { saveAttempt(attempt); }
    catch {
      setSendError(new ApiError(400, "chat-storage", "Could not keep the message for recovery"));
      return;
    }
    if (recovered.operation && store.drafts[draftKey] === undefined) store.put(draftKey, recovered.operation.submitted);
    store.put(deliveryKey, { ...initial, operation: attempt });
    setSendError(null);
    setPreserved(false);
    const current = () => generation === getClientScope() && getDelivery()?.operation === attempt;
    const post = () => action.mutateAsync({
      path: sessionUrl + "/messages",
      body: attempt.body,
      operationId: attempt.operationId,
    });

    try {
      let receipt: Control["TurnReceipt"];
      try {
        receipt = await post();
      } catch (error) {
        if (!current() || !isStaleChatSend(error)) throw error;
        const latest = await remoteGet<Control["SessionRecord"]>(sessionUrl).catch(() => undefined);
        if (!current() || !latest) throw error;
        const known = queryClient.getQueryData<Control["SessionRecord"]>(sessionKey);
        const fresh = known && (known.version > latest.version ||
          known.version === latest.version && known.sessionEventCursor > latest.sessionEventCursor) ? known : latest;
        queryClient.setQueryData(sessionKey, fresh);
        // A known rejection can be retried once after proving the previous turn
        // finished. An unknown delivery may only replay its original request.
        if (original.phase !== "sending" || useDraftStore.getState().drafts[draftKey] !== original.submitted ||
            fresh.version <= attempt.body.expectedSessionVersion || fresh.state !== "idle" ||
            !initial?.lastTurn || attempt.body.expectedSessionVersion < initial.lastTurn.before.version ||
            !ownChatTurnCandidate(initial.lastTurn, fresh)) throw error;
        const turn = initial.lastTurn;
        const proved = await queryClient.fetchQuery({
          queryKey: chatTurnProofKey(hub.scopeKey, turn, fresh),
          queryFn: ({ signal }) => proveOwnChatTurn(turn, fresh, sessionUrl, signal),
          retry: false,
          staleTime: Infinity,
        }).catch(() => false);
        if (!current() || !proved || useDraftStore.getState().drafts[draftKey] !== original.submitted) throw error;
        const retry = {
          ...attempt,
          before: fresh,
          body: { ...attempt.body, expectedSessionVersion: fresh.version },
          operationId: crypto.randomUUID(),
        };
        // The old operation was definitively refused before the new key exists.
        try {
          writePending(chatScope, null, validatePending);
          saveAttempt(retry);
        } catch { throw new ApiError(400, "chat-storage", "Could not keep the message for recovery"); }
        attempt = retry;
        store.put(deliveryKey, { ...initial, operation: attempt });
        receipt = await post();
      }
      if (!current()) return;
      if (!receipt || !["admitted", "queued", "rejected"].includes(receipt.status) ||
          receipt.sessionId !== record.sessionId || typeof receipt.operationId !== "string" ||
          !receipt.operationId) {
        throw new ApiError(502, "invalid-response", "Invalid message receipt");
      }
      writePending(chatScope, null, validatePending);
      const lastTurn = attempt.before && ownChatTurn(attempt.before, receipt);
      store.put(deliveryKey, { ...initial, operation: undefined, ...(lastTurn && { lastTurn }) });
      if (receipt.status === "rejected") {
        setSendError(new ApiError(400, "message-rejected", "Message was not accepted"));
        return;
      }
      // Keep a known acceptance visible even if the read-model refresh failed.
      // An authoritative row may already be newer than the POST receipt.
      queryClient.setQueryData<MessageDeliveries>(messageDeliveriesKey(hub.scopeKey, record.projectId, record.sessionId), previous => {
        if (previous?.deliveries?.some(item => item.operationId === receipt.operationId)) return previous;
        const accepted: MessageDeliveries["deliveries"][number] = {
          operationId: receipt.operationId, submittedAt: new Date().toISOString(),
          afterCursor: attempt.before?.historyCursor ?? record.historyCursor,
          text: attempt.body.text, runId: receipt.runId ?? null, turnId: receipt.turnId ?? null,
          status: "hub-accepted", queued: false, reason: null,
        };
        return { deliveries: [...(previous?.deliveries ?? []), accepted].slice(-60) };
      });
      const latestDraft = useDraftStore.getState().drafts[draftKey];
      if (latestDraft === original.submitted) {
        store.put(draftKey, { ...original.submitted, text: "", prepared: false });
      } else if (latestDraft !== undefined) {
        setPreserved(true);
      }
    } catch (error) {
      if (!current()) return;
      const unknown = isUncertainChatSend(error) ||
        original.phase === "unknown" && error instanceof ApiError &&
          (error.code === "recovery-required" || error.status === 403);
      if (!unknown) {
        try { writePending(chatScope, null, validatePending); }
        catch {
          store.put(deliveryKey, { ...initial, operation: { ...attempt, phase: "unknown" } });
          setSendError(new ApiError(400, "chat-storage", "Could not clear the stored message"));
          return;
        }
      }
      store.put(deliveryKey, { ...initial, operation: unknown ? { ...attempt, phase: "unknown" } : undefined });
      if (!unknown) setSendError(error);
    }
  }

  function submit() {
    if (openDraftCommand()) return;
    const assoc=association();
    if(nativeOperation||nativePending.error||delivery.operation||delivery.storageError||waitingForReply||awaitingMachine)return;
    if(draft.prepared)return;
    if(!control.binding||!control.active||stale||!assoc||!draft.text.trim()) {setValidation(t('required'));return;}
    if(mode==='managed'&&!managed.hint){setValidation(workT('staleAttempt'));return;}
    const submitted=draft;
    const body={expectedSessionVersion:sessionVersion,controller:control.binding,expectedConfigVersion:submitted.configVersion,text:submitted.text,interpretation:'literal-message',association:assoc,busyPolicy:submitted.busyPolicy} satisfies Control['MessageSubmit'];
    if(mode==='managed'&&managed.hint){
      if(assoc.mode!=='ad-hoc'){setValidation(workT('nativeConsentRequired'));return;}
      const original:NativeSubmission={scope:nativeScope,operationId:crypto.randomUUID(),path:sessionPath(record.projectId,record.sessionId)+'/messages',body:structuredClone(body),hint:Object.freeze({...managed.hint}),phase:'sending'};
      sendNative(original,submitted);
    } else {
      void sendChat({ scope: chatScope, path: chatPath, operationId: crypto.randomUUID(), before: record, body, submitted, phase: "sending" });
    }
  }

  const canSend = record.state !== "opening" && record.state !== "recovery-required" && record.state !== "closed" &&
    control.active && !stale && !waitingForReply && !awaitingMachine && !delivery.operation && !delivery.storageError && !action.isPending && !nativeOperation && !nativePending.error &&
    (mode !== "managed" || managed.valid) && !!draft.text.trim() && !!association();

  return (
    <ChatComposerFrame title={t("message")}>
      {record.state === "opening" || record.state === "recovery-required" ? (
        <Notice>{t(record.state === "opening" ? "sessionNotOpen" : "sessionNeedsRecovery")}</Notice>
      ) : control.claimPending ? <Notice>{t("controlApplying")}</Notice> : !control.active && !record.controller && (
        <Notice>{t("observer")} {control.operator && <a href="#session-controller" className="underline">{t("goToController")}</a>}</Notice>
      )}
      <span id={commandsId + "-hint"} className="sr-only">{t("commandsHint")}</span>
      <Field label={<span className="sr-only">{t("message")}</span>}>
        <Textarea ref={editor} aria-describedby={commandsId + "-hint"}
          value={draft.text}
          rows={2}
          placeholder={t("messagePlaceholder")}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
              if (openDraftCommand()) {
                event.preventDefault();
                return;
              }
              if (canSend && !event.repeat && !window.matchMedia?.("(max-width: 767px), (pointer: coarse)").matches) {
                event.preventDefault();
                submit();
              }
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
      <ChatToolbar model={slots?.model} usage={slots?.usage} commands={
        <Button
          ref={commandTrigger}
          variant="secondary"
          aria-label={t("commands")}
          title={t("commandsHint")}
          aria-expanded={commands === "open"}
          aria-controls={commands === "unopened" ? undefined : commandsId}
          onClick={(event) => commands === "open" ? closeCommands() : openCommands(undefined, event.currentTarget)}
        >
          <span aria-hidden="true">/</span>
        </Button>
      } action={<>
        <span className="chat-stop-slot" ref={slots?.stopTargetRef} />
        {(!slots || !record.activeRunId || canSend) &&
          <ChatAction kind="send" label={t("send")} disabled={!canSend} onClick={submit} />}
      </>} />
      {commands !== "unopened" && (
        <div className="chat-native-command-picker" id={commandsId} hidden={commands !== "open"}
          onPointerDownCapture={() => { slashOpened.current = null; }}
          onChangeCapture={() => { slashOpened.current = null; }}
          onKeyDown={(event) => {
          if (event.key !== "Escape") { slashOpened.current = null; return; }
          if (event.defaultPrevented) return;
          const field = slashOpened.current;
          closeCommands();
          if (field && !draft.text) { editText("/"); field.focus(); }
        }}>
          <div className="composer-command-actions">
            {chatCommandShortcuts.map(shortcut => (
              <Button key={shortcut} variant="ghost" onClick={() => openCommandShortcut(shortcut, commandTrigger.current)}>
                {shortcut}
              </Button>
            ))}
          </div>
          <Commands record={record} control={control} onOutcome={onCommandOutcome}
            visible={commands === "open"} focusToken={focusToken} initialSearch={commandShortcut}
            confirmationTarget={slots?.approvalDock} />
        </div>
      )}
      <details open={contextOpen} onToggle={event => setContextOpen(event.currentTarget.open)} className="composer-work-context">
        <summary>{mode === "flow" && selected ? t("chatFlowContext", { title: selected.title })
          : mode === "ad-hoc" && association() ? t("chatWithoutFlow")
            : t("chatWorkContext")}</summary>
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
      {mode === "flow" && (
        <details className="composer-pins">
          <summary>{t("pins")}</summary>
          <Definition label={t("pins")}>
            {draft.specDigest || "—"}
            <br />
            {draft.criteriaDigest || "—"}
          </Definition>
        </details>
      )}
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
          <p className="composer-hint">{t("secretWarning")}</p>
          {mode === "managed" && action.data?.status === "admitted" && <ActionFeedback action={action} />}
        </details>
      </div>
      </details>
      {nativePending.error&&<Notice tone="error">{workT("pendingStorageError")}</Notice>}
      {nativeOperation && <Notice>{workT(nativeOperation.phase==='sending'?"pending":"nativeOutcomeUnknown")}<p>{workT("operation")}: <code>{nativeOperation.operationId}</code></p><p>{workT("managedAttempt")}: <code>{nativeOperation.hint.attemptId}</code> · v{nativeOperation.hint.attemptVersion}</p>{nativeOperation.phase==='unknown'&&<Button variant="secondary" disabled={!managed.operator||!control.active||action.isPending} onClick={()=>sendNative(nativeOperation,undefined,true)}>{workT("retryOriginalMessage")}</Button>}</Notice>}
      {delivery.storageError && <Notice tone="error">{t("chatStorageError")}</Notice>}
      {delivery.operation?.phase === "sending" && <Notice>{t("sendingChatMessage")}</Notice>}
      {delivery.operation?.phase === "unknown" && (
        <Notice tone="error">
          <p>{t("chatDeliveryUnknown")}</p>
          <Button variant="secondary" disabled={!control.operator} onClick={() => delivery.operation && void sendChat(delivery.operation)}>
            {t("retryOriginalChatMessage")}
          </Button>
        </Notice>
      )}
      {awaitingMachine && draft.text && !delivery.operation && <p role="status" className="composer-hint">{t("chatAwaitingMachine")}</p>}
      {waitingForReply && !awaitingMachine && draft.text && !delivery.operation && <p role="status" className="composer-hint">{t("chatWaitingToSend")}</p>}
      {checkingTurn && !delivery.operation && <p role="status" className="composer-hint">{t("chatCheckingPreviousTurn")}</p>}
      {stale && !checkingTurn && !delivery.operation && (
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
      {sendError != null && <Notice tone="error">{sendError instanceof ApiError && sendError.code === "message-rejected"
        ? t("chatMessageRejected") : sendError instanceof ApiError && sendError.code === "chat-storage"
          ? t("chatStorageError") : errorMessage(sendError)} {t("chatDraftKept")}</Notice>}
      {mode === "managed" && action.data?.status !== "admitted" && <ActionFeedback action={action} />}
      <p className="composer-keyboard-hint">{t("composerKeyboardHint")}</p>
    </ChatComposerFrame>
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
