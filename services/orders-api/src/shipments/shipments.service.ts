import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Order } from "../orders/order.entity";
import { CreateShipmentDto } from "./dto/create-shipment.dto";
import { ListShipmentsQuery } from "./dto/list-shipments.query";
import { Shipment } from "./shipment.entity";

export interface ShipmentPage {
  data: ShipmentView[];
  meta: { limit: number; offset: number; total: number };
}

export interface ShipmentView {
  id: string;
  orderId: string;
  carrier: string;
  trackingNumber: string | null;
  weightGrams: number;
  createdAt: string;
}

@Injectable()
export class ShipmentsService {
  constructor(
    @InjectRepository(Shipment) private readonly shipments: Repository<Shipment>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  async create(orderId: string, dto: CreateShipmentDto): Promise<ShipmentView> {
    const exists = await this.orders.exists({ where: { id: orderId } });
    if (!exists) throw new NotFoundException("Order not found");
    const shipment = await this.shipments.save(
      this.shipments.create({
        orderId,
        carrier: dto.carrier,
        trackingNumber: dto.trackingNumber ?? null,
        weightGrams: dto.weightGrams,
        countryCode: dto.address.countryCode,
        postcode: dto.address.postcode,
        street: dto.address.street,
        notes: dto.notes ?? null,
      }),
    );
    return toView(shipment, labelPrefix(dto.carrier));
  }

  async list(query: ListShipmentsQuery): Promise<ShipmentPage> {
    const [rows, total] = await this.shipments.findAndCount({
      where: query.carrier ? { carrier: query.carrier } : {},
      order: { createdAt: "DESC" },
      take: query.limit,
      skip: query.offset,
    });
    return { data: rows.map((r) => toView(r, labelPrefix(r.carrier))), meta: { limit: query.limit, offset: query.offset, total } };
  }
}

function labelPrefix(carrier: string): string {
  return carrier.toUpperCase() + "-";
}

function toView(s: Shipment, prefix: string): ShipmentView {
  return {
    id: s.id,
    orderId: s.orderId,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber ? prefix + s.trackingNumber : null,
    weightGrams: s.weightGrams,
    createdAt: s.createdAt.toISOString(),
  };
}
