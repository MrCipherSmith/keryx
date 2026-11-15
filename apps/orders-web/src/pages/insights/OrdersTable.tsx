import type { OrderDto } from "../../api/orders.api";
import { useLocale, useMessages } from "../../i18n";
import { CustomerCell } from "./CustomerCell";
import { insightsMessages } from "./insights.messages";
import { OrderNumber } from "./OrderNumber";

export interface OrdersTableProps {
  orders: OrderDto[];
}

export function OrdersTable({ orders }: OrdersTableProps) {
  const t = useMessages(insightsMessages);
  const locale = useLocale();
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });

  return (
    <div className="w-[720px]" data-measure="orders-table">
      <table className="w-full border-collapse text-start">
        <thead>
          <tr className="border-b border-line text-[14px] text-muted">
            <th scope="col" className="py-2 text-start font-medium">{t("colNumber")}</th>
            <th scope="col" className="py-2 text-start font-medium">{t("colCustomer")}</th>
            <th scope="col" className="py-2 text-end font-medium">{t("colTotal")}</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} className="border-b border-line">
              <td className="py-3">
                <OrderNumber value={order.number} />
              </td>
              <td className="py-3 pe-4">
                <CustomerCell name={order.customer?.name ?? t("guest")} badge={order.status} />
              </td>
              <td className="py-3 text-end tabular-nums">{money.format(order.totalCents / 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
