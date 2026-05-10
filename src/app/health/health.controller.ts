import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ShardedKnex } from '../../lib/sharding/shards';

@Controller('health')
export class HealthController {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  /**
   * Pings every configured shard (hot + archive when present). Returns 200
   * iff every hot shard is reachable; archive misses don't fail the check
   * (they're best-effort in dev where the cold cluster doesn't exist yet).
   *
   * Response shape skips `SuccessInterceptor` because we use `@Res()` — k8s
   * probes expect `{ ok, shards }` straight at the top level.
   */
  @Get()
  async check(@Res() res: Response) {
    const shards = await this.knex.pingAll();
    const hotOk = shards.filter((s) => s.cluster === 'hot').every((s) => s.ok);
    res.status(hotOk ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      ok: hotOk,
      shards,
    });
  }
}
