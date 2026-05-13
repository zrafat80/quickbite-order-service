import { OrderEntity } from '../../order/entity/order.entity';
import { AgentEarningEntity } from '../entity/agent-earning.entity';

export class DeliveryTaskResponseDTO {
  orderId!: string; // public_id
  status!: string;
  branchId!: number;
  restaurantId!: number;
  deliveryAddress!: string;
  deliveryLat!: number;
  deliveryLng!: number;
  subtotal!: number;
  deliveryFee!: number;
  total!: number;
  currency!: string;
  assignedAt!: string | null;
  pickedAt!: string | null;

  static from(order: OrderEntity): DeliveryTaskResponseDTO {
    const dto = new DeliveryTaskResponseDTO();
    dto.orderId = order.publicId;
    dto.status = order.status;
    dto.branchId = Number(order.branchId);
    dto.restaurantId = Number(order.restaurantId);
    dto.deliveryAddress = order.deliveryAddressTextSnapshot;
    dto.deliveryLat = Number(order.deliveryLat);
    dto.deliveryLng = Number(order.deliveryLng);
    dto.subtotal = Number(order.subtotal);
    dto.deliveryFee = Number(order.deliveryFee);
    dto.total = Number(order.total);
    dto.currency = order.currency;
    dto.assignedAt = order.assignedAt ? new Date(order.assignedAt).toISOString() : null;
    dto.pickedAt = order.pickedAt ? new Date(order.pickedAt).toISOString() : null;
    return dto;
  }
}

export class AssignmentResponseDTO {
  orderId!: string;
  status!: string;
  deliveryAgentId!: number;
  assignedAt!: string;

  static from(order: OrderEntity): AssignmentResponseDTO {
    const dto = new AssignmentResponseDTO();
    dto.orderId = order.publicId;
    dto.status = order.status;
    dto.deliveryAgentId = Number(order.deliveryAgentId);
    dto.assignedAt = order.assignedAt ? new Date(order.assignedAt).toISOString() : new Date().toISOString();
    return dto;
  }
}

export class EarningItemDTO {
  orderPublicId!: string;
  amount!: number;
  currency!: string;
  earnedAt!: string;
}

export class AgentEarningsResponseDTO {
  range!: { from: string; to: string };
  totals!: { count: number; sum: number; currency: string };
  items!: EarningItemDTO[];
  nextCursor!: string | null;

  static from(opts: {
    from: Date;
    to: Date;
    items: Array<AgentEarningEntity & { orderPublicId?: string }>;
    sum: number;
    count: number;
    currency: string;
    nextCursor: string | null;
  }): AgentEarningsResponseDTO {
    const dto = new AgentEarningsResponseDTO();
    dto.range = {
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
    };
    dto.totals = { count: opts.count, sum: opts.sum, currency: opts.currency };
    dto.items = opts.items.map((e) => {
      const item = new EarningItemDTO();
      item.orderPublicId = e.orderPublicId ?? '';
      item.amount = e.amount;
      item.currency = e.currency;
      item.earnedAt = new Date(e.earnedAt).toISOString();
      return item;
    });
    dto.nextCursor = opts.nextCursor;
    return dto;
  }
}
