import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IdempotencyRecord } from "../common/idempotency-record.entity";
import { IdempotencyInterceptor } from "../common/idempotency.interceptor";
import { Order } from "../orders/order.entity";
import { Shipment } from "./shipment.entity";
import { ShipmentsController } from "./shipments.controller";
import { ShipmentsService } from "./shipments.service";

@Module({
  imports: [TypeOrmModule.forFeature([Shipment, Order, IdempotencyRecord])],
  controllers: [ShipmentsController],
  providers: [ShipmentsService, IdempotencyInterceptor],
})
export class ShipmentsModule {}
