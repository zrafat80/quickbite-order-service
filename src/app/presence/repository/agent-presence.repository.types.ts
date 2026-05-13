export interface UpsertPresenceInput {
  agentId: number;
  region: string;
  lat: number;
  lng: number;
}

export interface NearestAgentRow {
  agentId: number;
  distanceMeters: number;
}
