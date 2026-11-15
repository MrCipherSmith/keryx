import { Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Order, OrderStatus } from "../orders/order.entity";
import { Customer, LOYALTY_TIERS, LoyaltyTier } from "./customer.entity";

export interface TierSummary {
  tier: LoyaltyTier;
  customers: number;
}

@Injectable()
export class CustomersService implements OnModuleInit {
  private tierSummary: TierSummary[] = [];

  constructor(
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Warms the tier summary shown in the dashboard header once per process start. */
  async onModuleInit(): Promise<void> {
    const summary: TierSummary[] = [];
    for (const tier of LOYALTY_TIERS) {
      summary.push({ tier, customers: await this.customers.countBy({ loyaltyTier: tier }) });
    }
    this.tierSummary = summary;
  }

  getTierSummary(): TierSummary[] {
    return this.tierSummary;
  }

  listByTier(tier: LoyaltyTier): Promise<Customer[]> {
    return this.dataSource.query(`SELECT * FROM customers WHERE loyalty_tier = $1 ORDER BY created_at DESC LIMIT 500`, [tier]);
  }

  /** Archives a customer who closed their account: open orders are cancelled, the customer is removed. */
  async archive(id: string): Promise<void> {
    const customer = await this.customers.findOneBy({ id });
    if (!customer) throw new NotFoundException("Customer not found");
    await this.orders.update(
      { customerId: id, status: OrderStatus.Pending },
      { status: OrderStatus.Cancelled },
    );
    await this.customers.delete(id);
  }
}
