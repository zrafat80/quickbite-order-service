import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { ShardedKnex } from '../../../lib/sharding/shards';
import { RestaurantBalanceEntity } from '../entity/restaurant-balance.entity';

const RESTAURANT_BALANCE_COLUMNS = [
  'id',
  'region',
  'restaurant_id',
  'currency',
  'balance',
  'updated_at',
];

@Injectable()
export class RestaurantBalanceRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  async getBalance(
    region: string,
    restaurantId: number,
    currency: string,
    trx?: Knex.Transaction,
  ): Promise<RestaurantBalanceEntity | null> {
    const db = trx ?? this.knex.db(region);
    const row = await db('restaurant_balances')
      .where({
        region,
        restaurant_id: restaurantId,
        currency,
      })
      .first(RESTAURANT_BALANCE_COLUMNS);

    if (!row) return null;
    return this.toEntity(row);
  }

  async incrementBalance(
    region: string,
    restaurantId: number,
    currency: string,
    amount: number, // positive to add, negative to subtract
    trx?: Knex.Transaction,
  ): Promise<RestaurantBalanceEntity> {
    const db = trx ?? this.knex.db(region);
    
    // We use raw to handle the UPSERT case because ON CONFLICT is standard PostgreSQL
    const query = `
      INSERT INTO restaurant_balances (region, restaurant_id, currency, balance, updated_at)
      VALUES (?, ?, ?, ?, NOW())
      ON CONFLICT (restaurant_id, currency)
      DO UPDATE SET 
        balance = restaurant_balances.balance + EXCLUDED.balance,
        updated_at = NOW()
      RETURNING *;
    `;
    
    const result = await db.raw(query, [region, restaurantId, currency, amount]);
    return this.toEntity(result.rows[0]);
  }

  async claimForUpdate(
    region: string,
    restaurantId: number,
    currency: string,
    trx: Knex.Transaction,
  ): Promise<RestaurantBalanceEntity> {
    // Upsert the row with 0 if it doesn't exist, then select FOR UPDATE
    await this.incrementBalance(region, restaurantId, currency, 0, trx);
    
    const row = await trx('restaurant_balances')
      .where({
        region,
        restaurant_id: restaurantId,
        currency,
      })
      .forUpdate()
      .first(RESTAURANT_BALANCE_COLUMNS);
      
    return this.toEntity(row);
  }

  private toEntity(row: any): RestaurantBalanceEntity {
    return new RestaurantBalanceEntity({
      id: Number(row.id),
      region: row.region,
      restaurantId: Number(row.restaurant_id),
      currency: row.currency,
      balance: Number(row.balance),
      updatedAt: row.updated_at,
    });
  }
}
