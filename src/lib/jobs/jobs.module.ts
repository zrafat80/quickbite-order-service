import { Module } from '@nestjs/common';
import { ArchivalWorker } from './archival.worker';
import { AssignmentSweeperWorker } from './assignment-sweeper.worker';
import { OrderModule } from '../../app/order/order.module';
import { PresenceModule } from '../../app/presence/presence.module';

@Module({
  imports: [OrderModule, PresenceModule],
  providers: [ArchivalWorker, AssignmentSweeperWorker],
})
export class JobsModule {}
