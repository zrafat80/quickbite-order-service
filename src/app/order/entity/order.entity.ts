import { OrderStatus, PaymentMethod } from '../enums';

export class OrderEntity {
  id!: number;
  region!: string;
  publicId!: string;
  countryCode!: string;
  restaurantId!: number;
  branchId!: number;
  customerId!: number;
  customerAddressId!: number;
  deliveryLat!: number;
  deliveryLng!: number;
  deliveryAddressTextSnapshot!: string;
  status!: OrderStatus;
  subtotal!: number;
  deliveryFee!: number;
  serviceFee!: number;
  total!: number;
  commission!: number;
  currency!: string;
  paymentMethod!: PaymentMethod;
  deliveryAgentId!: number | null;
  assignmentAttempts!: number;
  lastAssignmentAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  acceptedAt!: Date | null;
  rejectedAt!: Date | null;
  readyAt!: Date | null;
  assignedAt!: Date | null;
  pickedAt!: Date | null;
  deliveredAt!: Date | null;
  cancelledAt!: Date | null;

  constructor(data: Partial<OrderEntity>) {
    Object.assign(this, data);
  }
}
