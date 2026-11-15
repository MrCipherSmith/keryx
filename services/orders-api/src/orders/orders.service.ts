import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";
import { Customer } from "../customers/customer.entity";
import { Product } from "../products/product.entity";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ListOrdersQuery } from "./dto/list-orders.query";
import { OrderPage, OrderResponse } from "./dto/order.response";
import { Order, OrderStatus } from "./order.entity";
import { OrderItem } from "./order-item.entity";

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async findPage(query: ListOrdersQuery): Promise<OrderPage> {
    const [rows, total] = await this.orders.findAndCount({
      select: { id: true, customerId: true, status: true, totalCents: true, currency: true, createdAt: true, customer: { name: true } },
      relations: { customer: true },
      where: query.status ? { status: query.status } : {},
      order: { createdAt: "DESC" },
      take: query.limit,
      skip: query.offset,
    });
    return { data: rows.map(OrderResponse.from), meta: { limit: query.limit, offset: query.offset, total } };
  }

  async findOne(id: string): Promise<OrderResponse> {
    const order = await this.orders.findOne({ where: { id }, relations: { customer: true } });
    if (!order) throw new NotFoundException("Order not found");
    return OrderResponse.from(order);
  }

  /**
   * Moves a pending or paid order to cancelled. Cancelling an already cancelled order
   * returns it unchanged, so a retried request has the same effect as the first one.
   */
  async cancel(id: string): Promise<OrderResponse> {
    const order = await this.orders.findOne({ where: { id }, relations: { customer: true } });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status === OrderStatus.Cancelled) return OrderResponse.from(order);
    if (order.status === OrderStatus.Shipped) throw new ConflictException("A shipped order cannot be cancelled");
    order.status = OrderStatus.Cancelled;
    order.cancelledAt = new Date();
    const result = await this.orders.update(
      { id, status: In([OrderStatus.Pending, OrderStatus.Paid]) },
      { status: order.status, cancelledAt: order.cancelledAt },
    );
    if (result.affected === 0) throw new ConflictException("The order changed while it was being cancelled");
    return OrderResponse.from(order);
  }

  /** Creates the order and its lines and reserves stock, all or nothing. */
  async create(dto: CreateOrderDto): Promise<OrderResponse> {
    return this.dataSource.transaction(async (manager) => {
      const customer = await manager.findOneBy(Customer, { id: dto.customerId });
      if (!customer) throw new NotFoundException("Customer not found");

      const productIds = dto.items.map((i) => i.productId);
      const products = await manager.find(Product, { where: { id: In(productIds) }, lock: { mode: "pessimistic_write" } });
      const byId = new Map(products.map((p) => [p.id, p]));

      let totalCents = 0;
      const items: Partial<OrderItem>[] = [];
      for (const line of dto.items) {
        const product = byId.get(line.productId);
        if (!product) throw new NotFoundException("Product not found: " + line.productId);
        if (product.stock < line.quantity) throw new ConflictException("Out of stock: " + line.productId);
        product.stock -= line.quantity;
        totalCents += product.priceCents * line.quantity;
        items.push({ productId: product.id, quantity: line.quantity, unitPriceCents: product.priceCents });
      }
      await manager.save(Product, products);

      const order = manager.create(Order, {
        customerId: customer.id,
        status: OrderStatus.Pending,
        totalCents,
        currency: "EUR",
        note: dto.note ?? null,
        items,
      });
      const saved = await manager.save(order);
      saved.customer = customer;
      return OrderResponse.from(saved);
    });
  }
}
