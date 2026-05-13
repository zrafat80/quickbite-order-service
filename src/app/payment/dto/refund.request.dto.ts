import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class RefundRequestDTO {
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number; // omit -> full refund (remaining unrefunded amount)

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
