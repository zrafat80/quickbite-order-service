import { IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

// Agent delivery-status transitions: accept, pickup, deliver, reject.
// 'accept' is an acknowledgment only (order stays assigned).
export enum DeliveryAction {
  ACCEPT = 'accept',
  PICKUP = 'pickup',
  DELIVER = 'deliver',
  REJECT = 'reject',
}

export class UpdateDeliveryStatusRequestDTO {
  @IsEnum(DeliveryAction)
  status!: DeliveryAction;
}

export class AssignAgentRequestDTO {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  agentId!: number;
}
