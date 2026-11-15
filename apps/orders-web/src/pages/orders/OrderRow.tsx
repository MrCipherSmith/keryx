import { DeleteOutlined } from "@ant-design/icons";
import type { OrderDto, OrderStatus } from "../../api/orders.api";
import { useLocale, useMessages } from "../../i18n";
import { ordersMessages } from "./orders.messages";

const DOT: Record<OrderStatus, string> = {
  new: "bg-ink",
  paid: "bg-sage",
  shipped: "bg-accent",
  delivered: "bg-sage",
  cancelled: "bg-line",
};

export interface OrderRowProps {
  order: OrderDto;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function OrderRow({ order, onOpen, onDelete }: OrderRowProps) {
  const t = useMessages(ordersMessages);
  const locale = useLocale();
  const total = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(order.totalCents / 100);

  return (
    <div
      className="grid cursor-pointer grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-line px-4 py-2 hover:bg-surface"
      onClick={() => onOpen(order.id)}
    >
      <span className="font-medium text-ink">{order.number}</span>
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[order.status]}`} />
      <span className="tabular-nums text-[#9ca3af]">{total}</span>
      <div onClick={(e) => e.stopPropagation()}>
        <button type="button" className="order-action" onClick={() => onDelete(order.id)}>
          <DeleteOutlined /> {t("delete")}
        </button>
      </div>
    </div>
  );
}
