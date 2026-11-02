import {
  cloneElement,
  isValidElement,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
const inputClass = "hub-input";
export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  return (
    <button
      type={type}
      className={"hub-button hub-button-" + variant + " " + className}
      {...props}
    />
  );
}
export function Panel({
  title,
  description,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"hub-panel " + className}>
      {(title || description) && (
        <header className="hub-panel-header">
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </header>
      )}
      <div className="hub-panel-body">{children}</div>
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const generatedId = useId();
  const control = isValidElement<{ id?: string; "aria-describedby"?: string }>(
    children,
  )
    ? (children as ReactElement<{ id?: string; "aria-describedby"?: string }>)
    : null;
  const id = control?.props.id ?? generatedId;
  const hintId = generatedId + "-hint";
  const description =
    [control?.props["aria-describedby"], hint ? hintId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {control
        ? cloneElement(control, { id, "aria-describedby": description })
        : children}
      {hint && (
        <p id={hintId} className="text-xs leading-relaxed text-slate-500">
          {hint}
        </p>
      )}
    </div>
  );
}
export function Input({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={inputClass + " " + className} {...props} />;
}
export function Select({
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={inputClass + " " + className} {...props} />;
}
export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={inputClass + " min-h-28 resize-y " + className}
      {...props}
    />
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "error" | "success" | "info";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        "break-words rounded-xl border px-4 py-3 text-sm " +
        {
          error: "border-red-200 bg-red-50 text-red-800",
          success: "border-emerald-200 bg-emerald-50 text-emerald-900",
          info: "border-sky-200 bg-sky-50 text-sky-900",
        }[tone]
      }
    >
      {children}
    </div>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("common");
  const good = ["accepted", "done", "published"].includes(status),
    bad = ["failed", "conflict", "rejected"].includes(status);
  return (
    <span
      className={
        "inline-flex shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold " +
        (good
          ? "bg-emerald-50 text-emerald-800"
          : bad
            ? "bg-red-50 text-red-700"
            : "bg-slate-100 text-slate-600")
      }
    >
      {t("status." + status, { defaultValue: status })}
    </span>
  );
}
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-5 py-9 text-center text-sm leading-relaxed text-slate-500">
      {children}
    </div>
  );
}
export function PageHeading({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="hub-page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  );
}
export function QueryState({
  query,
  children,
}: {
  query: { isPending: boolean; error: unknown; refetch: () => unknown };
  children: ReactNode;
}) {
  const { t } = useTranslation("common");
  if (query.isPending) return <EmptyState>{t("loading")}</EmptyState>;
  if (query.error)
    return (
      <Notice tone="error">
        {t("errors.unknown")}{" "}
        <Button variant="secondary" onClick={() => void query.refetch()}>
          {t("retry")}
        </Button>
      </Notice>
    );
  return <>{children}</>;
}
