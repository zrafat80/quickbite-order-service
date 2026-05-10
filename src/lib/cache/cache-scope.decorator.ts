import { SetMetadata } from '@nestjs/common';

export const CacheScope = (scope: 'PUBLIC' | 'PRIVATE') =>
  SetMetadata('cache_scope', scope);
