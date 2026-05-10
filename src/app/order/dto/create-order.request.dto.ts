import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '../enums';

export class CreateOrderItemDTO {
  @IsInt()
  @Min(1)
  productId!: number;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateOrderRequestDTO {
  @IsInt()
  @Min(1)
  branchId!: number;

  @IsInt()
  @Min(1)
  customerAddressId!: number;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDTO)
  items!: CreateOrderItemDTO[];
}
