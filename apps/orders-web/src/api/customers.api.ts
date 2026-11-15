import { http } from "./http";

export interface CustomerDto {
  id: string;
  name: string;
  email: string;
  ordersCount: number;
}

export interface CustomersApi {
  listCustomers(query: string): Promise<CustomerDto[]>;
}

export const customersApi: CustomersApi = {
  async listCustomers(query) {
    const res = await http.get<CustomerDto[]>("/customers", { params: { query } });
    return res.data;
  },
};
