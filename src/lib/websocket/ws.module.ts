import { Global, Module } from '@nestjs/common';
import { WsGateway } from './ws.gateway';
import { WsPublisher } from './ws.publisher';

@Global()
@Module({
  providers: [WsGateway, WsPublisher],
  exports: [WsPublisher],
})
export class WsModule {}
