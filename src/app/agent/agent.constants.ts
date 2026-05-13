export const AGENT_ERRORS = {
  AGENTS_ONLY: 'Only delivery agents can perform this action',
  NOT_ASSIGNED: 'You are not the assigned agent for this order',
  INVALID_DELIVERY_STATUS: 'Invalid delivery status transition',
  ORDER_NOT_ASSIGNABLE: 'Order is not in a state that allows assignment',
  ASSIGNMENT_EXHAUSTED:
    'All assignment attempts exhausted; order left as ready for admin review',
  NO_CANDIDATES: 'No available delivery agents found within radius',
  AGENT_STALE:
    'Agent presence is stale (last seen too long ago); dropped from candidates',
} as const;

export const AGENT_EARNING_COLUMNS = [
  'id',
  'region',
  'agent_id',
  'order_id',
  'order_created_at',
  'amount',
  'currency',
  'earned_at',
] as const;
