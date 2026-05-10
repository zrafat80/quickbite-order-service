import { Injectable } from '@nestjs/common';
import { WsGateway } from './ws.gateway';

/**
 * Services in later phases inject `WsPublisher` and call `emit(channel, ...)`
 * after a status transition commits. The Redis adapter on the gateway
 * fans out across all workers in the region.
 */
@Injectable()
export class WsPublisher {
  constructor(private readonly gateway: WsGateway) {}

  emit(channel: string, event: string, payload: unknown): void {
    this.gateway.server?.to(channel).emit(event, payload);
  }
}
