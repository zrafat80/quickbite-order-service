export class AgentPresenceEntity {
  agentId!: number;
  region!: string;
  isOnline!: boolean;
  lastLat!: number | null;
  lastLng!: number | null;
  lastSeenAt!: Date;
  updatedAt!: Date;

  constructor(data: Partial<AgentPresenceEntity>) {
    Object.assign(this, data);
  }
}
