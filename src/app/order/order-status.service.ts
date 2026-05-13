import { ConflictException, Injectable } from '@nestjs/common';
import { OrderStatus } from './enums';
import { ORDER_ERRORS } from './order.constants';

export type Actor =
  | { kind: 'customer'; userId: number }
  | { kind: 'restaurant'; userId: number; restaurantId: number; permissions: Set<string> }
  | { kind: 'system_admin' }
  | { kind: 'system' }
  | { kind: 'agent'; userId: number };

interface TransitionRule {
  from: OrderStatus;
  to: OrderStatus;
  actors: Array<Actor['kind']>;
  // Optional permission gate for restaurant_user actors. If set, the actor must
  // hold one of these "resource:action" permissions.
  permission?: string;
  // Column to stamp with NOW() on success. null means "no extra timestamp".
  timestampColumn: string | null;
}

const RULES: TransitionRule[] = [
  // pending_payment is moved off by:
  //   - the webhook capture path -> placed (handled in OrderService.markPaymentCaptured)
  //   - the sweeper / auto-refund path -> cancelled (system actor)
  { from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.CANCELLED, actors: ['system_admin', 'system'], timestampColumn: 'cancelled_at' },

  { from: OrderStatus.PLACED, to: OrderStatus.ACCEPTED, actors: ['restaurant', 'system_admin'], permission: 'orders:accept', timestampColumn: 'accepted_at' },
  { from: OrderStatus.PLACED, to: OrderStatus.REJECTED, actors: ['restaurant', 'system_admin'], permission: 'orders:cancel', timestampColumn: 'rejected_at' },
  // 'system' added so the post-capture stock-failure path can cancel a just-placed order.
  { from: OrderStatus.PLACED, to: OrderStatus.CANCELLED, actors: ['customer', 'system_admin', 'system'], timestampColumn: 'cancelled_at' },

  { from: OrderStatus.ACCEPTED, to: OrderStatus.PREPARING, actors: ['restaurant', 'system_admin'], permission: 'orders:update', timestampColumn: null },
  { from: OrderStatus.ACCEPTED, to: OrderStatus.CANCELLED, actors: ['restaurant', 'system_admin'], permission: 'orders:cancel', timestampColumn: 'cancelled_at' },

  { from: OrderStatus.PREPARING, to: OrderStatus.READY, actors: ['restaurant', 'system_admin'], permission: 'orders:update', timestampColumn: 'ready_at' },
  { from: OrderStatus.PREPARING, to: OrderStatus.CANCELLED, actors: ['restaurant', 'system_admin'], permission: 'orders:cancel', timestampColumn: 'cancelled_at' },

  { from: OrderStatus.READY, to: OrderStatus.CANCELLED, actors: ['restaurant', 'system_admin'], permission: 'orders:cancel', timestampColumn: 'cancelled_at' },
];

@Injectable()
export class OrderStatusService {
  /**
   * Throws ConflictException if the actor is not allowed to perform the
   * requested transition. Returns the timestamp column to stamp (if any).
   */
  assertTransition(
    from: OrderStatus,
    to: OrderStatus,
    actor: Actor,
  ): { timestampColumn: string | null } {
    const rule = RULES.find((r) => r.from === from && r.to === to);
    if (!rule) {
      throw new ConflictException(
        `${ORDER_ERRORS.INVALID_STATUS_TRANSITION} (${from} -> ${to})`,
      );
    }
    if (!rule.actors.includes(actor.kind)) {
      throw new ConflictException(
        `${ORDER_ERRORS.INVALID_STATUS_TRANSITION} (actor=${actor.kind})`,
      );
    }
    if (rule.permission && actor.kind === 'restaurant') {
      if (!actor.permissions.has(rule.permission)) {
        throw new ConflictException(
          `${ORDER_ERRORS.INVALID_STATUS_TRANSITION} (missing ${rule.permission})`,
        );
      }
    }
    return { timestampColumn: rule.timestampColumn };
  }
}
