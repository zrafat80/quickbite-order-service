import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../cache/redis.module';
import { AuthUtilsService } from '../auth/auth-utils.service';
import { authenticateHandshake, permittedChannels, WsJwtPayload } from './ws-auth';
import { toMs } from '../../pkg/utils/time.utils';

@WebSocketGateway({
  path: '/ws',
  serveClient: false,
  cors: { origin: true, credentials: true },
})
export class WsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly authUtils: AuthUtilsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Install the Redis adapter so `io.to(room).emit(...)` on any worker reaches
   * every connected socket in every worker for that room. ioredis can't serve
   * commands once it's in subscribe mode — duplicate the publisher for the
   * subscriber side.
   */
  afterInit(server: Server) {
    const subscriber = this.redis.duplicate();
    // ioredis throws unhandledError if no listener is attached. The publisher
    // already has one wired in RedisModule; the duplicated subscriber needs
    // its own.
    subscriber.on('error', (err) =>
      this.logger.error(`ws redis subscriber error: ${err.message}`),
    );
    server.adapter(createAdapter(this.redis, subscriber));
    const heartbeat = this.configService.get<number>('ws.heartbeatSec') ?? 30;
    server.engine.opts.pingInterval = toMs(heartbeat, 's');
    this.logger.log(`ws gateway ready (path=/ws, heartbeat=${heartbeat}s)`);
  }

  async handleConnection(socket: Socket) {
    let user: WsJwtPayload;
    try {
      user = authenticateHandshake(
        {
          auth: socket.handshake.auth as { token?: string } | undefined,
          headers: socket.handshake.headers,
        },
        (token) => this.authUtils.verifyAccessToken(token) as WsJwtPayload,
      );
    } catch (err) {
      this.logger.warn(`ws auth rejected: ${(err as Error).message}`);
      socket.disconnect(true);
      return;
    }

    const allowed = permittedChannels(user);
    socket.data.user = user;
    socket.data.allowed = allowed;

    socket.emit('hello', { allowedChannels: [...allowed] });

    socket.on('subscribe', (channel: string, ack?: (res: unknown) => void) => {
      if (typeof channel !== 'string' || !allowed.has(channel)) {
        ack?.({ ok: false, error: 'not permitted' });
        return;
      }
      socket.join(channel);
      ack?.({ ok: true });
      socket.emit('subscribed', { channel });
    });

    socket.on('unsubscribe', (channel: string) => {
      if (typeof channel === 'string') socket.leave(channel);
    });
  }

  handleDisconnect(socket: Socket) {
    const user = socket.data.user as WsJwtPayload | undefined;
    if (user) {
      this.logger.log(`ws disconnected userId=${user.userId}`);
    }
  }
}
