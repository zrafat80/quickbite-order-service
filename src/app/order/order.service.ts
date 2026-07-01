import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Knex } from 'knex';
import { OrderRepository } from './repository/order.repository';
import {
  CreateOrderInput,
  ExpirableOrderRow,
  OrderOwnershipView,
} from './repository/order.repository.types';
import { OrderItemRepository } from './repository/order-item.repository';
import { OrderStatusService, Actor } from './order-status.service';
import { OrderEntity } from './entity/order.entity';
import { OrderItemEntity } from './entity/order-item.entity';
import { OrderStatus, PaymentMethod } from './enums';
import { ORDER_ERRORS } from './order.constants';
import { CreateOrderRequestDTO } from './dto/create-order.request.dto';
import { ShardedKnex } from '../../lib/sharding/shards';
import { BranchClient } from '../../lib/core-client/branch.client';
import { AddressClient } from '../../lib/core-client/address.client';
import { PermissionCacheService } from '../../lib/middleware/guards/permission-cache.service';
import {
  FilterParams,
  PaginationParams,
} from '../../lib/pagination/cursor-pagination';
import { AuthenticatedUser } from './order.service.types';
import { PaymentService } from '../payment/payment.service';
import { PaymentSessionEntity } from '../payment/entity/payment-session.entity';
import { WsPublisher } from '../../lib/websocket/ws.publisher';
import { OrderResponseDTO, OrderStatusResponseDTO } from './dto/order.response.dto';
import { OutboxRepository } from '../../lib/events/outbox.repository';
import { EVENT_TYPES } from '../../lib/events/event-types';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly orderRepo: OrderRepository,
    private readonly orderItemRepo: OrderItemRepository,
    private readonly statusService: OrderStatusService,
    private readonly branchClient: BranchClient,
    private readonly addressClient: AddressClient,
    private readonly permissionCache: PermissionCacheService,
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService,
    private readonly wsPublisher: WsPublisher,
    private readonly outboxRepo: OutboxRepository,
  ) {}

  // ─── POST /orders ─────────────────────────────────────────────────────────
  async placeOrder(
    user: AuthenticatedUser,
    body: CreateOrderRequestDTO,
    idempotencyKey: string | undefined,
  ): Promise<{
    order: OrderEntity;
    items: OrderItemEntity[];
    paymentSession?: PaymentSessionEntity;
  }> {
    if (user.role !== 'customer') {
      throw new ForbiddenException(ORDER_ERRORS.CUSTOMERS_ONLY);
    }
    if (body.items.length === 0) {
      throw new BadRequestException(ORDER_ERRORS.EMPTY_ITEMS);
    }

    // 1. Branch metadata + region resolution.
    const branch = await this.branchClient.getBranch(body.branchId);
    if (branch.restaurantStatus !== 'active') {
      throw new ConflictException(ORDER_ERRORS.RESTAURANT_NOT_ACTIVE);
    }
    if (!branch.isActive || !branch.acceptOrders) {
      throw new ConflictException(ORDER_ERRORS.BRANCH_NOT_ACCEPTING_ORDERS);
    }
    const region = branch.countryCode.toLowerCase();

    // 2. Address (authoritative for lat/lng/text).
    const address = await this.addressClient
      .getCustomerAddress(body.customerAddressId)
      .catch(() => null);
    if (!address) {
      throw new NotFoundException(ORDER_ERRORS.ADDRESS_NOT_FOUND);
    }
    if (Number(address.userId) !== Number(user.userId)) {
      throw new ForbiddenException(ORDER_ERRORS.ADDRESS_NOT_OWNED);
    }

    // 3. Product prices/stock.
    const productIds = body.items.map((i) => i.productId);
    const products = await this.branchClient.getBranchProducts(
      branch.id,
      productIds,
    );
    const byId = new Map(products.map((p) => [p.productId, p]));
    const missing = productIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new ConflictException({
        message: ORDER_ERRORS.PRODUCT_NOT_AVAILABLE,
        missing,
      });
    }
    const insufficient: Array<{ productId: number; requested: number; available: number }> = [];
    for (const item of body.items) {
      const p = byId.get(item.productId)!;
      if (!p.isAvailable || p.stock < item.quantity) {
        insufficient.push({
          productId: item.productId,
          requested: item.quantity,
          available: p.stock,
        });
      }
    }
    if (insufficient.length > 0) {
      throw new ConflictException({
        message: ORDER_ERRORS.INSUFFICIENT_STOCK,
        insufficient,
      });
    }

    // 4. Money.
    const subtotal = body.items.reduce((acc, it) => {
      const p = byId.get(it.productId)!;
      return acc + p.price * it.quantity;
    }, 0);
    const deliveryFee = branch.deliveryFee;
    const serviceFee = 0; // platform_service_rate currently 0 (CLAUDE.md §6)
    const total = subtotal + deliveryFee + serviceFee;

    // 5. Persist (one trx on the branch's region).
    const initialStatus =
      body.paymentMethod === PaymentMethod.ONLINE
        ? OrderStatus.PENDING_PAYMENT
        : OrderStatus.PLACED;

    const trx: Knex.Transaction = await this.knex.db(region).transaction();
    let order: OrderEntity;
    let items: OrderItemEntity[];
    try {
      const insertInput: CreateOrderInput = {
        region,
        publicId: uuidv4(),
        countryCode: branch.countryCode,
        restaurantId: branch.restaurantId,
        restaurantOwnerId: branch.restaurantOwnerId ?? null,
        branchId: branch.id,
        branchLat: branch.lat,
        branchLng: branch.lng,
        customerId: user.userId,
        customerAddressId: address.id,
        deliveryLat: address.lat,
        deliveryLng: address.lng,
        deliveryAddressTextSnapshot: this.composeAddressText(address),
        status: initialStatus,
        subtotal,
        deliveryFee,
        serviceFee,
        total,
        currency: branch.currency,
        paymentMethod: body.paymentMethod,
      };
      order = await this.orderRepo.createOrder(region, insertInput, trx);

      items = await this.orderItemRepo.bulkInsert(
        body.items.map((it) => {
          const p = byId.get(it.productId)!;
          return {
            region,
            orderId: order.id,
            orderCreatedAt: order.createdAt,
            productId: it.productId,
            quantity: it.quantity,
            unitPriceSnapshot: p.price,
            nameSnapshot: p.name,
            imageUrlSnapshot: p.imageUrl ?? null,
            lineTotal: p.price * it.quantity,
          };
        }),
        trx,
      );

      // Transactional outbox — drained out-of-band to RabbitMQ `order.events`.
      //
      // Revenue-recognition rule for analytics:
      //   - COD orders: revenue is real the moment we place the order, so
      //     emit order.placed here and don't emit payment.completed later.
      //   - ONLINE orders: revenue is pending until the payment captures.
      //     Skip order.placed here; markPaymentCaptured will emit
      //     payment.completed which carries the same aggregate-incrementing
      //     fields. Emitting both would double-count online revenue.
      if (body.paymentMethod === PaymentMethod.COD) {
        await this.outboxRepo.insertOutboxEvent(region, trx, {
          aggregateType: 'order',
          aggregateId: order.publicId,
          eventType: EVENT_TYPES.ORDER_PLACED,
          payload: {
            orderId: order.publicId,
            region,
            countryCode: branch.countryCode,
            restaurantId: Number(branch.restaurantId),
            branchId: Number(branch.id),
            customerId: Number(user.userId),
            status: order.status,
            paymentMethod: body.paymentMethod,
            subtotal,
            deliveryFee,
            serviceFee,
            total,
            currency: branch.currency,
            items: items.map((it) => ({
              productId: Number(it.productId),
              quantity: it.quantity,
              unitPriceSnapshot: it.unitPriceSnapshot,
              lineTotal: it.lineTotal,
            })),
            placedAt: new Date(order.createdAt).toISOString(),
          },
        });
      }

      await trx.commit();
    } catch (err) {
      await trx.rollback();
      throw err;
    }

    const orderWithBranch = {
      ...order,
      branch: {
        name: branch.restaurantName + ' - ' + branch.label,
        addressText: branch.addressText,
        lat: branch.lat,
        lng: branch.lng,
      },
    };

    // 6. Reserve stock OUT-OF-TRX (per docs/business-logic/orders.md §2 step 6).
    // Online orders defer reservation until payment captures (Phase 2).
    if (body.paymentMethod === PaymentMethod.COD) {
      try {
        const reservationKey =
          idempotencyKey ?? `reserve:${order.publicId}`;
        const result = await this.branchClient.reserveStock(
          branch.id,
          body.items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
          })),
          reservationKey,
        );
        if (!result.ok) {
          // Stock vanished between snapshot and reservation. Void the order.
          await this.voidOrderForOutOfStock(region, order);
          throw new ConflictException({
            message: ORDER_ERRORS.INSUFFICIENT_STOCK,
            insufficient: result.insufficient,
          });
        }
      } catch (err) {
        if (err instanceof ConflictException) throw err;
        this.logger.error(
          `reserveStock failed for order ${order.publicId}: ${(err as Error).message}`,
        );
        throw err;
      }
      
      // Emit WS event for COD orders
      this.wsPublisher.emit(
        `branch:${order.branchId}`,
        'order.created',
        OrderResponseDTO.from(orderWithBranch as any, items)
      );
    }

    // 7. Auto-init Kashier session for online orders so the response carries
    // a redirectUrl. A failure here does NOT roll back the order — the
    // customer can retry by calling POST /payments/init.
    let paymentSession: PaymentSessionEntity | undefined;
    if (body.paymentMethod === PaymentMethod.ONLINE) {
      try {
        paymentSession = await this.paymentService.initForOrderEntity(
          user,
          region,
          order,
        );
      } catch (err) {
        this.logger.warn(
          `auto-init payment failed for order ${order.publicId}: ${
            (err as Error).message
          }; client may retry POST /payments/init`,
        );
      }
    }

    return { order: orderWithBranch as any, items, paymentSession };
  }

  // ─── GET /orders/{publicId} ───────────────────────────────────────────────
  async getOrder(
    user: AuthenticatedUser,
    region: string,
    publicId: string,
  ): Promise<{ order: OrderEntity; items: OrderItemEntity[] }> {
    if (!region) throw new BadRequestException(ORDER_ERRORS.REGION_REQUIRED);
    const order = await this.orderRepo.findByPublicId(region, publicId);
    if (!order) throw new NotFoundException(ORDER_ERRORS.NOT_FOUND);

    this.assertReadAccess(user, order);

    const items = await this.orderItemRepo.findByOrderIds(region, [
      { orderId: order.id, orderCreatedAt: order.createdAt },
    ]);

    const branch = await this.branchClient.getBranch(order.branchId).catch(() => null);
    const orderWithBranch = {
      ...order,
      branch: branch ? {
        name: branch.restaurantName + ' - ' + branch.label,
        addressText: branch.addressText,
        lat: branch.lat,
        lng: branch.lng,
      } : undefined,
    };

    return { order: orderWithBranch as any, items };
  }

  // ─── GET /customer/orders ────────────────────────────────────────────────
  async listCustomerOrders(
    user: AuthenticatedUser,
    region: string,
    options: { filters: FilterParams[]; params: PaginationParams },
  ): Promise<{ orders: OrderEntity[]; itemsByOrderId: Map<number, OrderItemEntity[]> }> {
    if (user.role !== 'customer') {
      throw new ForbiddenException(ORDER_ERRORS.CUSTOMERS_ONLY);
    }
    if (!region) throw new BadRequestException(ORDER_ERRORS.REGION_REQUIRED);
    const orders = await this.orderRepo.findByCustomer(region, user.userId, {
      filters: options.filters,
      params: options.params,
    });
    const itemsByOrderId = await this.fetchItemsForOrders(region, orders);

    // Bulk fetch branch names
    const branchIds = [...new Set(orders.map(o => Number(o.branchId)))];
    const branches = await this.branchClient.getBranchesBulk(branchIds);
    const branchMap = new Map(branches.map(b => [b.id, b.restaurantName + ' - ' + b.label]));

    const ordersWithBranch = orders.map(o => ({
      ...o,
      branchName: branchMap.get(Number(o.branchId))
    }));

    return { orders: ordersWithBranch as any, itemsByOrderId };
  }

  // ─── GET /restaurant/orders ──────────────────────────────────────────────
  async listRestaurantOrders(
    user: AuthenticatedUser,
    region: string,
    branchId: number,
    options: { filters: FilterParams[]; params: PaginationParams },
  ): Promise<{ orders: OrderEntity[]; itemsByOrderId: Map<number, OrderItemEntity[]> }> {
    if (user.role !== 'restaurant_user' && user.role !== 'system_admin') {
      throw new ForbiddenException(ORDER_ERRORS.RESTAURANTS_ONLY);
    }
    if (!region) throw new BadRequestException(ORDER_ERRORS.REGION_REQUIRED);
    const orders = await this.orderRepo.findByBranch(region, branchId, {
      filters: options.filters,
      params: options.params,
    });
    const itemsByOrderId = await this.fetchItemsForOrders(region, orders);

    // Bulk fetch branch names
    const branchIds = [...new Set(orders.map(o => Number(o.branchId)))];
    const branches = await this.branchClient.getBranchesBulk(branchIds);
    const branchMap = new Map(branches.map(b => [b.id, b.restaurantName + ' - ' + b.label]));

    const ordersWithBranch = orders.map(o => ({
      ...o,
      branchName: branchMap.get(Number(o.branchId))
    }));

    return { orders: ordersWithBranch as any, itemsByOrderId };
  }

  // ─── PATCH /orders/{publicId}/status ─────────────────────────────────────
  async updateStatus(
    user: AuthenticatedUser,
    region: string,
    publicId: string,
    nextStatus: OrderStatus,
  ): Promise<OrderEntity> {
    if (!region) throw new BadRequestException(ORDER_ERRORS.REGION_REQUIRED);

    // Agent-owned transitions (PICKED, DELIVERED) require the dedicated
    // /agent endpoints. Those paths run settlement, agent_earnings, and the
    // outbox emit together; the generic status endpoint does not.
    if (
      nextStatus === OrderStatus.PICKED ||
      nextStatus === OrderStatus.DELIVERED
    ) {
      throw new ConflictException(ORDER_ERRORS.AGENT_TRANSITION_WRONG_ENDPOINT);
    }

    const current = await this.orderRepo.findByPublicId(region, publicId);
    if (!current) throw new NotFoundException(ORDER_ERRORS.NOT_FOUND);

    const actor = await this.buildActor(user);

    // Ownership must be checked before transition-specific business rules so a
    // foreign actor cannot infer the target order's state or age.
    if (actor.kind === 'customer' && Number(current.customerId) !== Number(user.userId)) {
      throw new ForbiddenException(ORDER_ERRORS.FORBIDDEN);
    }
    if (actor.kind === 'restaurant') {
      const isSameRestaurant =
        Number(actor.restaurantId) === Number(current.restaurantId);
      const hasBranchAccess =
        user.restaurantRole === 'owner' ||
        (Array.isArray(user.branchIds) &&
          user.branchIds.includes(Number(current.branchId)));

      if (!isSameRestaurant || !hasBranchAccess) {
        throw new ForbiddenException(ORDER_ERRORS.FORBIDDEN);
      }
    }

    // Customer cancel window: only while status is PLACED and within 60s of created_at.
    if (
      nextStatus === OrderStatus.CANCELLED &&
      actor.kind === 'customer' &&
      current.status === OrderStatus.PLACED
    ) {
      const ageMs = Date.now() - new Date(current.createdAt).getTime();
      if (ageMs > 60_000) {
        throw new ConflictException(ORDER_ERRORS.CANCEL_WINDOW_EXPIRED);
      }
    }

    const { timestampColumn } = this.statusService.assertTransition(
      current.status,
      nextStatus,
      actor,
    );

    const trx: Knex.Transaction = await this.knex.db(region).transaction();
    let updated: OrderEntity;
    try {
      updated = await this.orderRepo.updateStatus(
        region,
        current.id,
        current.createdAt,
        nextStatus,
        timestampColumn,
        trx,
      );

      // Outbox emit on REJECTED — analytics-service consumes this to bump
      // rejected_count on restaurant/branch/platform aggregates. Same trx
      // as the status flip so we never publish a reject the DB rolled back.
      if (nextStatus === OrderStatus.REJECTED) {
        await this.outboxRepo.insertOutboxEvent(region, trx, {
          aggregateType: 'order',
          aggregateId: updated.publicId,
          eventType: EVENT_TYPES.ORDER_REJECTED,
          payload: {
            orderId: updated.publicId,
            region,
            countryCode: updated.countryCode,
            restaurantId: Number(updated.restaurantId),
            branchId: Number(updated.branchId),
            currency: updated.currency,
            rejectedAt: new Date(updated.rejectedAt ?? new Date()).toISOString(),
          },
        });
      }

      await trx.commit();
    } catch (err) {
      await trx.rollback();
      throw err;
    }

    // Emit WS events
    const branch = await this.branchClient.getBranch(updated.branchId).catch(() => null);
    const updatedWithBranch = {
      ...updated,
      branchName: branch ? branch.restaurantName + ' - ' + branch.label : undefined
    };

    this.wsPublisher.emit(
      `customer:${updated.customerId}`,
      'order.status_changed',
      OrderStatusResponseDTO.from(updatedWithBranch as any)
    );
    this.wsPublisher.emit(
      `branch:${updated.branchId}`,
      'order.status_changed',
      OrderStatusResponseDTO.from(updatedWithBranch as any)
    );

    // Release reserved stock OUT-OF-TRX when an order that *had* stock reserved
    // is cancelled/rejected before the kitchen committed to it. PLACED is the
    // post-reservation state for both flows:
    //   - COD: reserved at placeOrder, status -> placed
    //   - ONLINE: reserved by the post-capture settlement, status -> placed
    // Once kitchen accepts, ingredients may be in flight — leave stock
    // decremented and let restaurant adjust manually.
    // (The auto-cancel-for-out-of-stock path bypasses updateStatus entirely,
    // so it never hits this branch — correct, because there's nothing to
    // release in that case.)
    if (
      current.status === OrderStatus.PLACED &&
      (nextStatus === OrderStatus.CANCELLED || nextStatus === OrderStatus.REJECTED)
    ) {
      await this.releaseReservedStock(region, current);
    }

    // ── Phase 3 hook: when the kitchen marks order READY, trigger auto-assignment.
    // Fire-and-forget — failures are logged, not thrown to the kitchen.
    if (nextStatus === OrderStatus.READY) {
      this.triggerAutoAssignment(region, updated).catch((err) => {
        this.logger.error(
          `auto-assignment trigger failed for order ${updated.publicId}: ${(err as Error).message}`,
        );
      });
    }

    return updated;
  }

  // ─── Internal delivery status transition (Phase 3) ──────────────────────
  /**
   * Used by AgentController for delivery transitions (pickup, deliver).
   * Bypasses the actor/permission checks that the public updateStatus uses.
   * Settlement is handled here for the DELIVERED transition.
   */
  async updateStatusInternal(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
    nextStatus: OrderStatus,
    timestampColumn: string | null,
  ): Promise<OrderEntity> {
    const trx: Knex.Transaction = await this.knex.db(region).transaction();
    let updated: OrderEntity;
    try {
      updated = await this.orderRepo.updateStatus(
        region,
        orderId,
        orderCreatedAt,
        nextStatus,
        timestampColumn,
        trx,
      );

      // Settlement on delivered: COD flip + agent_earnings insert
      if (nextStatus === OrderStatus.DELIVERED && this._assignmentService) {
        await this._assignmentService.settleDelivered(region, updated, trx);
      }

      // Outbox emit on DELIVERED — analytics-service derives the delivery
      // latency from (placedAt, deliveredAt) and feeds delivery_ms_*
      // rolling sums on the restaurant/branch/platform aggregates.
      if (nextStatus === OrderStatus.DELIVERED) {
        await this.outboxRepo.insertOutboxEvent(region, trx, {
          aggregateType: 'order',
          aggregateId: updated.publicId,
          eventType: EVENT_TYPES.ORDER_DELIVERED,
          payload: {
            orderId: updated.publicId,
            region,
            countryCode: updated.countryCode,
            restaurantId: Number(updated.restaurantId),
            branchId: Number(updated.branchId),
            currency: updated.currency,
            placedAt: new Date(updated.createdAt).toISOString(),
            deliveredAt: new Date(updated.deliveredAt ?? new Date()).toISOString(),
          },
        });
      }

      await trx.commit();
    } catch (err) {
      await trx.rollback();
      throw err;
    }

    // Emit WS events for delivery status
    const branch = await this.branchClient.getBranch(updated.branchId).catch(() => null);
    const updatedWithBranch = {
      ...updated,
      branchName: branch ? branch.restaurantName + ' - ' + branch.label : undefined
    };

    this.wsPublisher.emit(
      `customer:${updated.customerId}`,
      'delivery.status_changed',
      OrderStatusResponseDTO.from(updatedWithBranch as any)
    );
    this.wsPublisher.emit(
      `branch:${updated.branchId}`,
      'delivery.status_changed',
      OrderStatusResponseDTO.from(updatedWithBranch as any)
    );

    // Post-commit Redis cleanup on delivered
    if (
      nextStatus === OrderStatus.DELIVERED &&
      updated.deliveryAgentId &&
      this._assignmentService
    ) {
      await this._assignmentService.postDeliveredRedisCleanup(
        region,
        updated.deliveryAgentId,
        updated.id,
      );
    }

    return updated;
  }

  /**
   * Lazy setter for AssignmentService to break the circular dependency.
   * Called by OrderModule's onModuleInit or via forwardRef injection.
   */
  private _assignmentService: any = null;
  setAssignmentService(svc: any): void {
    this._assignmentService = svc;
  }

  private async triggerAutoAssignment(
    region: string,
    order: OrderEntity,
  ): Promise<void> {
    if (!this._assignmentService) {
      this.logger.warn(
        'AssignmentService not available; skipping auto-assignment',
      );
      return;
    }
    await this._assignmentService.tryAssign(region, order.id, order.createdAt);
  }

  // ─── helpers exposed to PaymentModule (cross-module via OrderService) ────
  /**
   * Read-only loader used by PaymentService when initializing a session and
   * when reconciling webhook events. No access checks — the caller layers
   * those (init checks the customer, webhook trusts the signature).
   */
  async findEntityByPublicId(
    region: string,
    publicId: string,
  ): Promise<OrderEntity | null> {
    return this.orderRepo.findByPublicId(region, publicId);
  }

  /**
   * Lightweight ownership lookup used by PaymentService to satisfy authz
   * checks and expose the publicId on the payment response without loading
   * the full OrderEntity.
   */
  async findOwnershipById(
    region: string,
    id: number,
    createdAt: Date,
  ): Promise<OrderOwnershipView | null> {
    return this.orderRepo.findOwnershipByCompositeId(region, id, createdAt);
  }

  /**
   * Webhook-driven transition: pending_payment -> placed. Trusts the caller
   * (KashierWebhookService runs inside the same trx). Idempotent: returns
   * the current row unchanged when the order is already past pending_payment.
   *
   * Also writes payment.completed to the outbox so analytics can recognize
   * online revenue at capture time (the order.placed event was emitted at
   * pending_payment time when revenue isn't real yet).
   */
  async markPaymentCaptured(
    region: string,
    order: OrderEntity,
    trx: Knex.Transaction,
  ): Promise<OrderEntity> {
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      return order;
    }
    const updated = await this.orderRepo.updateStatus(
      region,
      order.id,
      order.createdAt,
      OrderStatus.PLACED,
      null,
      trx,
    );

    // Fetch items to include in the analytics payload — required so
    // agg_product_day rolls forward for online orders too. Single batch
    // read, in the same trx.
    const items = await this.orderItemRepo.findByOrderIds(region, [
      { orderId: updated.id, orderCreatedAt: updated.createdAt },
    ]);

    await this.outboxRepo.insertOutboxEvent(region, trx, {
      aggregateType: 'order',
      aggregateId: updated.publicId,
      eventType: EVENT_TYPES.PAYMENT_COMPLETED,
      payload: {
        orderId: updated.publicId,
        region,
        countryCode: updated.countryCode,
        restaurantId: Number(updated.restaurantId),
        branchId: Number(updated.branchId),
        total: updated.total,
        currency: updated.currency,
        items: items.map((it) => ({
          productId: Number(it.productId),
          quantity: it.quantity,
          unitPriceSnapshot: it.unitPriceSnapshot,
          lineTotal: it.lineTotal,
        })),
        completedAt: new Date().toISOString(),
      },
    });

    return updated;
  }

  /**
   * Webhook-driven transition for failed online payments: stays in
   * pending_payment so the customer can retry. Returned for caller logging.
   */
  async markPaymentFailed(
    region: string,
    order: OrderEntity,
    _trx: Knex.Transaction,
  ): Promise<OrderEntity> {
    void _trx;
    return order;
  }

  /**
   * Sweeper-driven lookup. Defined here so the worker doesn't reach across
   * modules into OrderRepository.
   */
  async findExpirablePendingPayment(
    region: string,
    graceMinutes: number,
    limit: number,
  ): Promise<ExpirableOrderRow[]> {
    return this.orderRepo.findExpirablePendingPayment(
      region,
      graceMinutes,
      limit,
    );
  }

  /**
   * Post-capture reservation for online orders. Mirrors the COD reservation
   * at placement time, but runs after Kashier captures the money. Caller
   * (KashierWebhookService.postCaptureSettlement) handles the failure path
   * by auto-cancelling the order and refunding the charge.
   *
   * Idempotency key matches the COD reservation pattern so a replay collapses
   * to the same operation on core-service.
   */
  async reserveStockForOnlineCapture(
    region: string,
    order: OrderEntity,
  ): Promise<{
    ok: boolean;
    insufficient?: Array<{ productId: number; requested: number; available: number }>;
  }> {
    const items = await this.orderItemRepo.findByOrderIds(region, [
      { orderId: order.id, orderCreatedAt: order.createdAt },
    ]);
    if (items.length === 0) {
      this.logger.error(
        `reserveStockForOnlineCapture: no items for order ${order.publicId}`,
      );
      return { ok: false, insufficient: [] };
    }
    try {
      const result = await this.branchClient.reserveStock(
        Number(order.branchId),
        items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        `reserve:${order.publicId}`,
      );
      return result;
    } catch (err) {
      this.logger.error(
        `reserveStock (online capture) failed for order ${order.publicId}: ${
          (err as Error).message
        }`,
      );
      // Treat infrastructure failures as "reservation failed" — caller will
      // refund. Better than leaving the order in placed with unreserved stock.
      return { ok: false };
    }
  }

  /**
   * Auto-cancel path used when reserveStock fails after Kashier captured.
   * Transitions placed → cancelled (system actor) and skips releaseStock
   * because nothing was reserved.
   */
  async cancelPlacedOrderForStockFailure(
    region: string,
    order: OrderEntity,
  ): Promise<OrderEntity | null> {
    const trx: Knex.Transaction = await this.knex.db(region).transaction();
    try {
      const current = await trx('orders')
        .select(['id', 'status'])
        .where({ id: order.id, created_at: order.createdAt })
        .forUpdate()
        .first();
      if (!current || current.status !== OrderStatus.PLACED) {
        await trx.rollback();
        return null;
      }
      const updated = await this.orderRepo.updateStatus(
        region,
        order.id,
        order.createdAt,
        OrderStatus.CANCELLED,
        'cancelled_at',
        trx,
      );
      await trx.commit();
      this.logger.warn(
        `order ${order.publicId} auto-cancelled (out of stock after capture)`,
      );
      return updated;
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }

  /**
   * Sweeper-driven cancellation: pending_payment → cancelled when no live
   * session can carry the order forward. Idempotent — returns early if the
   * order has already moved off pending_payment (e.g. a late webhook flipped
   * it to placed between query and update).
   */
  async bulkCancelExpiredOrders(
      region: string,
      candidates: ExpirableOrderRow[],
      trx: Knex.Transaction,
  ): Promise<number> {
    if (!candidates || candidates.length === 0) return 0;

    // 1. Business Logic: Extract what we need
    const ids = candidates.map((c) => c.id);

    // 2. Delegate to the Repository
    return this.orderRepo.bulkCancelPendingPayment(region, ids, trx);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────
  private async buildActor(user: AuthenticatedUser): Promise<Actor> {
    if (user.role === 'system_admin') return { kind: 'system_admin' };
    if (user.role === 'customer') return { kind: 'customer', userId: user.userId };
    if (user.role === 'delivery_agent') return { kind: 'agent', userId: user.userId };
    if (user.role === 'restaurant_user') {
      const perms = await this.permissionCache.getPermissions(
        user.restaurantRole ?? '',
      );
      return {
        kind: 'restaurant',
        userId: user.userId,
        restaurantId: Number(user.restaurantId ?? 0),
        permissions: new Set(perms),
      };
    }
    throw new ForbiddenException(ORDER_ERRORS.FORBIDDEN);
  }

  private assertReadAccess(user: AuthenticatedUser, order: OrderEntity): void {
    if (user.role === 'system_admin') return;
    if (user.role === 'customer' && Number(order.customerId) === Number(user.userId)) return;
    if (
      user.role === 'restaurant_user' &&
      Number(user.restaurantId) === Number(order.restaurantId) &&
      (!user.branchIds || user.branchIds.length === 0 || user.branchIds.includes(Number(order.branchId)))
    ) {
      return;
    }
    throw new ForbiddenException(ORDER_ERRORS.FORBIDDEN);
  }

  private composeAddressText(a: {
    street: string;
    building: string | null;
    apartmentNumber: string | null;
    city: string;
    country: string;
  }): string {
    return [a.street, a.building, a.apartmentNumber, a.city, a.country]
      .filter((s) => s && String(s).trim().length > 0)
      .join(', ');
  }

  private async fetchItemsForOrders(
    region: string,
    orders: OrderEntity[],
  ): Promise<Map<number, OrderItemEntity[]>> {
    const map = new Map<number, OrderItemEntity[]>();
    if (orders.length === 0) return map;
    const rows = await this.orderItemRepo.findByOrderIds(
      region,
      orders.map((o) => ({ orderId: o.id, orderCreatedAt: o.createdAt })),
    );
    for (const r of rows) {
      const arr = map.get(r.orderId) ?? [];
      arr.push(r);
      map.set(r.orderId, arr);
    }
    return map;
  }

  private async voidOrderForOutOfStock(
    region: string,
    order: OrderEntity,
  ): Promise<void> {
    const trx: Knex.Transaction = await this.knex.db(region).transaction();
    try {
      await this.orderRepo.updateStatus(
        region,
        order.id,
        order.createdAt,
        OrderStatus.CANCELLED,
        'cancelled_at',
        trx,
      );
      await trx.commit();
    } catch (err) {
      await trx.rollback();
      this.logger.error(
        `failed to void order ${order.publicId} after stock failure: ${(err as Error).message}`,
      );
    }
  }

  // Best-effort release: a failure here must not roll back the cancellation
  // (the order is already cancelled in DB). Drift is reconciled by the
  // restaurant manually adjusting stock if the call ever fails.
  private async releaseReservedStock(
    region: string,
    order: OrderEntity,
  ): Promise<void> {
    try {
      const items = await this.orderItemRepo.findByOrderIds(region, [
        { orderId: order.id, orderCreatedAt: order.createdAt },
      ]);
      if (items.length === 0) return;
      await this.branchClient.releaseStock(
        Number(order.branchId),
        items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        `release:${order.publicId}`,
      );
    } catch (err) {
      this.logger.error(
        `releaseStock failed for order ${order.publicId}: ${(err as Error).message}`,
      );
    }
  }
}
