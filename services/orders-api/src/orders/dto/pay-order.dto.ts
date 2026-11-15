import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length } from "class-validator";

export class PayOrderDto {
  @ApiProperty({ description: "Payment provider reference of the captured payment", minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  paymentRef!: string;
}
