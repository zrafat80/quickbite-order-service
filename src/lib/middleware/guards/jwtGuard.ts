import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { GUARD_ERRORS } from './guard.constants';

/**
 * Reads `access_token` from the HTTP-only cookie and verifies it with
 * `jsonwebtoken`. The signing secret MUST match core-service so cross-issued
 * tokens verify here. Decoded payload is attached to `req.user`.
 *
 * No DB lookup, no AuthUtilsService — order-service does not own auth and
 * never issues tokens; it only consumes them.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.cookies?.access_token;

    if (!token) {
      throw new UnauthorizedException(GUARD_ERRORS.UNAUTHENTICATED);
    }

    const secret = this.configService.get<string>('jwt.accessSecret');
    if (!secret) {
      throw new UnauthorizedException(GUARD_ERRORS.TOKEN_EXPIRED);
    }

    try {
      const payload = jwt.verify(token, secret) as Record<string, unknown>;
      request.user = payload as Request['user'];
      return true;
    } catch {
      throw new UnauthorizedException(GUARD_ERRORS.TOKEN_EXPIRED);
    }
  }
}
