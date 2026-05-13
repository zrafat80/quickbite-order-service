import { forwardRef, Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentEarningRepository } from './repository/agent-earning.repository';
import { PresenceModule } from '../presence/presence.module';
import { OrderModule } from '../order/order.module';

@Module({
  imports: [PresenceModule, forwardRef(() => OrderModule)],
  controllers: [AgentController],
  providers: [AgentService, AgentEarningRepository],
  exports: [AgentService, AgentEarningRepository],
})
export class AgentModule {}
