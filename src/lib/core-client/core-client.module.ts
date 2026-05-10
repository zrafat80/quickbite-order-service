import { Global, Module } from '@nestjs/common';
import { CoreHttpClient } from './core.http-client';
import { PermissionClient } from './permission.client';
import { BranchClient } from './branch.client';
import { AddressClient } from './address.client';

@Global()
@Module({
  providers: [CoreHttpClient, PermissionClient, BranchClient, AddressClient],
  exports: [CoreHttpClient, PermissionClient, BranchClient, AddressClient],
})
export class CoreClientModule {}
