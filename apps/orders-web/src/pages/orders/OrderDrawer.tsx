import { useEffect, useState } from "react";
import { CloseOutlined } from "@ant-design/icons";
import { getOrder, type OrderDto } from "../../api/orders.api";
import { useLocale, useMessages } from "../../i18n";
import { ordersMessages } from "./orders.messages";

export interface OrderDrawerProps {
  orderId: string;
  onClose: () => void;
}

export function OrderDrawer({ orderId, onClose }: OrderDrawerProps) {
  const t = useMessages(ordersMessages);
  const locale = useLocale();
  const [order, setOrder] = useState<OrderDto | null>(null);

  useEffect(() => {
    setOrder(null);
    getOrder(orderId)
      .then(setOrder)
      .catch(() => {});
  }, [orderId]);

  return (
    <aside
      role="dialog"
      aria-label={t("drawerLabel")}
      className="drawer-panel fixed inset-y-0 end-0 w-full max-w-sm border-s border-line bg-surface p-5 shadow-xl"
    >
      <button
        type="button"
        aria-label={t("close")}
        onClick={onClose}
        className="absolute end-3 top-3 flex h-4 w-4 items-center justify-center text-ink"
      >
        <CloseOutlined />
      </button>
      {order ? (
        <dl className="mt-6 space-y-4">
          <h2 className="font-display text-[28px] text-ink">{order.number}</h2>
          <div>
            <dt className="text-[14px] text-muted">{t("drawerCustomer")}</dt>
            <dd>{order.customer?.name ?? t("guest")}</dd>
          </div>
          <div>
            <dt className="text-[14px] text-muted">{t("drawerTotal")}</dt>
            <dd>{new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(order.totalCents / 100)}</dd>
          </div>
          <div>
            <dt className="text-[14px] text-muted">{t("drawerCreated")}</dt>
            <dd>{new Date(order.createdAt).toLocaleDateString(locale)}</dd>
          </div>
        </dl>
      ) : (
        <div className="mt-6 space-y-4" aria-hidden="true">
          <div className="h-7 w-2/3 rounded-control bg-line" />
          <div className="h-4 w-1/2 rounded-control bg-line" />
          <div className="h-4 w-1/3 rounded-control bg-line" />
        </div>
      )}
    </aside>
  );
}
