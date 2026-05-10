import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { CreateOrderRequestDTO } from './dto/create-order.request.dto';
import { UpdateOrderStatusRequestDTO } from './dto/update-order-status.request.dto';
import {
  OrderResponseDTO,
  OrderStatusResponseDTO,
  OrderSummaryResponseDTO,
} from './dto/order.response.dto';
import { OrderService } from './order.service';
import { OrderStatus } from './enums';
import { JwtAuthGuard } from '../../lib/middleware/guards/jwtGuard';
import { PermissionsGuard } from '../../lib/middleware/guards/permissions.guard';
import { RequirePermissions } from '../../lib/decorators/permissions.decorator';
import { IdempotencyInterceptor } from '../../lib/idempotency/idempotency.interceptor';
import { Idempotency } from '../../lib/idempotency/idempotency.decorator';
import { UnifiedCacheInterceptor } from '../../lib/cache/cache.interceptor';
import { CacheScope } from '../../lib/cache/cache-scope.decorator';
import {
  parseFilters,
  parsePaginationQuery,
} from '../../lib/pagination/query-parser';
import {
  buildPaginationResult,
  FilterParams,
} from '../../lib/pagination/cursor-pagination';

const ORDER_COLUMN_MAP: Record<string, string> = { createdAt: 'created_at' };
const ORDER_FILTERABLE_FIELDS = ['status', 'createdAt'];

@Controller()
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  // ─── POST /orders ─────────────────────────────────────────────────────────
  @Post('orders')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotency({ strict: true })
  async placeOrder(
      @Req() req: Request,
      @Body() body: CreateOrderRequestDTO,
      @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderResponseDTO> {
    const { order, items } = await this.orderService.placeOrder(
        req.user!,
        body,
        idempotencyKey,
    );
    return OrderResponseDTO.from(order, items);
  }

  // ─── GET /orders/:publicId ────────────────────────────────────────────────
  @Get('orders/:publicId')
  @UseGuards(JwtAuthGuard)
  async getOrder(
      @Req() req: Request,
      @Param('publicId') publicId: string,
  ): Promise<OrderResponseDTO> {
    const region = req.region ?? '';
    const { order, items } = await this.orderService.getOrder(
        req.user!,
        region,
        publicId,
    );
    return OrderResponseDTO.from(order, items);
  }

  // ─── PATCH /orders/:publicId/status ──────────────────────────────────────
  @Patch('orders/:publicId/status')
  @UseGuards(JwtAuthGuard)
  async updateOrderStatus(
      @Req() req: Request,
      @Param('publicId') publicId: string,
      @Body() body: UpdateOrderStatusRequestDTO,
  ): Promise<OrderStatusResponseDTO> {
    const region = req.region ?? '';
    const updated = await this.orderService.updateStatus(
        req.user!,
        region,
        publicId,
        body.status as OrderStatus,
    );
    return OrderStatusResponseDTO.from(updated);
  }

  // ─── GET /customer/orders ────────────────────────────────────────────────
  @Get('customer/orders')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(UnifiedCacheInterceptor)
  @CacheScope('PRIVATE')
  async listCustomerOrders(@Req() req: Request) {
    const region = req.region ?? '';
    const params = parsePaginationQuery(
        { ...req.query, sortBy: 'createdAt', sortOrder: 'desc' },
        ORDER_COLUMN_MAP,
    );
    const filters = buildOrderFilters(req.query);
    const { orders, itemsByOrderId } = await this.orderService.listCustomerOrders(
        req.user!,
        region,
        { filters, params },
    );

    // 1. Build pagination using the RAW Entities (so it has access to the internal numeric .id)
    const paginatedEntities = buildPaginationResult(orders, params.limit, params.apiSortBy);

    // 2. Map ONLY the data that made it onto the page into DTOs
    const dtos = paginatedEntities.data.map((o) =>
        OrderSummaryResponseDTO.from(o, itemsByOrderId.get(o.id)?.length ?? 0),
    );

    // 3. Return the payload with the clean DTOs and the Base64 Meta
    return {
      data: dtos,
      meta: paginatedEntities.meta,
    };
  }

  // ─── GET /restaurant/orders ──────────────────────────────────────────────
  @Get('restaurant/orders')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('orders', 'read')
  @UseInterceptors(UnifiedCacheInterceptor)
  @CacheScope('PUBLIC')
  async listRestaurantOrders(
      @Req() req: Request,
      @Query('branchId', ParseIntPipe) branchId: number,
  ) {
    const region = req.region ?? '';
    const params = parsePaginationQuery(
        { ...req.query, sortBy: 'createdAt', sortOrder: 'desc' },
        ORDER_COLUMN_MAP,
    );
    const filters = buildOrderFilters(req.query);
    const { orders, itemsByOrderId } =
        await this.orderService.listRestaurantOrders(req.user!, region, branchId, {
          filters,
          params,
        });

    // 1. Build pagination using the RAW Entities (so it has access to the internal numeric .id)
    const paginatedEntities = buildPaginationResult(orders, params.limit, params.apiSortBy);

    // 2. Map ONLY the data that made it onto the page into DTOs
    const dtos = paginatedEntities.data.map((o) =>
        OrderSummaryResponseDTO.from(o, itemsByOrderId.get(o.id)?.length ?? 0),
    );

    // 3. Return the payload with the clean DTOs and the Base64 Meta
    return {
      data: dtos,
      meta: paginatedEntities.meta,
    };
  }
}

/**
 * Build the FilterParams[] passed to the repo. Combines:
 * 1. The universal `?filter[<field>][<op>]=<value>` syntax (api-contracts §0).
 * 2. Documented flat shortcuts: `?year=YYYY`, `?status=`, `?from=`, `?to=` —
 * translated into the same FilterParams shape so the repo only knows one
 * mechanism.
 * Status values are validated against the OrderStatus enum here so a bad
 * query short-circuits to 400 instead of running an empty SELECT.
 */
function buildOrderFilters(
    query: Record<string, any>,
): FilterParams[] {
  const filters: FilterParams[] = parseFilters(
      query,
      ORDER_FILTERABLE_FIELDS,
      ORDER_COLUMN_MAP,
  );

  const status = query.status as string | undefined;
  if (status) {
    filters.push({ field: 'status', operator: 'eq', value: status });
  }

  const year = query.year as string | undefined;
  if (year) {
    const y = Number(year);
    if (!Number.isInteger(y) || y < 2000 || y > 9999) {
      throw new BadRequestException(`Invalid year "${year}"`);
    }
    filters.push({
      field: 'created_at',
      operator: 'gte',
      value: new Date(Date.UTC(y, 0, 1)).toISOString(),
    });
    filters.push({
      field: 'created_at',
      operator: 'lt',
      value: new Date(Date.UTC(y + 1, 0, 1)).toISOString(),
    });
  }

  const from = query.from as string | undefined;
  if (from) {
    filters.push({ field: 'created_at', operator: 'gte', value: from });
  }
  const to = query.to as string | undefined;
  if (to) {
    filters.push({ field: 'created_at', operator: 'lt', value: to });
  }

  // Validate status values against the enum (filterable but not free-form).
  const allowedStatuses = Object.values(OrderStatus) as string[];
  for (const f of filters) {
    if (f.field === 'status') {
      const vals = Array.isArray(f.value) ? f.value : [f.value];
      for (const v of vals) {
        if (!allowedStatuses.includes(v)) {
          throw new BadRequestException(`Invalid status "${v}"`);
        }
      }
    }
  }

  return filters;
}