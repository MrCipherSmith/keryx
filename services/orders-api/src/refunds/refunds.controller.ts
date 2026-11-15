import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { RefundsService, RefundView } from "./refunds.service";

@Controller("v1/orders/:id/refunds")
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  list(@Param("id", ParseUUIDPipe) id: string): Promise<RefundView[]> {
    return this.refunds.listForOrder(id);
  }

  @Post()
  async create(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { amountCents: number; reason: string },
    @Res() res: Response,
  ): Promise<void> {
    try {
      const refund = await this.refunds.create(id, body.amountCents, body.reason);
      res.status(201).json(refund);
    } catch (e) {
      const err = e as { status?: number; message: string };
      res.status(err.status ?? 500).json({ error: err.message });
    }
  }
}
