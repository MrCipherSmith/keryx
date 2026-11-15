import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsInt, IsOptional, Max, Min } from "class-validator";
import { Carrier } from "../shipment.entity";

export class ListShipmentsQuery {
  @ApiPropertyOptional({ description: "Only shipments with this carrier", enum: Carrier })
  @IsOptional()
  @IsEnum(Carrier)
  carrier?: Carrier;

  @ApiPropertyOptional({ description: "Page size", minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ description: "Rows to skip", minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset = 0;
}
