import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Square } from "lucide-react";
import { Button, Panel, Select } from "../../components/ui";
import type { LiveShellUsage } from "../../../../../src/remote-control/live-shell";

export function ChatConversation({ transcript, approval, composer }: {
  transcript: ReactNode;
  approval?: ReactNode;
  composer: ReactNode;
}) {
  return <div className="session-conversation-column">
    {transcript}
    <div className="chat-dock">
      {approval}
      <div className="session-composer">{composer}</div>
    </div>
  </div>;
}

export function ChatComposerFrame({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return <Panel title={title} className="chat-composer-frame">{children}</Panel>;
}

export function ChatToolbar({ commands, model, usage, action }: {
  commands?: ReactNode;
  model?: ReactNode;
  usage?: ReactNode;
  action: ReactNode;
}) {
  return <div className="chat-toolbar">
    <div className="chat-tools">{commands}{model}{usage}</div>
    <div className="chat-primary">{action}</div>
  </div>;
}

export function ChatAction({ kind, label, disabled, onClick, type = "button" }: {
  kind: "send" | "stop";
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  const Icon = kind === "send" ? ArrowUp : Square;
  return <Button type={type} className="composer-send" variant={kind === "stop" ? "secondary" : "primary"}
    aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    <Icon className="composer-send-icon" size={18} aria-hidden="true" />
    <span className="composer-send-label">{label}</span>
  </Button>;
}

export type ModelOption = { id: string; label: string; disabled?: boolean };

export function ChatModelPicker({ value, candidates, disabled, onSelect }: {
  value: string;
  candidates: ModelOption[];
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("remote");
  const id = useId();
  return <div className="chat-model-picker">
    <label htmlFor={id} className="sr-only">{t("chatModel")}</label>
    <Select id={id} value={value} disabled={disabled || !candidates.length} onChange={event => onSelect(event.target.value)}>
      {!candidates.some(candidate => candidate.id === value) && <option value={value}>{t("chatModel")}</option>}
      {candidates.map(candidate => <option key={candidate.id} value={candidate.id} disabled={candidate.disabled}>{candidate.label}</option>)}
    </Select>
  </div>;
}

export type ChatUsageSnapshot = {
  turn?: LiveShellUsage | null;
  session?: LiveShellUsage | null;
  incomplete?: boolean;
};

export function ChatUsage({ usage, busy, unavailable, onOpen }: {
  usage?: ChatUsageSnapshot;
  busy?: boolean;
  unavailable?: boolean;
  onOpen?: () => void;
}) {
  const { t, i18n } = useTranslation("remote");
  const groups = [["chatUsageTurn", usage?.turn], ["chatUsageSession", usage?.session]] as const;
  const counts = new Intl.NumberFormat(i18n.language);
  const time = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  return <details className="chat-usage" onToggle={event => { if (event.currentTarget.open) onOpen?.(); }}>
    <summary>{t("chatUsage")}</summary>
    <div className="chat-usage-card">
      {busy && !usage && <p>{t("chatUsageLoading")}</p>}
      {unavailable && <p>{t("chatUsageUnavailable")}</p>}
      {!busy && !unavailable && !usage?.turn && !usage?.session && <p>{t("chatUsageEmpty")}</p>}
      {usage?.incomplete && <p>{t("chatUsagePartial")}</p>}
      {groups.map(([label, value]) => value && <div key={label}>
        <h3>{t(label)}</h3>
        <dl>
          <dt>{t("chatUsageInput")}</dt><dd>{counts.format(value.tokensIn)}</dd>
          <dt>{t("chatUsageOutput")}</dt><dd>{counts.format(value.tokensOut)}</dd>
          <dt>{t("chatUsageCacheRead")}</dt><dd>{counts.format(value.cacheRead)}</dd>
          <dt>{t("chatUsageCacheWrite")}</dt><dd>{counts.format(value.cacheWrite)}</dd>
          <dt>{t("chatUsageDuration")}</dt><dd>{t("chatUsageSeconds", { value: time.format(value.activeMs / 1000) })}</dd>
        </dl>
      </div>)}
    </div>
  </details>;
}
