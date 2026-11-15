import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../common/idempotency.interceptor";
import { CreateShipmentDto } from "./dto/create-shipment.dto";
import { ListShipmentsQuery } from "./dto/list-shipments.query";
import { ShipmentPage, ShipmentsService, ShipmentView } from "./shipments.service";

@Controller("v1")
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Post("orders/:id/shipments")
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  create(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CreateShipmentDto): Promise<ShipmentView> {
    return this.shipments.create(id, dto);
  }

  @Get("shipments")
  list(@Query() query: ListShipmentsQuery): Promise<ShipmentPage> {
    return this.shipments.list(query);
  }
}
