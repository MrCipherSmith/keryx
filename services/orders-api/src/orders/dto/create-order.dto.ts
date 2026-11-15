import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class CreateOrderItemDto {
  @ApiProperty({ description: "Product to order", format: "uuid" })
  @IsUUID()
  productId!: string;

  @ApiProperty({ description: "Units of the product", minimum: 1, maximum: 99 })
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}

export class CreateOrderDto {
  @ApiProperty({ description: "Customer placing the order", format: "uuid" })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ description: "Order lines", type: [CreateOrderItemDto] })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  items!: CreateOrderItemDto[];

  @ApiPropertyOptional({ description: "Partner reference for marketplace orders", maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  externalRef?: string;

  @ApiPropertyOptional({ description: "Free-text note for the warehouse", maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
