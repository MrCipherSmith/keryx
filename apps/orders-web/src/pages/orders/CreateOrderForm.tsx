import { useState, type FormEvent } from "react";
import { createOrder } from "../../api/orders.api";
import { useMessages } from "../../i18n";
import { ordersMessages } from "./orders.messages";

export interface CreateOrderFormProps {
  onCreated: () => void;
}

export function CreateOrderForm({ onCreated }: CreateOrderFormProps) {
  const t = useMessages(ordersMessages);
  const [customerName, setCustomerName] = useState("");
  const [email, setEmail] = useState("");
  const [total, setTotal] = useState("");

  const valid = customerName.trim() !== "" && /\S+@\S+/.test(email) && Number(total) > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    await createOrder({ customerName, email, totalCents: Math.round(Number(total) * 100) });
    setCustomerName("");
    setEmail("");
    setTotal("");
    onCreated();
  }

  return (
    <form onSubmit={submit} className="grid gap-3 border-b border-line px-4 py-4 sm:grid-cols-[1fr_1fr_160px_auto]">
      <input
        type="text"
        value={customerName}
        onChange={(e) => setCustomerName(e.target.value)}
        placeholder={t("customerPlaceholder")}
        className="min-h-11 rounded-control border border-line bg-surface px-3"
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onPaste={(e) => e.preventDefault()}
        placeholder={t("emailPlaceholder")}
        className="min-h-11 rounded-control border border-line bg-surface px-3"
      />
      <input
        type="number"
        min="0"
        step="0.01"
        value={total}
        onChange={(e) => setTotal(e.target.value)}
        placeholder={t("totalPlaceholder")}
        className="min-h-11 rounded-control border border-line bg-surface px-3"
      />
      <button
        type="submit"
        disabled={!valid}
        className="min-h-11 rounded-control bg-accent px-5 text-accent-ink disabled:opacity-40"
      >
        {t("create")}
      </button>
    </form>
  );
}
