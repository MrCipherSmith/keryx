import { useState } from "react";
import type { CommandView, ViewAction, ViewField } from "../acp/types";
import { fillTemplate, initialValues, missingRequired, type FieldValues } from "../acp/commands";
import { Icon } from "../components/Icon";
import { Dialog } from "../components/ui";
import type { CommandItem } from "./reducer";

export type RunCommand = (line: string, opts: { display?: string; replaceId: number }) => void | Promise<unknown>;

/** A slash command in the transcript: its line and output, collapsible; a refusal reads as a notice. */
export function CommandCard({ item, onRun }: { item: CommandItem; onRun?: RunCommand }) {
  const [open, setOpen] = useState(true);
  const hasBody = item.text.trim() !== "" || item.view !== null;
  return (
    <div className={`command-card${item.refused ? " is-refused" : ""}${open ? " is-open" : ""}`}>
      <button className="command-head" onClick={() => setOpen((o) => !o)} aria-expanded={hasBody ? open : undefined} disabled={!hasBody}>
        <Icon name="command" size={13} />
        <span className="command-line mono truncate">{item.line}</span>
        {item.refused ? <span className="badge badge-warn">refused</span> : null}
        {hasBody ? <Icon name={open ? "chevronDown" : "chevronRight"} size={13} /> : null}
      </button>
      {open && hasBody ? (
        <div className="command-body">
          {/* A view carries the same content as `text` (keryx's plain rendering for editors); show one. */}
          {item.text.trim() !== "" && (item.view === null || item.refused) ? (
            item.refused ? (
              <div className="notice notice-warn" role="status">
                <Icon name="alert" size={14} />
                <span>{item.text}</span>
              </div>
            ) : (
              <pre className="out-pre command-out">{item.text}</pre>
            )
          ) : null}
          {item.view ? <CommandViewPanel view={item.view} itemId={item.id} onRun={onRun} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Generic renderer for `_meta.keryx.view`: rows with actions, optional body text and form. */
export function CommandViewPanel({ view, itemId, onRun }: { view: CommandView; itemId: number; onRun?: RunCommand }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<ViewAction | null>(null);

  const run = async (line: string, display?: string) => {
    if (!onRun || busy) return;
    setBusy(true);
    try {
      await onRun(line, { display, replaceId: itemId });
    } finally {
      setBusy(false);
    }
  };

  const act = (a: ViewAction) => {
    if (a.confirm) setConfirming(a);
    else void run(a.command);
  };

  return (
    <div className="command-view">
      <div className="command-view-title">{view.title}</div>
      {view.rows && view.rows.length > 0 ? (
        <ul className="command-rows">
          {view.rows.map((r) => (
            <li key={r.id} className="command-row">
              <div className="command-row-main">
                <span className="command-row-label">{r.label}</span>
                {r.detail ? <span className="command-row-detail">{r.detail}</span> : null}
              </div>
              {r.status ? <span className="badge badge-neutral">{r.status}</span> : null}
              {(r.actions ?? []).map((a) => (
                <button key={a.label + a.command} className="btn btn-sm" disabled={!onRun || busy} onClick={() => act(a)}>
                  {a.label}
                </button>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {view.body ? <pre className="out-pre command-out">{view.body}</pre> : null}
      {view.form ? <ViewFormPanel form={view.form} disabled={!onRun || busy} onSubmit={(line, display) => void run(line, display)} /> : null}
      {confirming ? (
        <Dialog
          title="Confirm"
          icon="alert"
          tone="warn"
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                data-autofocus
                onClick={() => {
                  const a = confirming;
                  setConfirming(null);
                  void run(a.command);
                }}
              >
                {confirming.label}
              </button>
            </>
          }
        >
          <p>{confirming.confirm}</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function ViewFormPanel({ form, disabled, onSubmit }: { form: NonNullable<CommandView["form"]>; disabled: boolean; onSubmit: (line: string, display: string) => void }) {
  const [values, setValues] = useState<FieldValues>(() => initialValues(form.fields));
  const set = (id: string, v: string | boolean) => setValues((x) => ({ ...x, [id]: v }));
  const missing = missingRequired(form.fields, values);
  const submit = () => {
    if (missing.length > 0) return;
    onSubmit(fillTemplate(form.submit, form.fields, values), fillTemplate(form.submit, form.fields, values, true));
    // A secret never lingers in the form once it is sent.
    setValues((x) => {
      const next = { ...x };
      for (const f of form.fields) if (f.kind === "secret") next[f.id] = "";
      return next;
    });
  };
  return (
    <form
      className="command-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) submit();
      }}
    >
      {form.fields.map((f) => (
        <FieldInput key={f.id} field={f} value={values[f.id]} onChange={(v) => set(f.id, v)} disabled={disabled} />
      ))}
      <div>
        <button type="submit" className="btn btn-sm btn-primary" disabled={disabled || missing.length > 0}>
          {form.submitLabel ?? "Submit"}
        </button>
        {missing.length > 0 ? (
          <span className="field-hint" role="note">
            Fill in {missing.map((f) => f.label).join(", ")} first.
          </span>
        ) : null}
      </div>
    </form>
  );
}

function FieldInput({ field, value, onChange, disabled }: { field: ViewField; value: string | boolean | undefined; onChange: (v: string | boolean) => void; disabled: boolean }) {
  const id = `cf-${field.id}`;
  if (field.kind === "toggle") {
    return (
      <label className="field-check" htmlFor={id}>
        <input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {field.kind === "choice" ? (
        <select id={id} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => {
            const v = typeof o === "string" ? o : o.value;
            const l = typeof o === "string" ? o : (o.label ?? o.value);
            return (
              <option key={v} value={v}>
                {l}
              </option>
            );
          })}
        </select>
      ) : (
        <input
          id={id}
          type={field.kind === "secret" ? "password" : "text"}
          autoComplete={field.kind === "secret" ? "off" : undefined}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          aria-required={field.required ? true : undefined}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
