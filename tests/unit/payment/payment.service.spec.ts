import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentMethod } from 'src/app/order/enums';
import { OrderService } from 'src/app/order/order.service';
import {
  PaymentProviderName,
  PaymentSessionStatus,
  TransactionMethod,
  TransactionStatus,
  TransactionType,
} from 'src/app/payment/enums';
import { KashierProviderService } from 'src/app/payment/kashier-provider.service';
import { PaymentService } from 'src/app/payment/payment.service';
import { PaymentProviderRepository } from 'src/app/payment/repository/payment-provider.repository';
import { PaymentSessionRepository } from 'src/app/payment/repository/payment-session.repository';
import { TransactionRepository } from 'src/app/payment/repository/transaction.repository';
import { createShardedKnexMock } from '../helpers/test-doubles';

describe('PaymentService', () => {
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        'kashier.returnUrl': 'https://app.test/return',
        'kashier.failUrl': 'https://app.test/fail',
        'kashier.serverWebhookUrl': 'https://api.test/webhook',
      };
      return values[key];
    }),
  };
  const orders = {
    findEntityByPublicId: jest.fn(),
    findOwnershipById: jest.fn(),
  };
  const sessions = {
    findLatestActiveByOrderId: jest.fn(),
    create: jest.fn(),
  };
  const transactions = {
    findById: jest.fn(),
    findRefundsForCharge: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
  };
  const providers = {
    findByName: jest.fn(),
    findById: jest.fn(),
  };
  const kashier = {
    createSession: jest.fn(),
    refund: jest.fn(),
  };
  let doubles: ReturnType<typeof createShardedKnexMock>;
  let service: PaymentService;
  const actor = { userId: 7, role: 'customer' };
  const order = {
    id: 4,
    publicId: 'order-1',
    customerId: 7,
    restaurantId: 5,
    createdAt: new Date('2026-06-07T10:00:00.000Z'),
    paymentMethod: PaymentMethod.ONLINE,
    status: OrderStatus.PENDING_PAYMENT,
    total: 2500,
    currency: 'EGP',
  };

  beforeEach(() => {
    for (const group of [
      orders,
      sessions,
      transactions,
      providers,
      kashier,
    ]) {
      for (const value of Object.values(group)) value.mockReset();
    }
    doubles = createShardedKnexMock();
    service = new PaymentService(
      doubles.knex,
      config as unknown as ConfigService,
      orders as unknown as OrderService,
      sessions as unknown as PaymentSessionRepository,
      transactions as unknown as TransactionRepository,
      providers as unknown as PaymentProviderRepository,
      kashier as unknown as KashierProviderService,
    );
  });

  it('validates region, order ownership, method, and status', async () => {
    await expect(service.init(actor, '', 'order-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    orders.findEntityByPublicId.mockResolvedValueOnce(undefined);
    await expect(service.init(actor, 'eg', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    orders.findEntityByPublicId.mockResolvedValue({
      ...order,
      customerId: 8,
    });
    await expect(service.init(actor, 'eg', 'order-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    orders.findEntityByPublicId.mockResolvedValue({
      ...order,
      paymentMethod: PaymentMethod.COD,
    });
    await expect(service.init(actor, 'eg', 'order-1')).rejects.toBeInstanceOf(
      ConflictException,
    );

    orders.findEntityByPublicId.mockResolvedValue({
      ...order,
      status: OrderStatus.PLACED,
    });
    await expect(service.init(actor, 'eg', 'order-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('reuses an active payment session', async () => {
    const existing = { id: 3, status: PaymentSessionStatus.INITIALIZED };
    orders.findEntityByPublicId.mockResolvedValue(order);
    sessions.findLatestActiveByOrderId.mockResolvedValue(existing);

    await expect(service.init(actor, 'eg', 'order-1')).resolves.toEqual({
      session: existing,
      order,
    });
    expect(providers.findByName).not.toHaveBeenCalled();
  });

  it('rejects disabled providers and translates provider failures', async () => {
    orders.findEntityByPublicId.mockResolvedValue(order);
    sessions.findLatestActiveByOrderId.mockResolvedValue(undefined);
    providers.findByName.mockResolvedValue({
      id: 1,
      name: PaymentProviderName.KASHIER,
      isEnabled: false,
    });
    await expect(service.init(actor, 'eg', 'order-1')).rejects.toBeInstanceOf(
      ConflictException,
    );

    providers.findByName.mockResolvedValue({
      id: 1,
      name: PaymentProviderName.KASHIER,
      isEnabled: true,
    });
    kashier.createSession.mockRejectedValue(new Error('provider down'));
    await expect(service.init(actor, 'eg', 'order-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('creates a Kashier session with persisted provider data', async () => {
    const expiresAt = new Date('2026-06-07T10:15:00.000Z');
    const session = { id: 3, status: PaymentSessionStatus.INITIALIZED };
    orders.findEntityByPublicId.mockResolvedValue(order);
    sessions.findLatestActiveByOrderId.mockResolvedValue(undefined);
    providers.findByName.mockResolvedValue({
      id: 1,
      isEnabled: true,
    });
    kashier.createSession.mockResolvedValue({
      providerSessionId: 'ks-1',
      redirectUrl: 'https://pay.test/ks-1',
      expiresAt,
    });
    sessions.create.mockResolvedValue(session);

    await expect(service.init(actor, 'eg', 'order-1')).resolves.toEqual({
      session,
      order,
    });
    expect(kashier.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        amountMinor: 2500,
        currency: 'EGP',
        metadata: { serverWebhook: 'https://api.test/webhook' },
      }),
    );
    expect(sessions.create).toHaveBeenCalledWith(
      'eg',
      expect.objectContaining({
        providerSessionId: 'ks-1',
        status: PaymentSessionStatus.INITIALIZED,
      }),
    );
  });

  it('loads payment details for administrators and restaurant owners', async () => {
    const tx = {
      id: 9,
      orderId: 4,
      orderCreatedAt: order.createdAt,
      providerId: 1,
    };
    transactions.findById.mockResolvedValue(tx);
    orders.findOwnershipById.mockResolvedValue({
      restaurantId: 5,
      publicId: 'order-1',
    });
    providers.findById.mockResolvedValue({ name: 'kashier' });

    await expect(
      service.getById({ userId: 1, role: 'system_admin' }, 'eg', 9),
    ).resolves.toEqual({
      tx,
      order: { restaurantId: 5, publicId: 'order-1' },
      providerName: 'kashier',
    });
    await expect(
      service.getById(
        { userId: 8, role: 'restaurant_user', restaurantId: 5 },
        'eg',
        9,
      ),
    ).resolves.toMatchObject({ tx });
  });

  it('guards missing and unauthorized payment reads', async () => {
    await expect(
      service.getById({ userId: 1, role: 'system_admin' }, '', 9),
    ).rejects.toBeInstanceOf(BadRequestException);

    transactions.findById.mockResolvedValue(undefined);
    await expect(
      service.getById({ userId: 1, role: 'system_admin' }, 'eg', 9),
    ).rejects.toBeInstanceOf(NotFoundException);

    transactions.findById.mockResolvedValue({
      id: 9,
      orderId: null,
      orderCreatedAt: null,
    });
    await expect(
      service.getById({ userId: 7, role: 'customer' }, 'eg', 9),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('guards public refunds by region and role', async () => {
    await expect(
      service.refund(
        { userId: 1, role: 'system_admin' },
        '',
        9,
        { amount: 100, reason: 'test' },
        'refund-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.refund(
        { userId: 7, role: 'customer' },
        'eg',
        9,
        { amount: 100, reason: 'test' },
        'refund-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects missing, ineligible, exhausted, and oversized refunds', async () => {
    transactions.findById.mockResolvedValueOnce(undefined);
    await expect(
      service.systemRefundCharge('eg', 9, 'reason'),
    ).rejects.toBeInstanceOf(NotFoundException);

    transactions.findById.mockResolvedValue({
      id: 9,
      transactionType: TransactionType.PAYOUT,
      status: TransactionStatus.SUCCEEDED,
    });
    await expect(
      service.systemRefundCharge('eg', 9, 'reason'),
    ).rejects.toBeInstanceOf(ConflictException);

    const charge = {
      id: 9,
      transactionType: TransactionType.CHARGE,
      status: TransactionStatus.SUCCEEDED,
      amount: 1000,
      method: TransactionMethod.COD,
      currency: 'EGP',
    };
    transactions.findById.mockResolvedValue(charge);
    transactions.findRefundsForCharge.mockResolvedValue([
      { amount: 1000, status: TransactionStatus.SUCCEEDED },
    ]);
    await expect(
      service.systemRefundCharge('eg', 9, 'reason'),
    ).rejects.toBeInstanceOf(ConflictException);

    transactions.findRefundsForCharge.mockResolvedValue([]);
    await expect(
      service.refund(
        { userId: 1, role: 'system_admin' },
        'eg',
        9,
        { amount: 1001, reason: 'too much' },
        'refund-large',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('replays an idempotent refund', async () => {
    transactions.findById.mockResolvedValue({
      id: 9,
      transactionType: TransactionType.CHARGE,
      status: TransactionStatus.SUCCEEDED,
      amount: 1000,
    });
    transactions.findRefundsForCharge.mockResolvedValue([]);
    const existing = { id: 10, transactionType: TransactionType.REFUND };
    transactions.findByIdempotencyKey.mockResolvedValue(existing);

    await expect(
      service.systemRefundCharge('eg', 9, 'reason'),
    ).resolves.toBe(existing);
  });

  it('creates and immediately succeeds a COD refund', async () => {
    const charge = {
      id: 9,
      orderId: 4,
      orderCreatedAt: order.createdAt,
      transactionType: TransactionType.CHARGE,
      status: TransactionStatus.SUCCEEDED,
      amount: 1000,
      method: TransactionMethod.COD,
      currency: 'EGP',
      srcAccId: 7,
    };
    const refund = {
      id: 10,
      status: TransactionStatus.PENDING,
      amount: 1000,
    };
    transactions.findById.mockResolvedValue(charge);
    transactions.findRefundsForCharge.mockResolvedValue([]);
    transactions.findByIdempotencyKey.mockResolvedValue(undefined);
    transactions.create.mockResolvedValue(refund);

    await expect(
      service.systemRefundCharge('eg', 9, 'reason'),
    ).resolves.toMatchObject({
      id: 10,
      status: TransactionStatus.SUCCEEDED,
    });
    expect(doubles.transaction.commit).toHaveBeenCalled();
    expect(transactions.updateStatus).toHaveBeenCalledWith('eg', 10, {
      status: TransactionStatus.SUCCEEDED,
    });
  });

  it('submits online refunds and records provider failure', async () => {
    const charge = {
      id: 9,
      orderId: 4,
      orderCreatedAt: order.createdAt,
      transactionType: TransactionType.CHARGE,
      status: TransactionStatus.SUCCEEDED,
      amount: 1000,
      method: TransactionMethod.ONLINE,
      currency: 'EGP',
      srcAccId: 7,
      providerId: 1,
      providerReferenceId: 'charge-1',
      providerOrderId: 'provider-order-1',
    };
    const refund = { id: 10, status: TransactionStatus.PENDING };
    transactions.findById.mockResolvedValue(charge);
    transactions.findRefundsForCharge.mockResolvedValue([]);
    transactions.findByIdempotencyKey.mockResolvedValue(undefined);
    transactions.create.mockResolvedValue(refund);
    kashier.refund.mockResolvedValue({ providerRefundId: 'refund-1' });

    await expect(
      service.systemRefundCharge('eg', 9, 'reason'),
    ).resolves.toMatchObject({ providerReferenceId: 'refund-1' });

    kashier.refund.mockRejectedValue(new Error('provider down'));
    transactions.create.mockResolvedValue({ id: 11 });
    await expect(
      service.refund(
        { userId: 1, role: 'system_admin' },
        'eg',
        9,
        { amount: 100, reason: 'reason' },
        'refund-2',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transactions.updateStatus).toHaveBeenCalledWith('eg', 11, {
      status: TransactionStatus.FAILED,
    });
  });

  it('exposes order initialization and provider lookup helpers', async () => {
    jest.spyOn(service, 'init').mockResolvedValue({
      session: { id: 3 },
      order,
    } as never);
    await expect(
      service.initForOrderEntity(actor, 'eg', order as never),
    ).resolves.toEqual({ id: 3 });

    providers.findByName
      .mockResolvedValueOnce({ id: 8 })
      .mockResolvedValue(undefined);
    await expect(service.findKashierProviderId('eg')).resolves.toBe(8);
    await expect(service.findKashierProviderId('eg')).resolves.toBe(1);
  });
});
