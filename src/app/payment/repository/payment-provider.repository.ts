import { Inject, Injectable } from '@nestjs/common';
import { PaymentProviderEntity } from '../entity/payment-provider.entity';
import { PAYMENT_PROVIDER_COLUMNS } from '../payment.constants';
import { ShardedKnex } from '../../../lib/sharding/shards';

@Injectable()
export class PaymentProviderRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private toEntity(row: any): PaymentProviderEntity {
    return new PaymentProviderEntity({
      id: Number(row.id),
      name: row.name,
      isEnabled: Boolean(row.is_enabled),
      priority: Number(row.priority),
    });
  }

  async findByName(
    region: string,
    name: string,
  ): Promise<PaymentProviderEntity | null> {
    const row = await this.knex
      .db(region)('payment_providers')
      .select(PAYMENT_PROVIDER_COLUMNS as unknown as string[])
      .where('name', name)
      .first();
    return row ? this.toEntity(row) : null;
  }

  async findById(
    region: string,
    id: number,
  ): Promise<PaymentProviderEntity | null> {
    const row = await this.knex
      .db(region)('payment_providers')
      .select(PAYMENT_PROVIDER_COLUMNS as unknown as string[])
      .where('id', id)
      .first();
    return row ? this.toEntity(row) : null;
  }
}
