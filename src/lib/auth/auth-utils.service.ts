import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

export interface JwtPayload {
  userId: number;
  email: string;
  role: string;
  // for restaurant users only
  restaurantId?: number;
  restaurantRole?: string;
  branchIds?: number[];
}

/**
 * Verify-only counterpart of core-service's `AuthUtilsService`. order-service
 * never issues tokens — it only consumes tokens minted by core — so this
 * mirrors only the verify half of the API.
 */
@Injectable()
export class AuthUtilsService {
  constructor(private readonly configService: ConfigService) {}

  verifyAccessToken(token: string): JwtPayload {
    const secret = this.configService.get<string>('jwt.accessSecret');
    if (!secret) throw new UnauthorizedException();
    return jwt.verify(token, secret) as JwtPayload;
  }

  verifyRefreshToken(token: string): JwtPayload {
    const secret = this.configService.get<string>('jwt.refreshSecret');
    if (!secret) throw new UnauthorizedException();
    return jwt.verify(token, secret) as JwtPayload;
  }
}
