import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import { Alert, Input, Popover, Table, Typography } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import { customersApi, type CustomerDto } from "../../api/customers.api";
import { CustomersStore, CustomersStoreContext } from "../../stores/customers.store";

const columns = [
  { title: "Name", dataIndex: "name", key: "name" },
  { title: "Email", dataIndex: "email", key: "email" },
  { title: "Orders", dataIndex: "ordersCount", key: "ordersCount" },
];

export const CustomersPage = observer(function CustomersPage() {
  const [store] = useState(() => new CustomersStore(customersApi));
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    store.onMount();
    return () => store.onUnmount();
  }, [store]);

  return (
    <CustomersStoreContext.Provider value={store}>
      <Typography.Title level={3}>
        Customers{" "}
        <Popover
          open={helpOpen}
          onOpenChange={setHelpOpen}
          content="Search matches name and email."
        >
          <InfoCircleOutlined />
        </Popover>
      </Typography.Title>
      <Input.Search
        placeholder="Search customers"
        value={store.query}
        onChange={(e) => store.setQuery(e.target.value)}
        allowClear
      />
      {store.error && <Alert type="error" message={store.error} />}
      <Table<CustomerDto>
        rowKey="id"
        columns={columns}
        dataSource={store.items}
        loading={store.loading}
        pagination={false}
        footer={() => `${store.totalOrders} orders in total`}
      />
    </CustomersStoreContext.Provider>
  );
});
