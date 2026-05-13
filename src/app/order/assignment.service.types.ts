export interface AssignmentCandidate {
  agentId: number;
  distance: number; // meters
  activeOrders: number;
  lastSeenAt: number; // epoch ms
}

export interface TryAssignResult {
  assigned: boolean;
  agentId?: number;
  exhausted?: boolean;
}
