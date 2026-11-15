import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { dataSourceOptions } from "./data-source";
import { OrdersModule } from "./orders/orders.module";
import { ShipmentsModule } from "./shipments/shipments.module";

@Module({
  imports: [TypeOrmModule.forRoot(dataSourceOptions), OrdersModule, ShipmentsModule],
})
export class AppModule {}
