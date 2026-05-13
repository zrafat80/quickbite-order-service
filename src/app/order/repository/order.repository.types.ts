import { OrderStatus, PaymentMethod } from '../enums';
import {
  FilterParams,
  PaginationParams,
} from '../../../lib/pagination/cursor-pagination';

export interface CreateOrderInput {
  region: string;
  publicId: string;
  countryCode: string;
  restaurantId: number;
  branchId: number;
  customerId: number;
  customerAddressId: number;
  deliveryLat: number;
  deliveryLng: number;
  deliveryAddressTextSnapshot: string;
  status: OrderStatus;
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  total: number;
  currency: string;
  paymentMethod: PaymentMethod;
}

export interface ListByCustomerOptions {
  filters: FilterParams[];
  params: PaginationParams;
}

export interface ListByBranchOptions {
  filters: FilterParams[];
  params: PaginationParams;
}

export interface OrderOwnershipView {
  id: number;
  publicId: string;
  customerId: number;
  restaurantId: number;
}

/**
 * Minimal row returned by the sweeper query. The sweeper transitions the
 * order via OrderService and needs the composite (id, created_at) PK plus
 * the public id for logging.
 */
export interface ExpirableOrderRow {
  id: number;
  publicId: string;
  createdAt: Date;
  branchId: number;
}
