import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class CreatePayoutRequestDTO {
  @IsInt()
  @IsPositive()
  amount!: number;

  @IsString()
  @IsNotEmpty()
  currency!: string;

  @IsString()
  @IsNotEmpty()
  method!: string; // 'bank_transfer'

  @IsString()
  @IsNotEmpty()
  dst!: string; // IBAN or bank account
}
