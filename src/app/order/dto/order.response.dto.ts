import { OrderEntity } from '../entity/order.entity';
import { OrderItemEntity } from '../entity/order-item.entity';
import { OrderStatus, PaymentMethod } from '../enums';

export class OrderItemResponseDTO {
  productId!: number;
  quantity!: number;
  unitPrice!: number;
  lineTotal!: number;
  name!: string;
  imageUrl!: string | null;

  static from(item: OrderItemEntity): OrderItemResponseDTO {
    const dto = new OrderItemResponseDTO();
    dto.productId = item.productId;
    dto.quantity = item.quantity;
    dto.unitPrice = item.unitPriceSnapshot;
    dto.lineTotal = item.lineTotal;
    dto.name = item.nameSnapshot;
    dto.imageUrl = item.imageUrlSnapshot ?? null;
    return dto;
  }
}

export class OrderResponseDTO {
  id!: string; // public_id (UUID)
  status!: OrderStatus;
  paymentMethod!: PaymentMethod;
  branchId!: number;
  restaurantId!: number;
  customerId!: number;
  delivery!: {
    addressText: string;
    lat: number;
    lng: number;
  };
  money!: {
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: string;
  };
  items!: OrderItemResponseDTO[];
  createdAt!: string;
  acceptedAt!: string | null;
  rejectedAt!: string | null;
  readyAt!: string | null;
  assignedAt!: string | null;
  pickedAt!: string | null;
  deliveredAt!: string | null;
  cancelledAt!: string | null;

  static from(
    order: OrderEntity,
    items: OrderItemEntity[],
  ): OrderResponseDTO {
    const dto = new OrderResponseDTO();
    dto.id = order.publicId;
    dto.status = order.status;
    dto.paymentMethod = order.paymentMethod;
    dto.branchId = Number(order.branchId);
    dto.restaurantId = Number(order.restaurantId);
    dto.customerId = Number(order.customerId);
    dto.delivery = {
      addressText: order.deliveryAddressTextSnapshot,
      lat: Number(order.deliveryLat),
      lng: Number(order.deliveryLng),
    };
    dto.money = {
      subtotal: Number(order.subtotal),
      deliveryFee: Number(order.deliveryFee),
      serviceFee: Number(order.serviceFee),
      total: Number(order.total),
      currency: order.currency,
    };
    dto.items = items.map(OrderItemResponseDTO.from);
    dto.createdAt = toIso(order.createdAt);
    dto.acceptedAt = toIsoOrNull(order.acceptedAt);
    dto.rejectedAt = toIsoOrNull(order.rejectedAt);
    dto.readyAt = toIsoOrNull(order.readyAt);
    dto.assignedAt = toIsoOrNull(order.assignedAt);
    dto.pickedAt = toIsoOrNull(order.pickedAt);
    dto.deliveredAt = toIsoOrNull(order.deliveredAt);
    dto.cancelledAt = toIsoOrNull(order.cancelledAt);
    return dto;
  }
}

export class OrderSummaryResponseDTO {
  id!: string;
  status!: OrderStatus;
  paymentMethod!: PaymentMethod;
  branchId!: number;
  total!: number;
  currency!: string;
  itemCount!: number;
  createdAt!: string;

  static from(order: OrderEntity, itemCount: number): OrderSummaryResponseDTO {
    const dto = new OrderSummaryResponseDTO();
    dto.id = order.publicId;
    dto.status = order.status;
    dto.paymentMethod = order.paymentMethod;
    dto.branchId = Number(order.branchId);
    dto.total = Number(order.total);
    dto.currency = order.currency;
    dto.itemCount = itemCount;
    dto.createdAt = toIso(order.createdAt);
    return dto;
  }
}

export class OrderStatusResponseDTO {
  id!: string;
  status!: OrderStatus;
  ts!: string;

  static from(order: OrderEntity): OrderStatusResponseDTO {
    const dto = new OrderStatusResponseDTO();
    dto.id = order.publicId;
    dto.status = order.status;
    dto.ts = new Date().toISOString();
    return dto;
  }
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function toIsoOrNull(d: Date | string | null): string | null {
  if (d === null || d === undefined) return null;
  return toIso(d);
}
