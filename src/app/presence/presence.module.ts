import { forwardRef, Module } from '@nestjs/common';
import { PresenceService } from './presence.service';
import { AgentPresenceRepository } from './repository/agent-presence.repository';
import { OrderModule } from '../order/order.module';

@Module({
  imports: [forwardRef(() => OrderModule)],
  providers: [PresenceService, AgentPresenceRepository],
  exports: [PresenceService, AgentPresenceRepository],
})
export class PresenceModule {}
