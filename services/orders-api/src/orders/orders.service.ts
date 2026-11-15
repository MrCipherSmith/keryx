import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";
import { Customer } from "../customers/customer.entity";
import { Product } from "../products/product.entity";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ListOrdersQuery } from "./dto/list-orders.query";
import { OrderPage, OrderResponse } from "./dto/order.response";
import { PayOrderDto } from "./dto/pay-order.dto";
import { StatusChangeResponse } from "./dto/status-change.response";
import { Order, OrderStatus } from "./order.entity";
import { OrderItem } from "./order-item.entity";
import { OrderStatusHistory } from "./order-status-history.entity";

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

  /** Marks a pending order paid and records the transition, in one transaction. */
  async pay(id: string, dto: PayOrderDto): Promise<OrderResponse> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(Order, { where: { id }, lock: { mode: "pessimistic_write" } });
      if (!order) throw new NotFoundException("Order not found");
      if (order.status !== OrderStatus.Pending) throw new ConflictException("Only a pending order can be paid");
      order.status = OrderStatus.Paid;
      order.paidAt = new Date();
      await manager.save(order);
      await manager.insert(OrderStatusHistory, {
        orderId: id,
        fromStatus: OrderStatus.Pending,
        toStatus: OrderStatus.Paid,
        paymentRef: dto.paymentRef,
      });
      order.customer = await manager.findOneByOrFail(Customer, { id: order.customerId });
      return OrderResponse.from(order);
    });
  }

  /** An order has at most one row per status transition, so the list is short and needs no paging. */
  async history(id: string): Promise<{ data: StatusChangeResponse[] }> {
    const exists = await this.orders.exists({ where: { id } });
    if (!exists) throw new NotFoundException("Order not found");
    const rows = await this.dataSource.getRepository(OrderStatusHistory).find({
      select: { fromStatus: true, toStatus: true, paymentRef: true, createdAt: true },
      where: { orderId: id },
      order: { createdAt: "ASC" },
    });
    return { data: rows.map(StatusChangeResponse.from) };
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
