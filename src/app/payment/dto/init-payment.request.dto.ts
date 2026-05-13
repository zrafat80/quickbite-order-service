import { IsUUID } from 'class-validator';

export class InitPaymentRequestDTO {
  @IsUUID('4')
  orderId!: string;
}
