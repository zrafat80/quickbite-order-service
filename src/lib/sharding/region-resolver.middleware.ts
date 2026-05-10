import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { isRegion } from './regions';

/**
 * Reads the sharding region from the `X-Region` request header **only**
 * (no path/query/cookie/JWT fallback per implementation-plan §0.3).
 * `"all"` is preserved here for admin fan-out reads — guards/routes that
 * require a concrete region must enforce that themselves.
 *
 * If the header is missing or unknown, `req.region` is left undefined; the
 * downstream consumer (route handler / service) decides whether that's an
 * error or a default. Phase 0 only resolves; it does not throw.
 */
@Injectable()
export class RegionResolverMiddleware implements NestMiddleware {
  private readonly regions: ReadonlyArray<string>;

  constructor(private readonly configService: ConfigService) {
    this.regions = this.configService.get<string[]>('regions') ?? [];
  }

  use(req: Request, _res: Response, next: NextFunction) {
    const raw = req.headers['x-region'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && (value === 'all' || isRegion(value, this.regions))) {
      req.region = value;
    }
    next();
  }
}
