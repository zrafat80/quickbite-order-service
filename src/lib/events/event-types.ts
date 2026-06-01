/**
 * Outbound event-type constants. analytics-service binds the `order.events`
 * exchange with `order.#, payment.#` — keep routing keys aligned.
 */
export const EVENT_TYPES = {
  ORDER_PLACED: 'order.placed',
  ORDER_DELIVERED: 'order.delivered',
  ORDER_REJECTED: 'order.rejected',
  PAYMENT_COMPLETED: 'payment.completed',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
