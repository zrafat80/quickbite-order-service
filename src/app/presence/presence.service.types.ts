export interface GoOfflineResult {
  ok: boolean;
  /** If the agent had an assigned order, its orderId is returned for reassignment. */
  reassignOrderId?: number;
  reassignOrderCreatedAt?: Date;
  reassignOrderRegion?: string;
}
