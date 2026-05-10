import { Inject, Injectable, Logger, LoggerService } from '@nestjs/common';
import { Log } from './log.interface';
import { ShardedKnex } from '../sharding/shards';

/**
 * Writes a row per request to the per-region `logs` table on the row's
 * resolved region (falls back to the first configured region for system-level
 * logs without a request context). Console output is unconditional; DB writes
 * are best-effort and never crash the app.
 */
@Injectable()
export class DatabaseLoggerService implements LoggerService {
  private readonly nestLogger = new Logger(DatabaseLoggerService.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private resolveRegion(log: Log): string | null {
    const regions = this.knex.regions();
    if (log.region && regions.includes(log.region)) return log.region;
    return regions[0] ?? null;
  }

  private printToConsole(log: Log) {
    const idTag = `[ID: ${log.correlationId || 'N/A'}]`;
    const methodTag = log.method || 'SYS';
    const endpoint = log.endpoint || '';

    if (log.level === 'error') {
      this.nestLogger.error(`${idTag} ${methodTag} ${endpoint} -> ${log.errorMessage}`);
      if (log.trace) {
        const shortTrace = log.trace.split('\n').slice(0, 2).join('\n');
        this.nestLogger.error(shortTrace);
      }
    } else if (log.level === 'warn') {
      this.nestLogger.warn(`${idTag} ${log.action}`);
    } else {
      this.nestLogger.log(`${idTag} ${methodTag} ${endpoint}`);
    }
  }

  private async insertLogSafe(log: Log) {
    const region = this.resolveRegion(log);
    if (!region) return;
    try {
      const row = { ...log, region };
      await this.knex.db(region)('logs').insert(row);
    } catch (err) {
      // Swallow — the request itself must not fail because logging did.
      this.nestLogger.warn(
        `Failed to persist log to DB: ${(err as Error).message}`,
      );
    }
  }

  async log(log: Log) {
    log.level = 'log';
    this.printToConsole(log);
    await this.insertLogSafe(log);
  }

  async error(log: Log) {
    log.level = 'error';
    this.printToConsole(log);
    await this.insertLogSafe(log);
  }

  async warn(log: Log) {
    log.level = 'warn';
    this.printToConsole(log);
    await this.insertLogSafe(log);
  }

  async debug(log: Log) {
    log.level = 'debug';
    if (process.env.NODE_ENV !== 'production') {
      this.nestLogger.debug(log.action);
    }
    await this.insertLogSafe(log);
  }

  async verbose(log: Log) {
    log.level = 'verbose';
    await this.insertLogSafe(log);
  }
}
