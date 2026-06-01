export const PRESENCE_ERRORS = {
  AGENTS_ONLY: 'Only delivery agents can perform this action',
  REGION_REQUIRED: 'X-Region header is required for this operation',
  NOT_ONLINE: 'Agent is not online; call /agents/presence/online first',
  ACTIVE_PICKUP_BLOCKS_OFFLINE:
    'Cannot go offline while a delivery is in pickup; complete the delivery first',
} as const;

export const AGENT_PRESENCE_COLUMNS = [
  'agent_id',
  'region',
  'is_online',
  'last_lat',
  'last_lng',
  'last_seen_at',
  'updated_at',
] as const;

// Redis key builders shared by PresenceService and AssignmentService.
export const presenceKeys = {
  geo: (region: string): string => `presence:geo:${region}`,
  meta: (region: string, agentId: number | string): string =>
    `presence:meta:${region}:${agentId}`,
  busy: (region: string): string => `presence:busy:${region}`,
  // SET of agent_ids who rejected/timed-out for this order's current
  // assignment loop. Carries a TTL longer than the loop budget.
  reject: (orderId: number | string): string => `assign:reject:${orderId}`,
} as const;

export const PRESENCE_REJECT_TTL_SEC = 600; // 10 minutes — covers a long-tailed retry loop
