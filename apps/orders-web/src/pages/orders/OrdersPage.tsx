import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import { Alert, Button, Drawer, Select, Space, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import * as ordersApi from "../../api/orders.api";
import type { OrderStatus } from "../../api/orders.api";
import { OrdersStore } from "../../stores/orders.store";
import { OrderDrawer } from "./OrderDrawer";
import { OrdersTable } from "./OrdersTable";

const STATUS_OPTIONS: { value: OrderStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "paid", label: "Paid" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
];

export const OrdersPage = observer(function OrdersPage() {
  const store = new OrdersStore(ordersApi);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compact, setCompact] = useState(window.innerWidth < 900);

  useEffect(() => {
    store.loadOrders();
  }, []);

  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
  }, []);

  return (
    <>
      <Typography.Title level={3}>Orders</Typography.Title>
      <Space style={{ marginBottom: 12 }}>
        <Select<OrderStatus>
          allowClear
          placeholder="All statuses"
          style={{ width: 180 }}
          options={STATUS_OPTIONS}
          value={store.status}
          onChange={(status) => store.setStatus(status)}
        />
        <Button icon={<ReloadOutlined />} onClick={() => store.loadOrders()} />
        <Button
          disabled={store.selectedCount === 0}
          loading={store.updating}
          onClick={() => store.markSelectedPaid()}
        >
          Mark {store.selectedCount} as paid
        </Button>
      </Space>
      {store.error && <Alert type="error" message={store.error} />}
      <OrdersTable store={store} selectedId={selectedId} compact={compact} onOpen={setSelectedId} />
      <Drawer open={selectedId !== null} width={480} onClose={() => setSelectedId(null)}>
        {selectedId !== null && <OrderDrawer orderId={selectedId} store={store} />}
      </Drawer>
    </>
  );
});
