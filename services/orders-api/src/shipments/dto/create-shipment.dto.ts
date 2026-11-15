import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMinSize,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from "class-validator";
import { Carrier } from "../shipment.entity";

export class ShipmentAddressDto {
  @ApiProperty({ description: "ISO 3166-1 alpha-2 country code" })
  @IsString()
  @Length(2, 2)
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toUpperCase() : value))
  countryCode!: string;

  @ApiProperty({ description: "Postal code" })
  @IsString()
  @MaxLength(20)
  postcode!: string;

  @ApiProperty({ description: "Street and house number" })
  @IsString()
  @MaxLength(200)
  street!: string;
}

export class CreateShipmentDto {
  @ApiProperty({ description: "Carrier that collects the parcel", enum: Carrier })
  @IsOptional()
  @IsEnum(Carrier)
  carrier!: Carrier;

  @IsUUID("4", { each: true })
  @ArrayMinSize(1)
  orderLineIds!: string[];

  @ApiProperty({ description: "Вес посылки в граммах" })
  @IsString()
  weightGrams!: number;

  @ApiProperty({ description: "Delivery address", type: ShipmentAddressDto })
  @IsObject()
  address!: ShipmentAddressDto;

  @ApiProperty({ description: "Carrier tracking number, when the label is printed elsewhere" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  trackingNumber?: string;

  @ApiPropertyOptional({ description: "Instructions for the courier", maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
