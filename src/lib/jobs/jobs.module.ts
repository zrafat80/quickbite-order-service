import { Module } from '@nestjs/common';
import { ArchivalWorker } from './archival.worker';
import { AssignmentSweeperWorker } from './assignment-sweeper.worker';
import { OrderModule } from '../../app/order/order.module';
import { AgentModule } from '../../app/agent/agent.module';

@Module({
  imports: [OrderModule, AgentModule],
  providers: [ArchivalWorker, AssignmentSweeperWorker],
})
export class JobsModule {}
