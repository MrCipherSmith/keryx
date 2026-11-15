import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../common/idempotency.interceptor";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ListOrdersQuery } from "./dto/list-orders.query";
import { OrderPage, OrderResponse } from "./dto/order.response";
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

  @Post()
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateOrderDto): Promise<OrderResponse> {
    return this.orders.create(dto);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@Param("id", ParseUUIDPipe) id: string): Promise<OrderResponse> {
    return this.orders.cancel(id);
  }
}
