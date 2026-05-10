export interface BulkInsertItemInput {
  region: string;
  orderId: number;
  orderCreatedAt: Date;
  productId: number;
  quantity: number;
  unitPriceSnapshot: number;
  nameSnapshot: string;
  imageUrlSnapshot: string | null;
  lineTotal: number;
}

export interface FindByOrderIdsKey {
  orderId: number;
  orderCreatedAt: Date;
}
