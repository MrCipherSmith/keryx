import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { getOrderNotes, saveOrderNotes } from "../../api/orders.api";
import { useMessages } from "../../i18n";
import { notesMessages } from "./notes.messages";

const MAX_LENGTH = 2000;

type LoadState = "loading" | "ready" | "failed";
type SaveState = "idle" | "saving" | "saved" | "failed";

export interface OrderNotesProps {
  orderId: string;
}

export function OrderNotes({ orderId }: OrderNotesProps) {
  const t = useMessages(notesMessages);
  const fieldId = useId();
  const [text, setText] = useState("");
  const [load, setLoad] = useState<LoadState>("loading");
  const [save, setSave] = useState<SaveState>("idle");

  const fetchNotes = useCallback(() => {
    setLoad("loading");
    getOrderNotes(orderId)
      .then((value) => {
        setText(value);
        setLoad("ready");
      })
      .catch(() => setLoad("failed"));
  }, [orderId]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSave("saving");
    try {
      await saveOrderNotes(orderId, text);
      setSave("saved");
    } catch {
      setSave("failed");
    }
  }

  if (load === "loading") {
    return (
      <p role="status" className="text-muted">
        {t("loading")}
      </p>
    );
  }

  if (load === "failed") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-danger">
        <span>{t("loadError")}</span>
        <button
          type="button"
          onClick={fetchNotes}
          className="min-h-11 rounded-control border border-line bg-surface px-4 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t("retry")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label htmlFor={fieldId} className="block font-medium text-ink">
        {t("label")}
      </label>
      <p id={`${fieldId}-hint`} className="text-[14px] text-muted">
        {text === "" ? t("empty") : t("hint")}
      </p>
      <textarea
        id={fieldId}
        value={text}
        maxLength={MAX_LENGTH}
        rows={5}
        aria-describedby={`${fieldId}-hint ${fieldId}-count`}
        onChange={(e) => {
          setText(e.target.value);
          setSave("idle");
        }}
        className="w-full rounded-control border border-line bg-surface p-3 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      <p id={`${fieldId}-count`} className="text-[14px] text-muted">
        {t("counter", { count: text.length, max: MAX_LENGTH })}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          aria-busy={save === "saving"}
          className="min-h-11 rounded-control bg-accent px-5 text-accent-ink motion-safe:transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {save === "saving" ? t("saving") : t("save")}
        </button>
        <p role="status" className={save === "failed" ? "text-danger" : "text-sage"}>
          {save === "saved" && t("saved")}
          {save === "failed" && t("saveError")}
        </p>
      </div>
    </form>
  );
}
