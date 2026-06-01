import { forwardRef, Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentEarningRepository } from './repository/agent-earning.repository';
import { PresenceService } from './presence.service';
import { AgentPresenceRepository } from './repository/agent-presence.repository';
import { OrderModule } from '../order/order.module';

@Module({
  imports: [forwardRef(() => OrderModule)],
  controllers: [AgentController],
  providers: [AgentService, AgentEarningRepository, PresenceService, AgentPresenceRepository],
  exports: [AgentService, AgentEarningRepository, PresenceService, AgentPresenceRepository],
})
export class AgentModule {}
