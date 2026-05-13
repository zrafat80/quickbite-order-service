import {
  FilterParams,
  PaginationParams,
} from '../../../lib/pagination/cursor-pagination';

export interface InsertEarningInput {
  region: string;
  agentId: number;
  orderId: number;
  orderCreatedAt: Date;
  amount: number;
  currency: string;
}

export interface ListEarningsOptions {
  filters: FilterParams[];
  params: PaginationParams;
}
