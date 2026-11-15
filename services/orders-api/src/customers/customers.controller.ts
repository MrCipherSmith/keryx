import { Controller, Delete, Get, HttpCode, Param, ParseEnumPipe, ParseUUIDPipe, Query } from "@nestjs/common";
import { Customer, LOYALTY_TIERS, LoyaltyTier } from "./customer.entity";
import { CustomersService, TierSummary } from "./customers.service";

@Controller("v1/customers")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get("tiers")
  tiers(): TierSummary[] {
    return this.customers.getTierSummary();
  }

  @Get()
  async list(@Query("tier", new ParseEnumPipe(Object.fromEntries(LOYALTY_TIERS.map((t) => [t, t])))) tier: LoyaltyTier): Promise<{ data: Customer[] }> {
    return { data: await this.customers.listByTier(tier) };
  }

  @Delete(":id")
  @HttpCode(204)
  archive(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.customers.archive(id);
  }
}
