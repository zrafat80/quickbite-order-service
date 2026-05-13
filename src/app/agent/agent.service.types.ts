import {
  FilterParams,
  PaginationParams,
} from '../../lib/pagination/cursor-pagination';

export interface ListTasksOptions {
  status?: string;
  params: PaginationParams;
  filters: FilterParams[];
}

export interface ListEarningsOptions {
  from: Date;
  to: Date;
  params: PaginationParams;
}
