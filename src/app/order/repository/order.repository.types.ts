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
