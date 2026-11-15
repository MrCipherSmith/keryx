import { useMemo, useState, type ReactNode } from "react";
import { Button, Checkbox, Dropdown, Spin } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import type { OrderDto } from "../../api/orders.api";
import { StatusTag } from "../../components/StatusTag";
import type { OrdersStore } from "../../stores/orders.store";

type ColumnKey = "number" | "customer" | "status" | "total" | "createdAt";

interface ColumnDef {
  key: ColumnKey;
  title: string;
  sortValue: (order: OrderDto) => string | number;
  render: (order: OrderDto) => ReactNode;
}

const COLUMN_DEFS: ColumnDef[] = [
  { key: "number", title: "Number", sortValue: (o) => o.number, render: (o) => o.number },
  {
    key: "customer",
    title: "Customer",
    sortValue: (o) => o.customer?.name ?? "",
    render: (o) => o.customer?.name ?? "Guest",
  },
  { key: "status", title: "Status", sortValue: (o) => o.status, render: (o) => <StatusTag status={o.status} /> },
  {
    key: "total",
    title: "Total",
    sortValue: (o) => o.totalCents,
    render: (o) => (o.totalCents / 100).toFixed(2),
  },
  { key: "createdAt", title: "Created", sortValue: (o) => o.createdAt, render: (o) => o.createdAt.slice(0, 10) },
];

interface SortState {
  key: ColumnKey;
  dir: "asc" | "desc";
}

export interface OrdersTableProps {
  store: OrdersStore;
  selectedId: string | null;
  compact: boolean;
  onOpen: (id: string) => void;
}

export function OrdersTable({ store, selectedId, compact, onOpen }: OrdersTableProps) {
  const [sort, setSort] = useState<SortState>({ key: "createdAt", dir: "desc" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hidden, setHidden] = useState<ColumnKey[]>([]);

  // Stable menu items so the dropdown does not rebuild its menu on every sort.
  const menuItems = useMemo(
    () => COLUMN_DEFS.map((def) => ({ key: def.key, label: def.title })),
    [],
  );

  const columns = COLUMN_DEFS.filter(
    (def) => !hidden.includes(def.key) && !(compact && def.key === "createdAt"),
  );

  const sorted = useMemo(() => {
    const def = COLUMN_DEFS.find((c) => c.key === sort.key);
    if (!def) return store.items;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...store.items].sort((a, b) => {
      const av = def.sortValue(a);
      const bv = def.sortValue(b);
      return av < bv ? -factor : av > bv ? factor : 0;
    });
  }, [store.items, sort]);

  const toggleSort = (key: ColumnKey) =>
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc" }));

  const toggleColumn = (key: ColumnKey) =>
    setHidden((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  return (
    <Spin spinning={store.loading}>
      <Dropdown
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        menu={{
          items: menuItems,
          selectable: true,
          multiple: true,
          selectedKeys: COLUMN_DEFS.map((d) => d.key).filter((k) => !hidden.includes(k)),
          onClick: ({ key }) => toggleColumn(key as ColumnKey),
        }}
      >
        <Button icon={<SettingOutlined />}>Columns</Button>
      </Dropdown>
      <table style={{ width: "100%" }}>
        <thead>
          <tr>
            <th />
            {columns.map((col) => (
              <th key={col.key}>
                <Button type="link" onClick={() => toggleSort(col.key)}>
                  {col.title}
                  {sort.key === col.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </Button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((order, index) => (
            <tr
              key={index}
              onClick={() => onOpen(order.id)}
              style={{ background: order.id === selectedId ? "#e6f4ff" : undefined }}
            >
              <td onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  aria-label={`Select order ${order.number}`}
                  checked={store.selectedIds.includes(order.id)}
                  onChange={(e) => store.toggleSelected(order.id, e.target.checked)}
                />
              </td>
              {columns.map((col) => (
                <td key={col.key}>{col.render(order)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Spin>
  );
}
