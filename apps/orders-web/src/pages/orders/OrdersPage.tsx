import { useState } from "react";
import { DownloadOutlined } from "@ant-design/icons";
import type { OrderStatus } from "../../api/orders.api";
import { useMessages } from "../../i18n";
import { CreateOrderForm } from "./CreateOrderForm";
import { OrderDrawer } from "./OrderDrawer";
import { OrderRow } from "./OrderRow";
import { ordersMessages, type OrdersMessageKey } from "./orders.messages";
import { useOrders } from "./useOrders";
import "./orders.css";

const STATUSES: { value: OrderStatus; label: OrdersMessageKey }[] = [
  { value: "new", label: "statusNew" },
  { value: "paid", label: "statusPaid" },
  { value: "shipped", label: "statusShipped" },
  { value: "delivered", label: "statusDelivered" },
  { value: "cancelled", label: "statusCancelled" },
];

export function OrdersPage() {
  const t = useMessages(ordersMessages);
  const [status, setStatus] = useState<OrderStatus | undefined>();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const orders = useOrders(status, query, reloadKey);

  return (
    <div className="font-sans mx-auto max-w-4xl px-4 py-8">
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-display text-[28px] text-ink">{t("title")}</h1>
        <button type="button" onClick={() => window.open("/api/orders/export")} className="min-h-11 min-w-11 text-ink">
          <DownloadOutlined />
        </button>
      </header>

      <input
        type="search"
        className="orders-search mt-4"
        aria-label={t("searchLabel")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="status-chip" aria-pressed={status === undefined} onClick={() => setStatus(undefined)}>
          {t("statusAll")}
        </button>
        {STATUSES.map((s) => (
          <button key={s.value} type="button" className="status-chip" aria-pressed={status === s.value} onClick={() => setStatus(s.value)}>
            {t(s.label)}
          </button>
        ))}
      </div>

      <section className="mt-6 rounded-panel border border-line bg-surface">
        <CreateOrderForm onCreated={() => setReloadKey((k) => k + 1)} />
        {orders.loading && <p className="px-4 py-3 text-muted">{t("loading")}</p>}
        {orders.failed && (
          <p role="alert" className="px-4 py-3 text-danger">
            {t("loadError")}
          </p>
        )}
        {!orders.loading &&
          orders.items.map((order) => (
            <OrderRow key={order.id} order={order} onOpen={setOpenId} onDelete={orders.remove} />
          ))}
      </section>

      {openId && <OrderDrawer orderId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
