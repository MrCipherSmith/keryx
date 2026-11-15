import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Order } from "../orders/order.entity";
import { Refund } from "./refund.entity";

export interface RefundView {
  id: string;
  amountCents: number;
  reason: string;
  createdAt: string;
}

@Injectable()
export class RefundsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async create(orderId: string, amountCents: number, reason: string): Promise<RefundView> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new UnprocessableEntityException("amountCents must be a positive integer");
    }
    if (!reason || reason.length > 200) {
      throw new UnprocessableEntityException("reason is required, at most 200 characters");
    }
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(Order, { where: { id: orderId }, lock: { mode: "pessimistic_write" } });
      if (!order) throw new NotFoundException("Order not found");
      const refunded = await manager.sum(Refund, "amountCents", { orderId });
      if ((refunded ?? 0) + amountCents > order.totalCents) {
        throw new UnprocessableEntityException("Refund exceeds the order total");
      }
      const refund = await manager.save(manager.create(Refund, { orderId, amountCents, reason }));
      return toView(refund);
    });
  }

  async listForOrder(orderId: string): Promise<RefundView[]> {
    const rows = await this.dataSource.getRepository(Refund).find({ where: { orderId }, order: { createdAt: "ASC" } });
    return rows.map(toView);
  }
}

function toView(r: Refund): RefundView {
  return { id: r.id, amountCents: r.amountCents, reason: r.reason, createdAt: r.createdAt.toISOString() };
}
