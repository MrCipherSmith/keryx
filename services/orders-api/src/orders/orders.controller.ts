import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../common/idempotency.interceptor";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ListOrdersQuery } from "./dto/list-orders.query";
import { OrderPage, OrderResponse } from "./dto/order.response";
import { PayOrderDto } from "./dto/pay-order.dto";
import { StatusChangeResponse } from "./dto/status-change.response";
import { OrdersService } from "./orders.service";

@Controller("v1/orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query() query: ListOrdersQuery): Promise<OrderPage> {
    return this.orders.findPage(query);
  }

  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string): Promise<OrderResponse> {
    return this.orders.findOne(id);
  }

  @Get(":id/history")
  history(@Param("id", ParseUUIDPipe) id: string): Promise<{ data: StatusChangeResponse[] }> {
    return this.orders.history(id);
  }

  @Post(":id/pay")
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  pay(@Param("id", ParseUUIDPipe) id: string, @Body() dto: PayOrderDto): Promise<OrderResponse> {
    return this.orders.pay(id, dto);
  }

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateOrderDto): Promise<OrderResponse> {
    return this.orders.create(dto);
  }
}
