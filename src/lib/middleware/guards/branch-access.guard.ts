import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GUARD_ERRORS } from './guard.constants';

@Injectable()
export class BranchAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;

    const branchIdStr = req.params.branchId || req.query.branchId;
    const branchId = parseInt(branchIdStr, 10);

    if (!branchId) return true;
    if (user?.role === 'system_admin') return true;
    if (user?.restaurantRole === 'owner') return true;

    const userBranchIds: number[] = user?.branchIds ?? [];
    if (!userBranchIds.includes(branchId)) {
      throw new ForbiddenException(GUARD_ERRORS.BRANCH_ACCESS_DENIED);
    }

    return true;
  }
}
