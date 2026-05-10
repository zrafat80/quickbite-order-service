export interface Log {
  id?: number;
  timestamp?: Date;
  level?: string;
  correlationId?: string;
  packetType: string;
  userId?: number;
  ipAddress?: string;
  userAgent?: string;
  action: string;
  endpoint: string;
  method: string;
  responseTime?: number;
  errorMessage?: string;
  trace?: string;
  metadata?: string;
  region?: string;
}
