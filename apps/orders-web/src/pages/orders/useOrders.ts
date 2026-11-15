import { useCallback, useEffect, useState } from "react";
import { listOrders, removeOrder, type OrderDto, type OrderStatus } from "../../api/orders.api";

export function useOrders(status: OrderStatus | undefined, query: string, reloadKey = 0) {
  const [items, setItems] = useState<OrderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    listOrders({ status, query, pageSize: 200 })
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, query, reloadKey]);

  const remove = useCallback(async (id: string) => {
    await removeOrder(id);
    setItems((prev) => prev.filter((o) => o.id !== id));
  }, []);

  return { items, loading, failed, remove };
}
