export class RestaurantBalanceEntity {
  id!: number;
  region!: string;
  restaurantId!: number;
  currency!: string;
  balance!: number;
  updatedAt!: Date;

  constructor(partial?: Partial<RestaurantBalanceEntity>) {
    if (partial) {
      Object.assign(this, partial);
    }
  }
}
