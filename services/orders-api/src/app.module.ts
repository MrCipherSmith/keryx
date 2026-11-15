import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { dataSourceOptions } from "./data-source";
import { CustomersModule } from "./customers/customers.module";
import { OrdersModule } from "./orders/orders.module";

@Module({
  imports: [TypeOrmModule.forRoot(dataSourceOptions), OrdersModule, CustomersModule],
})
export class AppModule {}
