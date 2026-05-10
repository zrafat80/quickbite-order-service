import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GUARD_ERRORS } from './guard.constants';

@Injectable()
export class RestaurantMemberGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    const restaurantId = parseInt(req.params.restaurantId, 10);

    if (!restaurantId) return true;
    if (user?.role === 'system_admin') return true;

    if (Number(user?.restaurantId) !== restaurantId) {
      throw new ForbiddenException(GUARD_ERRORS.WORKSPACE_ACCESS_DENIED);
    }

    return true;
  }
}


