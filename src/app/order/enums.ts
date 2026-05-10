// Values must match the CHECK constraint on `orders.status`.
export enum OrderStatus {
  PENDING_PAYMENT = 'pending_payment',
  PLACED = 'placed',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  PREPARING = 'preparing',
  READY = 'ready',
  ASSIGNED = 'assigned',
  PICKED = 'picked',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

// Values must match the CHECK constraint on `orders.payment_method`.
export enum PaymentMethod {
  ONLINE = 'online',
  COD = 'cod',
}
