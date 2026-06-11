import { Knex } from 'knex';
import { randomUUID } from 'crypto';

export const FIXED_DATE = new Date('2026-05-01T10:00:00.000Z');

export async function seedOrder(
  database: Knex,
  overrides: Record<string, unknown> = {},
) {
  const createdAt = (overrides.created_at as Date | undefined) ?? FIXED_DATE;
  const [order] = await database('orders')
    .insert({
      region: 'eg',
      public_id: randomUUID(),
      country_code: 'EG',
      restaurant_id: 3,
      branch_id: 2,
      customer_id: 7,
      customer_address_id: 9,
      delivery_lat: 30.05,
      delivery_lng: 31.24,
      delivery_address_text_snapshot: '12 Nile Street, Cairo',
      status: 'placed',
      subtotal: 1000,
      delivery_fee: 100,
      service_fee: 0,
      total: 1100,
      commission: 0,
      currency: 'EGP',
      payment_method: 'cod',
      delivery_agent_id: null,
      assignment_attempts: 0,
      created_at: createdAt,
      updated_at: createdAt,
      accepted_at: null,
      rejected_at: null,
      ready_at: null,
      assigned_at: null,
      picked_at: null,
      delivered_at: null,
      cancelled_at: null,
      ...overrides,
    })
    .returning('*');
  return order;
}

export async function seedOrderItem(
  database: Knex,
  order: Record<string, any>,
  overrides: Record<string, unknown> = {},
) {
  const [item] = await database('order_items')
    .insert({
      region: 'eg',
      order_id: order.id,
      order_created_at: order.created_at,
      product_id: 12,
      quantity: 2,
      unit_price_snapshot: 500,
      name_snapshot: 'Chicken Sandwich',
      image_url_snapshot: null,
      line_total: 1000,
      created_at: order.created_at,
      ...overrides,
    })
    .returning('*');
  return item;
}

export async function seedTransaction(
  database: Knex,
  order: Record<string, any> | null,
  overrides: Record<string, unknown> = {},
) {
  const [transaction] = await database('transactions')
    .insert({
      region: 'eg',
      order_id: order?.id ?? null,
      order_created_at: order?.created_at ?? null,
      transaction_type: 'charge',
      method: 'online',
      provider_id: 1,
      provider_reference_id: 'charge-provider-1',
      provider_order_id: 'provider-order-1',
      status: 'succeeded',
      amount: order?.total ?? 1100,
      currency: 'EGP',
      src_acc_id: order?.customer_id ?? 7,
      dst_acc_id: null,
      is_refunded: false,
      refunded_payment_id: null,
      idempotency_key: null,
      reason: null,
      created_at: order?.created_at ?? FIXED_DATE,
      updated_at: order?.created_at ?? FIXED_DATE,
      ...overrides,
    })
    .returning('*');
  return transaction;
}

export async function seedPaymentSession(
  database: Knex,
  order: Record<string, any>,
  overrides: Record<string, unknown> = {},
) {
  const [session] = await database('payment_sessions')
    .insert({
      region: 'eg',
      order_id: order.id,
      order_created_at: order.created_at,
      provider_id: 1,
      provider_session_id: `seed-session-${order.id}`,
      redirect_url: 'https://quickbite.test/checkout',
      amount: order.total,
      currency: order.currency,
      status: 'initialized',
      raw_init_payload: {},
      raw_last_payload: null,
      expires_at: new Date(Date.now() + 15 * 60_000),
      created_at: order.created_at,
      updated_at: order.created_at,
      ...overrides,
    })
    .returning('*');
  return session;
}
