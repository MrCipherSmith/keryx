import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IdempotencyRecord } from "../common/idempotency-record.entity";
import { IdempotencyInterceptor } from "../common/idempotency.interceptor";
import { Customer } from "../customers/customer.entity";
import { Product } from "../products/product.entity";
import { Order } from "./order.entity";
import { OrderItem } from "./order-item.entity";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderItem, Customer, Product, IdempotencyRecord])],
  controllers: [OrdersController],
  providers: [OrdersService, IdempotencyInterceptor],
})
export class OrdersModule {}
